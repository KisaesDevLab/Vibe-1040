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
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadMapping } from '../mapping/engine.ts';
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
  /**
   * A node exists, and the engine requires an input this app will not send. Observed on
   * `f1099m` in engine 2.0.4, which demands the taxpayer's own `recipient_tin`: §7 forbids
   * forwarding a TIN anywhere, so the engine and this app disagree and §7 wins.
   */
  'engine_requires_withheld_input',
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
    /**
     * Send `false` when the app has no value, for a **checkbox only**.
     *
     * This is not a hole in §5, it is §5 read correctly. §5 is about money: a blank money box
     * is not a zero, and nothing may ever supply one. A checkbox is different — §5 itself says
     * an unchecked box "is `false` and has nothing on the page to cite", so it is stored blank
     * and is not a review item. Sending `false` for it reports a fact, not a guess.
     *
     * The loader refuses this flag on anything but a `bool` field, so it can never reach a
     * money field. Without it, a required checkbox like 1099-DIV box 11 would withhold every
     * document whose box is unticked — which is nearly all of them.
     */
    falseWhenBlank: z.boolean().default(false),
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

/** Why a worksheet line has no engine counterpart to sit beside. */
const notComparedReason = z.enum([
  /** Detail this app carries that has no 1040 line at all. */
  'informational_detail',
  /** The engine computes it internally and does not put it in `lines`. */
  'engine_does_not_surface_it',
  /** The engine takes it as an already-determined input, which §9 refuses to supply. */
  'engine_takes_it_as_a_determined_input',
  /** Judgment Required is not a line. */
  'not_a_line',
])

/**
 * Pairs a worksheet line with the engine output it should equal.
 *
 * Mapped by **meaning, not by line number** — the engine's keys carry names from whichever
 * season they were written in, and a number that has moved between revisions would silently
 * pair two different things.
 */
const comparableLine = z
  .object({
    lineRef: z.string(),
    engineForm: z.string(),
    engineLine: z.string(),
    /** Why a disagreement here may be expected rather than a defect. */
    note: z.string().optional(),
  })
  .strict();

/** An engine figure with no worksheet counterpart: displayed, never compared. */
const computedOnlyLine = z
  .object({
    engineForm: z.string(),
    engineLine: z.string(),
    label: z.string(),
    /**
     * Shown beside the figure when the engine's own output needs reading with care.
     *
     * Not a place to correct the engine — a draft return shows what the engine computed,
     * verbatim, or it is not a check on anything. It is for the case where a figure is
     * confident and, on its own, misleading: 2.0.4's `line12c_deduction_total` reports the
     * itemised total even when it is smaller than the standard deduction the same run applied
     * to taxable income, so the two lines do not reconcile on the face of the draft.
     */
    note: z.string().optional(),
  })
  .strict();

const lineMapSection = z
  .object({
    comparable: z.array(comparableLine).default([]),
    notCompared: z
      .array(z.object({ lineRef: z.string(), reason: notComparedReason }).strict())
      .default([]),
    computedOnly: z.array(computedOnlyLine).default([]),
  })
  .strict();

/**
 * The engine's filing-status vocabulary, which is the engine's and changes per release.
 *
 * Data rather than code because getting it wrong is silent until the engine rejects the
 * `general` node — 2.0.4 wants `single | mfs | mfj | hoh | qss`, and the long names this app
 * first used were refused on every draft.
 */
const filingStatus = z.object({ code: z.string().min(1), label: z.string().min(1) }).strict();

/**
 * What the preparer supplies, because no source document carries it (P18, §14).
 *
 * `supersedes` is the load-bearing part and the reason this is data rather than code. Some
 * engine fields can be fed from two directions — a document this app read, or a figure the
 * preparer typed — and engine 2.0.4 **silently discards the preparer's** where both arrive. So
 * the app sends one and records the other as an omission, and `scripts/probe-conflicts.mjs`
 * re-measures that behaviour on every engine upgrade rather than trusting it.
 */
const supersedes = z
  .object({
    /** The form a reviewer would recognise — `1098`, not `f1098`. */
    formType: z.string(),
    nodeType: z.string(),
    nodeField: z.string(),
    /** This app's own field key, so an omission can name the box on the page. */
    fieldKey: z.string(),
  })
  .strict();

const preparerField = z
  .object({
    /** The column on the draft-input table this comes from. */
    column: z.string(),
    nodeField: z.string(),
    engineRequired: z.boolean().default(false),
    /** Stored as integer cents here, sent as dollars at the boundary. */
    money: z.boolean().default(false),
    /**
     * Send as a number although this app stores it as text.
     *
     * Needed because the engine is not consistent: `schedule_e.property_type` is a number 1-8
     * while `schedule_c.line_b_business_code` is a string of digits. Coercing anything that
     * looks numeric would turn a business code into an integer and break it, so which fields
     * convert is stated rather than guessed.
     */
    numeric: z.boolean().default(false),
    supersedes: z.array(supersedes).default([]),
  })
  .strict();

const labelledCode = z.object({ code: z.string(), label: z.string(), note: z.string().optional() }).strict();

const activityMap = z
  .object({
    /** `schedule_c` | `schedule_e` — matches `draft_input_activities.kind`. */
    kind: z.string(),
    nodeType: z.string(),
    label: z.string(),
    $comment: z.array(z.string()).default([]),
    fields: z.array(preparerField).min(1),
    /** Where a lump expense goes when the node takes an array of {description, amount}. */
    expenseArray: z.string().optional(),
    constants: z.record(z.union([z.boolean(), z.string(), z.number()])).default({}),
    accountingMethods: z.array(labelledCode).default([]),
    propertyTypes: z.array(labelledCode).default([]),
  })
  .strict();

const preparerInputs = z
  .object({
    $comment: z.array(z.string()).default([]),
    dependents: z
      .object({
        nodeType: z.string(),
        nodeField: z.string(),
        $comment: z.array(z.string()).default([]),
        fields: z.array(preparerField).min(1),
        relationships: z.array(labelledCode).min(1),
      })
      .strict(),
    scheduleA: z
      .object({
        nodeType: z.string(),
        $comment: z.array(z.string()).default([]),
        fields: z.array(preparerField).min(1),
        flags: z.array(preparerField).default([]),
      })
      .strict(),
    activities: z.array(activityMap).default([]),
    /**
     * An activity the engine will not take. Listed rather than omitted from the file, so the
     * app can tell a preparer why instead of offering a control that produces a refused node.
     */
    unsupportedActivities: z
      .array(z.object({ kind: z.string(), label: z.string(), reason: z.string(), detail: z.string().min(1) }).strict())
      .default([]),
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
    lines: lineMapSection.default({ comparable: [], notCompared: [], computedOnly: [] }),
    filingStatuses: z.array(filingStatus).min(1),
    /** Optional so a season's map can be written before the inputs are mapped for it. */
    preparerInputs: preparerInputs.optional(),
  })
  .strict();

export type NodeMapFile = z.infer<typeof nodeMapFile>;
export type FormNodeMap = z.infer<typeof formMap>;
export type UnmappableForm = z.infer<typeof unmappableForm>;
export type IgnoreReason = z.infer<typeof ignoreReason>;
export type ComparableLine = z.infer<typeof comparableLine>;
export type ComputedOnlyLine = z.infer<typeof computedOnlyLine>;
export type NotComparedReason = z.infer<typeof notComparedReason>;
export type FilingStatusOption = z.infer<typeof filingStatus>;
export type PreparerInputs = z.infer<typeof preparerInputs>;
export type PreparerField = z.infer<typeof preparerField>;
export type ActivityMap = z.infer<typeof activityMap>;
export type SupersededField = z.infer<typeof supersedes>;
export type LabelledCode = z.infer<typeof labelledCode>;
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
  await assertConsistent(parsed, await registry());
  cache.set(taxYear, parsed);
  return parsed;
}

/**
 * Which tax years actually have a node map on disk, newest first.
 *
 * Exists because "the current year" is the wrong default for anything in this app and the
 * draft-return status route proved it: the calendar year is 2026 while the only map is 2025's,
 * so asking for `new Date().getFullYear()` returned no filing-status vocabulary and the panel
 * rendered a select with no options and a button that could never be pressed. A preparer works
 * last season's returns for most of a year; a tax year is never the wall-clock year by default.
 */
export async function nodeMapYears(root?: string): Promise<number[]> {
  const dir = root ?? join(process.cwd(), 'data', 'opentax-nodes');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => /^(\d{4})\.json$/.exec(n)?.[1])
    .filter((y): y is string => y !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
}

/**
 * The node map for `taxYear` if there is one, else the newest there is — and it says which.
 *
 * Deliberately not `loadNodeMap`'s behaviour. Translating a document against another season's
 * node map would be the §14 rule-6 mistake in a different costume, so the strict loader stays
 * strict and this exists only for the places that need the engine's *vocabulary* (its filing
 * statuses), which is a property of the engine release rather than of the tax year.
 */
export async function resolveNodeMap(
  taxYear: number,
  root?: string,
): Promise<{ file: NodeMapFile; year: number; substituted: boolean } | null> {
  const years = await nodeMapYears(root);
  const year = years.includes(taxYear) ? taxYear : years[0];
  if (year === undefined) return null;
  return { file: await loadNodeMap(year, root), year, substituted: year !== taxYear };
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
export async function assertConsistent(file: NodeMapFile, reg: FormRegistry): Promise<void> {
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
    if (schema) {
      for (const f of form.fields) {
        if (!f.falseWhenBlank) continue;
        const type = schema.fields.find((x) => x.key === f.fieldKey)?.type;
        if (type !== 'bool') {
          problems.push(
            `${form.formType}: ${f.fieldKey} is '${type}', not a checkbox, so falseWhenBlank ` +
              'must not be set on it. A blank money box is never a zero (§5).',
          );
        }
      }
    }
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

  const codes = file.filingStatuses.map((f) => f.code);
  if (new Set(codes).size !== codes.length) problems.push('a filing-status code is listed twice');

  // Every worksheet line is declared too, for the same reason every box is: a line quietly
  // absent from the comparison is a computed figure nobody checked.
  const mapping = await loadMapping(file.taxYear);
  const comparable = new Set(file.lines.comparable.map((l) => l.lineRef));
  const notCompared = new Set(file.lines.notCompared.map((l) => l.lineRef));

  for (const ref of comparable) {
    if (notCompared.has(ref)) problems.push(`line ${ref} is both compared and not compared`);
  }
  // The engine's line namespace is flat, so `engineLine` alone must be unique: two worksheet
  // lines pointing at one engine line would both claim the same figure.
  const engineTargets = new Set<string>();
  for (const line of file.lines.comparable) {
    if (engineTargets.has(line.engineLine)) {
      problems.push(`engine line ${line.engineLine} is compared against twice`);
    }
    engineTargets.add(line.engineLine);
  }
  const declaredRefs = new Set(mapping.lines.map((l) => l.ref));
  for (const ref of [...comparable, ...notCompared]) {
    if (!declaredRefs.has(ref)) {
      problems.push(`line ${ref} is in the node map but not in the ${file.taxYear} line mappings`);
    }
  }
  for (const ref of declaredRefs) {
    if (!comparable.has(ref) && !notCompared.has(ref)) {
      problems.push(
        `line ${ref} is neither compared against the engine nor declared notCompared with a ` +
          'reason. A line absent from the comparison is a figure nobody checked.',
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
