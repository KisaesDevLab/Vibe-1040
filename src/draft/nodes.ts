/**
 * OpenTax input-node map (P17).
 *
 * Binds this app's form types and field keys to the OpenTax engine's input-node catalogue.
 * Lives in `data/opentax-nodes/<year>.json` because it changes every season for the same
 * reason the 1040 line mappings do — a data change, not a code change (§10).
 *
 * The engine's field names are not derivable by convention. Its catalogue calls the first
 * money box `box1_wages` on `w2`, `box1` on `f1099int`, `box1_oid` on `f1099oid` and
 * `box_1_unemployment` on `f1099g`. Guessing would silently misfile amounts, so every pair
 * is written out and checked at load.
 *
 * Two load-time rules carry the weight:
 *  - **Every form type in the schema registry is declared**, either mapped or explicitly
 *    unmappable with a reason. A form type nobody thought about is the failure this file
 *    exists to prevent.
 *  - **Every field of a mapped form type is accounted for exactly once**, in `fields`,
 *    `codeGroups`, `monthlyArrays` or `ignored`. A box that quietly reaches no engine field
 *    is the same silent-omission class as a money field with no line mapping.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type FormRegistry, registry } from '../schemas/registry.ts';

/** Why a field of a mapped form type reaches no engine field. */
const ignoreReason = z.enum([
  /** A TIN is extracted for identity resolution and never persisted or forwarded (§7). */
  'tin_withheld',
  /** Names, account numbers, CORRECTED flags — carried by this app, not wanted by a node. */
  'identity_or_metadata',
  /** The engine's node has no field for this box. */
  'no_engine_field',
  /** The engine numbers this box differently from the form revision this app reads. */
  'engine_box_numbering_differs',
]);

/** Why a whole form type reaches no engine node. */
const unmappableReason = z.enum([
  /** The engine has no input node for this form. */
  'no_engine_node',
  /** A node exists but wants a shape this app deliberately does not extract. */
  'engine_shape_mismatch',
  /** A node exists and is deliberately not used, because §8/§9 keeps the form as printed. */
  'policy_boxes_as_printed',
  /** A consolidated package; its sub-forms are separate documents. */
  'container',
]);

const fieldMap = z
  .object({
    fieldKey: z.string(),
    nodeField: z.string(),
    /**
     * The engine's schema requires this field. When the app's value is blank the document
     * cannot be emitted at all — it is never zero-filled to satisfy a required field (§5).
     */
    engineRequired: z.boolean().default(false),
  })
  .strict();

/** A run of code/amount pairs collapsed into one engine array — W-2 box 12. */
const codeGroup = z
  .object({
    nodeField: z.string(),
    pairs: z
      .array(z.object({ code: z.string(), amount: z.string() }).strict())
      .min(1),
  })
  .strict();

/** Twelve monthly boxes collapsed into one fixed-length engine array — 1095-A. */
const monthlyArray = z
  .object({
    nodeField: z.string(),
    fieldKeys: z.array(z.string()).length(12),
  })
  .strict();

const formMap = z
  .object({
    formType: z.string(),
    nodeType: z.string(),
    /** Values the binding itself implies, not read off the page — RRB-1099's `is_rrb`. */
    constants: z.record(z.union([z.boolean(), z.string(), z.number()])).default({}),
    fields: z.array(fieldMap).default([]),
    codeGroups: z.array(codeGroup).default([]),
    monthlyArrays: z.array(monthlyArray).default([]),
    ignored: z.array(z.object({ fieldKey: z.string(), reason: ignoreReason }).strict()).default([]),
  })
  .strict();

const unmappableForm = z
  .object({
    formType: z.string(),
    reason: unmappableReason,
    detail: z.string().min(1),
  })
  .strict();

const nodeMapFile = z
  .object({
    taxYear: z.number().int(),
    version: z.string(),
    engine: z
      .object({ name: z.string(), formType: z.string(), pinnedVersion: z.string() })
      .strict(),
    notes: z.array(z.string()).default([]),
    forms: z.array(formMap).min(1),
    unmappable: z.array(unmappableForm).default([]),
  })
  .strict();

export type NodeMapFile = z.infer<typeof nodeMapFile>;
export type FormNodeMap = z.infer<typeof formMap>;
export type UnmappableForm = z.infer<typeof unmappableForm>;
export type IgnoreReason = z.infer<typeof ignoreReason>;
export type UnmappableReason = z.infer<typeof unmappableReason>;

const cache = new Map<number, NodeMapFile>();

export async function loadNodeMap(taxYear: number, root?: string): Promise<NodeMapFile> {
  const cached = cache.get(taxYear);
  if (cached) return cached;

  const dir = root ?? join(process.cwd(), 'data', 'opentax-nodes');
  let raw: string;
  try {
    raw = await readFile(join(dir, `${taxYear}.json`), 'utf8');
  } catch {
    throw new Error(
      `no OpenTax node map for tax year ${taxYear}. Add data/opentax-nodes/${taxYear}.json — ` +
        'adding a tax year is a data change, not a code change (PHASES.md P17).',
    );
  }

  const parsed = nodeMapFile.parse(JSON.parse(raw));
  assertConsistent(parsed, await registry());
  cache.set(taxYear, parsed);
  return parsed;
}

/** Test seam, mirroring `__setMapping` in the line-mapping engine. */
export function __setNodeMap(file: NodeMapFile): void {
  cache.set(file.taxYear, file);
}

export function __clearNodeMapCache(): void {
  cache.clear();
}

/**
 * Structural checks that must hold before any document is translated. Thrown at load so a
 * malformed map fails on startup rather than halfway through a bundle.
 */
export function assertConsistent(file: NodeMapFile, reg: FormRegistry): void {
  const problems: string[] = [];

  const mapped = new Set(file.forms.map((f) => f.formType));
  const unmappable = new Set(file.unmappable.map((u) => u.formType));

  if (mapped.size !== file.forms.length) problems.push('a form type is mapped twice');
  if (unmappable.size !== file.unmappable.length) {
    problems.push('a form type is declared unmappable twice');
  }
  for (const formType of mapped) {
    if (unmappable.has(formType)) {
      problems.push(`${formType} is both mapped and declared unmappable`);
    }
  }

  for (const form of file.forms) {
    // One engine field per source, or two boxes would race for the same slot.
    const nodeFields = new Set<string>();
    const claim = (nodeField: string): void => {
      if (nodeFields.has(nodeField)) {
        problems.push(`${form.formType}: engine field ${nodeField} is targeted twice`);
      }
      nodeFields.add(nodeField);
    };
    for (const f of form.fields) claim(f.nodeField);
    for (const g of form.codeGroups) claim(g.nodeField);
    for (const a of form.monthlyArrays) claim(a.nodeField);
    for (const key of Object.keys(form.constants)) claim(key);

    // Every field key referenced once, and only once.
    const seen = new Map<string, number>();
    const mark = (key: string): void => {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    };
    for (const f of form.fields) mark(f.fieldKey);
    for (const g of form.codeGroups) for (const p of g.pairs) { mark(p.code); mark(p.amount); }
    for (const a of form.monthlyArrays) for (const k of a.fieldKeys) mark(k);
    for (const i of form.ignored) mark(i.fieldKey);
    for (const [key, count] of seen) {
      if (count > 1) problems.push(`${form.formType}: field ${key} is referenced ${count} times`);
    }

    // And it must be a field the form actually has, covering every field the form has.
    const schema = reg.get(form.formType, file.taxYear);
    if (!schema) {
      problems.push(`${form.formType}: no registered schema for tax year ${file.taxYear}`);
      continue;
    }
    const schemaKeys = new Set(schema.fields.map((f) => f.key));
    for (const key of seen.keys()) {
      if (!schemaKeys.has(key)) problems.push(`${form.formType}: field ${key} is not on the schema`);
    }
    for (const key of schemaKeys) {
      if (!seen.has(key)) {
        problems.push(
          `${form.formType}: field ${key} is neither mapped nor ignored. Every box must be ` +
            'accounted for — a box that reaches no engine field silently drops an amount.',
        );
      }
    }
  }

  // Every registered form type has to have been thought about.
  for (const formType of reg.formTypes(file.taxYear)) {
    if (!mapped.has(formType) && !unmappable.has(formType)) {
      problems.push(
        `${formType} is registered as a form type but is absent from the node map. Add it to ` +
          '`forms` or to `unmappable` with a reason.',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`OpenTax node map ${file.taxYear} is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

export function formMapFor(file: NodeMapFile, formType: string): FormNodeMap | undefined {
  return file.forms.find((f) => f.formType === formType);
}

export function unmappableFor(file: NodeMapFile, formType: string): UnmappableForm | undefined {
  return file.unmappable.find((u) => u.formType === formType);
}
