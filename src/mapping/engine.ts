/**
 * 1040 line mapping engine (P10).
 *
 * Rolls per-document field values up to per-line totals, retaining every contributing
 * document reference so a worksheet number can be clicked back to source pixels.
 *
 * Three rules do the real work:
 *  - A line total is the sum of its **non-null** contributors, and the null count is
 *    reported separately rather than folded in as zero (§5).
 *  - Anything that would require deciding a characterization question routes to
 *    **Judgment Required** instead of being guessed at (§9, §11).
 *  - A populated money field with no mapping is *not* silently dropped; it lands in
 *    Judgment Required as unmapped, because a quietly missing number is the one failure
 *    mode this tool exists to prevent.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { sumNonNull } from '../lib/money.ts';
import type { FieldValue } from '../reconcile/checks.ts';
import type { FormSchema } from '../schemas/registry.ts';

const lineDef = z
  .object({
    ref: z.string(),
    label: z.string(),
    sortOrder: z.number().int(),
    /** Derived from other lines rather than from documents. */
    computed: z.array(z.string()).optional(),
    /** The app reports the inputs but does not compute this line (§2). */
    notComputed: z.boolean().default(false),
    notComputedReason: z.string().optional(),
    judgment: z.boolean().default(false),
  })
  .strict();

const mappingDef = z
  .object({
    formType: z.string(),
    fieldKey: z.string(),
    lineRef: z.string(),
    /** Routes here only when another field on the same document has a given value. */
    condition: z.object({ fieldKey: z.string(), equals: z.union([z.boolean(), z.string(), z.number()]) }).optional(),
    /** Shown on the worksheet but excluded from the line total. */
    informationalOnly: z.boolean().default(false),
    /** Additional line to list the contribution under, for payer-detail schedules. */
    alsoDetail: z.string().optional(),
    judgmentReason: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const mappingFile = z
  .object({
    taxYear: z.number().int(),
    version: z.string(),
    notes: z.array(z.string()).default([]),
    lines: z.array(lineDef).min(1),
    mappings: z.array(mappingDef),
  })
  .strict();

export type MappingFile = z.infer<typeof mappingFile>;
export type LineDef = z.infer<typeof lineDef>;

export const JUDGMENT_LINE = 'JUDGMENT';

export interface MappedDocument {
  documentId: string;
  formType: string;
  taxYear: number;
  schema: FormSchema;
  fields: Map<string, FieldValue>;
  /** True when a human corrected any field on this document (P12 correction indicators). */
  correctedFieldKeys?: Set<string>;
}

export interface Contribution {
  documentId: string;
  formType: string;
  fieldKey: string;
  fieldLabel: string;
  valueCents: number | null;
  informational: boolean;
  wasCorrected: boolean;
  judgmentReason?: string;
}

export interface WorksheetLine {
  lineRef: string;
  label: string;
  sortOrder: number;
  totalCents: number | null;
  contributorCount: number;
  nullContributorCount: number;
  isJudgmentRequired: boolean;
  notComputed: boolean;
  notComputedReason?: string;
  contributions: Contribution[];
}

export interface WorksheetModel {
  taxYear: number;
  mappingVersion: string;
  lines: WorksheetLine[];
}

const cache = new Map<number, MappingFile>();

export async function loadMapping(taxYear: number, root?: string): Promise<MappingFile> {
  const cached = cache.get(taxYear);
  if (cached) return cached;
  const dir = root ?? join(process.cwd(), 'data', 'line-mappings');
  let raw: string;
  try {
    raw = await readFile(join(dir, `${taxYear}.json`), 'utf8');
  } catch {
    throw new Error(
      `no line mapping for tax year ${taxYear}. Add data/line-mappings/${taxYear}.json — ` +
        'adding a tax year is a data change, not a code change (PHASES.md P10).',
    );
  }
  const parsed = mappingFile.parse(JSON.parse(raw));
  cache.set(taxYear, parsed);
  return parsed;
}

/** Test seam. */
export function __setMapping(file: MappingFile): void {
  cache.set(file.taxYear, file);
}

function conditionHolds(doc: MappedDocument, condition: NonNullable<z.infer<typeof mappingDef>['condition']>): boolean {
  const field = doc.fields.get(condition.fieldKey);
  if (!field) return condition.equals === false;
  if (typeof condition.equals === 'boolean') {
    // A blank checkbox reads as false — an unchecked IRA/SEP/SIMPLE box means "not an IRA",
    // which is the whole point of the 4a/5a split.
    return (field.bool ?? false) === condition.equals;
  }
  if (typeof condition.equals === 'string') return field.text === condition.equals;
  return field.cents === condition.equals;
}

export async function buildWorksheetModel(
  taxYear: number,
  documents: readonly MappedDocument[],
  root?: string,
): Promise<WorksheetModel> {
  const file = await loadMapping(taxYear, root);
  const byRef = new Map(file.lines.map((l) => [l.ref, l]));
  const contributions = new Map<string, Contribution[]>();

  const push = (lineRef: string, contribution: Contribution): void => {
    if (!byRef.has(lineRef)) {
      throw new Error(`mapping references unknown line '${lineRef}' for ${contribution.formType}`);
    }
    const list = contributions.get(lineRef) ?? [];
    list.push(contribution);
    contributions.set(lineRef, list);
  };

  for (const doc of documents) {
    const applicable = file.mappings.filter((m) => m.formType === doc.formType);
    const mappedKeys = new Set(applicable.map((m) => m.fieldKey));

    for (const field of doc.schema.fields) {
      const value = doc.fields.get(field.key);
      // No row at all means the field was never extracted — nothing to say about it.
      if (!value) continue;
      // Identity fields are consumed by identity resolution and never persisted (§7);
      // they have no place on a worksheet.
      if (field.sensitive === 'tin') continue;

      /**
       * A blank box on an extracted document is still a *contributor* — it is counted in
       * `nullContributorCount` so the worksheet can say "three documents fed this line,
       * one of them had an empty box" (§5). Dropping it here is what made the line look
       * like it had two clean contributors instead of three with a gap, which is exactly
       * the omission this tool exists to surface.
       *
       * Blanks contribute only to lines they actually map to. They do not go to Judgment
       * Required, because an empty box is not a characterization question.
       */
      if (!value.present) {
        const blankMatches = applicable.filter(
          (m) =>
            m.fieldKey === field.key &&
            !m.informationalOnly &&
            m.lineRef !== JUDGMENT_LINE &&
            (!m.condition || conditionHolds(doc, m.condition)),
        );
        for (const match of blankMatches) {
          push(match.lineRef, {
            documentId: doc.documentId,
            formType: doc.formType,
            fieldKey: field.key,
            fieldLabel: field.label,
            valueCents: null,
            informational: false,
            wasCorrected: doc.correctedFieldKeys?.has(field.key) ?? false,
          });
        }
        continue;
      }

      const base: Omit<Contribution, 'informational' | 'judgmentReason'> = {
        documentId: doc.documentId,
        formType: doc.formType,
        fieldKey: field.key,
        fieldLabel: field.label,
        valueCents: value.cents,
        wasCorrected: doc.correctedFieldKeys?.has(field.key) ?? false,
      };

      // Everything on a K-1 lands in Judgment Required in v1 (§8, §9).
      if (doc.schema.allJudgmentRequired) {
        push(JUDGMENT_LINE, {
          ...base,
          informational: false,
          judgmentReason: `${doc.formType}: boxes as printed only; no line dispersion in v1 (§8).`,
        });
        continue;
      }

      // A field the schema itself flags as a judgment call never reaches a numbered line.
      if (field.judgmentRequired) {
        push(JUDGMENT_LINE, {
          ...base,
          informational: false,
          judgmentReason: field.judgmentReason ?? 'Requires preparer judgment (§9).',
        });
        continue;
      }

      const matches = applicable.filter(
        (m) => m.fieldKey === field.key && (!m.condition || conditionHolds(doc, m.condition)),
      );

      if (matches.length === 0) {
        if (!mappedKeys.has(field.key) && field.type === 'money') {
          // Unmapped but populated. Surface it rather than dropping it.
          push(JUDGMENT_LINE, {
            ...base,
            informational: false,
            judgmentReason: `No ${taxYear} line mapping for ${doc.formType} ${field.key}.`,
          });
        }
        continue;
      }

      for (const match of matches) {
        push(match.lineRef, {
          ...base,
          informational: match.informationalOnly,
          ...(match.judgmentReason ? { judgmentReason: match.judgmentReason } : {}),
        });
        if (match.alsoDetail) {
          push(match.alsoDetail, { ...base, informational: true });
        }
      }
    }
  }

  // Per-line totals from document contributions.
  const lines = new Map<string, WorksheetLine>();
  for (const def of file.lines) {
    const contribs = contributions.get(def.ref) ?? [];
    const counted = contribs.filter((c) => !c.informational);
    const { total, contributorCount, nullCount } = sumNonNull(counted.map((c) => c.valueCents));
    lines.set(def.ref, {
      lineRef: def.ref,
      label: def.label,
      sortOrder: def.sortOrder,
      totalCents: def.computed ? null : total,
      contributorCount,
      nullContributorCount: nullCount,
      isJudgmentRequired: def.judgment,
      notComputed: def.notComputed,
      ...(def.notComputedReason ? { notComputedReason: def.notComputedReason } : {}),
      contributions: contribs,
    });
  }

  // Derived lines, in sortOrder so a computed line can depend on an earlier computed line
  // (Schedule 1-A total → 1040 line 13b).
  for (const def of [...file.lines].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!def.computed) continue;
    const parts = def.computed.map((ref) => lines.get(ref)?.totalCents ?? null);
    const { total, nullCount } = sumNonNull(parts);
    const line = lines.get(def.ref)!;
    line.totalCents = total;
    line.nullContributorCount = nullCount;
    line.contributorCount = def.computed.length;
  }

  return {
    taxYear,
    mappingVersion: file.version,
    lines: [...lines.values()].sort((a, b) => a.sortOrder - b.sortOrder),
  };
}
