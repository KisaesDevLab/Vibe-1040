/**
 * Review model for the Excel workbook (P12, added 2026-09-16).
 *
 * The 1040-line worksheet answers "what does the return total to". A tax manager also has
 * to answer two prior questions before trusting those totals: was every source document
 * captured, and was every box on each document read correctly? This model carries what
 * those questions need — every document, every schema field with its read value and its
 * review state, every arithmetic check with its disposition, and where each value came from
 * — so the workbook can lay a form out box by box next to the number that came off it.
 *
 * Pure data. `loadReviewModel` reads the database; the renderer in `xlsx.ts` takes the
 * model and touches nothing else, which is what makes the recap sheets unit-testable.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  bundleTaxpayers,
  checkResults,
  dispositions,
  documents,
  extractedFields,
  pages,
  sourceFiles,
  taxpayers,
  users,
} from '../db/schema.ts';
import { resolveDocumentFields } from '../extract/resolve.ts';
import { loadMapping } from '../mapping/engine.ts';
import { APP_VERSION } from '../router/client.ts';
import { registry } from '../schemas/registry.ts';
import type { FieldType } from '../schemas/registry.ts';
import { sortDocuments } from './form-order.ts';

export interface ReviewField {
  fieldKey: string;
  box: string | null;
  label: string;
  type: FieldType;
  cents: number | null;
  text: string | null;
  bool: boolean | null;
  /** The document carries a value for this field (a printed zero counts; a blank does not). */
  present: boolean;
  /** The field was read at all — false when the binder never returned it. */
  read: boolean;
  needsReview: boolean;
  reviewReason: string | null;
  disagreed: boolean;
  wasCorrected: boolean;
  original: { cents: number | null; text: string | null; bool: boolean | null };
  spanCount: number;
  judgmentRequired: boolean;
  judgmentReason: string | null;
  /** Form 1040 / schedule line references this field feeds, per the mapping table. */
  lineRefs: string[];
}

export interface ReviewCheck {
  checkKey: string;
  severity: 'hard' | 'soft';
  outcome: 'pass' | 'fail' | 'not_applicable';
  message: string;
  expectedCents: number | null;
  actualCents: number | null;
  toleranceCents: number | null;
  disposition: { kind: string; note: string; by: string; at: Date } | null;
}

export interface ReviewPage {
  filename: string;
  pageNumber: number;
  layoutSource: string | null;
  spanCount: number | null;
  route: string | null;
}

export interface ReviewDocument {
  documentId: string;
  formType: string | null;
  schemaVersion: string | null;
  payerName: string | null;
  taxpayerLabel: string | null;
  taxYear: number | null;
  taxYearMismatch: boolean;
  sectionCode: string | null;
  corrected: boolean;
  void: boolean;
  isSupplemental: boolean;
  isSummary: boolean;
  unrecognisedForm: boolean;
  parentDocumentId: string | null;
  extractionOutcome: string | null;
  pages: ReviewPage[];
  /** Every schema field in schema order, read or not. Empty for a document with no schema. */
  fields: ReviewField[];
  checks: ReviewCheck[];
  provenance: {
    classifierModel: string | null;
    extractionModel: string | null;
    passCount: number | null;
  };
}

export interface ReviewModel {
  taxYear: number;
  appVersion: string;
  documents: ReviewDocument[];
  /** Checks with no document — the cross-employer social security check, for one. */
  bundleChecks: ReviewCheck[];
}

/** Short label for a document: form, issuer, section. Used as a column header. */
export function documentTitle(doc: ReviewDocument): string {
  const parts = [doc.formType ?? 'unclassified'];
  if (doc.sectionCode) parts.push(`section ${doc.sectionCode}`);
  if (doc.payerName) parts.push(doc.payerName);
  if (doc.corrected) parts.push('[CORRECTED]');
  if (doc.void) parts.push('[VOID]');
  return parts.join(' — ');
}

export function pagesLabel(doc: ReviewDocument): string {
  if (!doc.pages.length) return '';
  const byFile = new Map<string, number[]>();
  for (const p of doc.pages) byFile.set(p.filename, [...(byFile.get(p.filename) ?? []), p.pageNumber]);
  return [...byFile.entries()].map(([file, nums]) => `${file} p.${nums.sort((a, b) => a - b).join(',')}`).join('; ');
}

export async function loadReviewModel(bundleId: string, taxYear: number): Promise<ReviewModel> {
  const forms = await registry();
  const mapping = await loadMapping(taxYear);

  const docRows = sortDocuments(
    await db.select().from(documents).where(eq(documents.bundleId, bundleId)).orderBy(asc(documents.createdAt)),
  );

  const pageRows = await db
    .select({
      documentId: pages.documentId,
      pageNumber: pages.pageNumber,
      layoutSource: pages.layoutSource,
      spanCount: pages.spanCount,
      route: pages.route,
      filename: sourceFiles.filename,
    })
    .from(pages)
    .innerJoin(sourceFiles, eq(sourceFiles.id, pages.sourceFileId))
    .where(eq(pages.bundleId, bundleId))
    .orderBy(asc(sourceFiles.filename), asc(pages.pageNumber));

  const checkRows = await db.select().from(checkResults).where(eq(checkResults.bundleId, bundleId));
  const decided = checkRows.length
    ? await db
        .select({
          checkResultId: dispositions.checkResultId,
          kind: dispositions.kind,
          note: dispositions.note,
          at: dispositions.createdAt,
          by: users.displayName,
        })
        .from(dispositions)
        .innerJoin(users, eq(users.id, dispositions.dispositionedBy))
        .where(inArray(dispositions.checkResultId, checkRows.map((c) => c.id)))
    : [];
  const decidedById = new Map(decided.map((d) => [d.checkResultId, d]));

  const toCheck = (c: (typeof checkRows)[number]): ReviewCheck => {
    const d = decidedById.get(c.id);
    return {
      checkKey: c.checkKey,
      severity: c.severity,
      outcome: c.outcome,
      message: c.message,
      expectedCents: c.expectedCents,
      actualCents: c.actualCents,
      toleranceCents: c.toleranceCents,
      disposition: d ? { kind: d.kind, note: d.note, by: d.by, at: d.at } : null,
    };
  };

  const people = await db
    .select({ id: taxpayers.id, displayName: taxpayers.displayName, tinLast4: taxpayers.tinLast4 })
    .from(bundleTaxpayers)
    .innerJoin(taxpayers, eq(taxpayers.id, bundleTaxpayers.taxpayerId))
    .where(eq(bundleTaxpayers.bundleId, bundleId));
  const personLabel = new Map(people.map((p) => [p.id, `${p.displayName ?? 'unnamed'} (…${p.tinLast4})`]));

  const lineRefsFor = (formType: string, fieldKey: string): string[] => {
    const refs = mapping.mappings
      .filter((m) => m.formType === formType && m.fieldKey === fieldKey)
      .map((m) => m.lineRef);
    return [...new Set(refs)];
  };

  const out: ReviewDocument[] = [];
  for (const doc of docRows) {
    const resolvedSchema = doc.formType ? forms.resolve(doc.formType, doc.taxYear ?? taxYear) : undefined;
    const resolved = await resolveDocumentFields(doc.id);
    const raw = await db
      .select({
        fieldKey: extractedFields.fieldKey,
        producedByModel: extractedFields.producedByModel,
        passCount: extractedFields.passCount,
      })
      .from(extractedFields)
      .where(eq(extractedFields.documentId, doc.id));

    const fields: ReviewField[] = [];
    if (resolvedSchema) {
      for (const f of resolvedSchema.schema.fields) {
        if (f.sensitive === 'tin') continue; // never on a worksheet (§7)
        const v = resolved.fields.get(f.key);
        fields.push({
          fieldKey: f.key,
          box: f.box ?? null,
          label: f.label,
          type: f.type,
          cents: v?.cents ?? null,
          text: v?.text ?? null,
          bool: v?.bool ?? null,
          present: v?.present ?? false,
          read: v !== undefined,
          needsReview: v?.needsReview ?? false,
          reviewReason: v?.reviewReason ?? null,
          disagreed: v?.disagreed ?? false,
          wasCorrected: v?.wasCorrected ?? false,
          original: v?.original ?? { cents: null, text: null, bool: null },
          spanCount: v?.spanIds.length ?? 0,
          judgmentRequired: f.judgmentRequired || resolvedSchema.schema.allJudgmentRequired,
          judgmentReason: f.judgmentReason ?? null,
          lineRefs: doc.formType ? lineRefsFor(doc.formType, f.key) : [],
        });
      }
    }

    out.push({
      documentId: doc.id,
      formType: doc.formType,
      schemaVersion: doc.formSchemaVersion,
      payerName: doc.payerName,
      taxpayerLabel: doc.taxpayerId ? (personLabel.get(doc.taxpayerId) ?? null) : null,
      taxYear: doc.taxYear,
      taxYearMismatch: doc.taxYearMismatch,
      sectionCode: doc.sectionCode,
      corrected: doc.corrected,
      void: doc.void,
      isSupplemental: doc.isSupplemental,
      isSummary: doc.isSummary,
      unrecognisedForm: doc.unrecognisedForm,
      parentDocumentId: doc.parentDocumentId,
      extractionOutcome: doc.extractionOutcome,
      pages: pageRows
        .filter((p) => p.documentId === doc.id)
        .map((p) => ({
          filename: p.filename,
          pageNumber: p.pageNumber,
          layoutSource: p.layoutSource,
          spanCount: p.spanCount,
          route: p.route,
        })),
      fields,
      checks: checkRows.filter((c) => c.documentId === doc.id).map(toCheck),
      provenance: {
        classifierModel: doc.classifierModel,
        extractionModel: raw[0]?.producedByModel ?? null,
        passCount: raw[0]?.passCount ?? null,
      },
    });
  }

  return {
    taxYear,
    appVersion: APP_VERSION,
    documents: out,
    bundleChecks: checkRows.filter((c) => c.documentId === null).map(toCheck),
  };
}

/** Test seam: a model with no database behind it. */
export function reviewModelFrom(parts: Partial<ReviewModel> & { taxYear: number }): ReviewModel {
  return { appVersion: APP_VERSION, documents: [], bundleChecks: [], ...parts };
}

// keep the `and` import meaningful for drizzle tree-shaking in strict builds
void and;
