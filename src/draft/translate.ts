/**
 * Translating extracted document fields into OpenTax input nodes (P17).
 *
 * Pure: no database, no engine, no network. Everything here is decided from the node map and
 * the resolved field values, which is what makes it testable before a binary exists.
 *
 * The contract is that **an incomplete draft return is an enumerated fact, not a footnote**.
 * A draft computed from a source-document bundle can never be a return — a bundle cannot
 * know filing status, dependents, itemised deductions, basis, estimated payments or
 * prior-year carryovers. Those are emitted as omissions every time, so the thing downstream
 * renders is "what the documents support, and here is precisely what they do not".
 *
 * Four rules keep it on the right side of §5, §9 and §11:
 *
 *  1. **A blank is never a zero.** `null` reaching a calculation engine as `0` would destroy
 *     the distinction the whole app exists to preserve. A blank is left out; where the
 *     engine requires the field, the document is withheld rather than zero-filled.
 *  2. **A value a human has not accepted does not feed a computation.** A field flagged for
 *     review, or citing no span, withholds its document.
 *  3. **A judgment call is never made here.** A *populated* field the schema marks
 *     `judgmentRequired` withholds its document, and an `allJudgmentRequired` form type never
 *     reaches the engine at all. That is §9 applied per document by content — an SSA-1099
 *     always carries box 3, so it is always withheld, because the taxable portion of social
 *     security is not this app's to compute.
 *  4. **A negative amount is withheld.** Almost every money field in the engine's catalogue is
 *     declared non-negative; sending a negative would either be rejected or silently
 *     absolute-valued. Withholding is the honest direction.
 */
import type { FieldValue } from '../reconcile/checks.ts';
import type { FormSchema } from '../schemas/registry.ts';
import { formMapFor, type NodeMapFile, unmappableFor } from './nodes.ts';

export type DraftFieldValue = FieldValue & { needsReview?: boolean };

export interface DraftDocument {
  documentId: string;
  formType: string;
  /** The document's own detected year, which is not always the bundle's (§7). */
  taxYear: number;
  schema: FormSchema;
  fields: ReadonlyMap<string, DraftFieldValue>;
}

export type DraftOmissionReason =
  /** A populated field the schema marks as needing a preparer's judgment (§9). */
  | 'judgment_required'
  /** A form type reported as printed with no line dispersion — every K-1, SSA-1042S (§8). */
  | 'all_judgment_required'
  /** The node map declares this form type unmappable, with a reason. */
  | 'form_type_unmappable'
  /** Flagged for review, or corrected-but-unaccepted: not a value to compute from. */
  | 'needs_review'
  /** No span cites this value, so nothing ties it to pixels (§4, §6). */
  | 'no_spans'
  /** The engine requires the field and the box is blank. Never zero-filled (§5). */
  | 'engine_required_field_blank'
  /** Negative where the engine's catalogue declares the field non-negative. */
  | 'negative_amount'
  /** Something a source-document bundle cannot know. */
  | 'not_in_bundle'
  /**
   * The document's own tax year is not the bundle's. §6 flags this as a soft failure because
   * a prior-year 1098 or an off-year 5498 in the pile is a real preparer error — and feeding
   * one to a calculation engine would silently add last season's mortgage interest to this
   * season's return.
   */
  | 'off_year_document'
  /**
   * A figure the preparer supplied displaces one this app read off a document (P18).
   *
   * Not a defect and not an error — it is a preparer correcting or limiting what a form says,
   * which is their call to make. It is an omission because the document's figure was
   * deliberately not sent, and §14's contract is that every reason something was withheld is
   * enumerated. Without this the override would be the one thing in the whole design that
   * changes a draft's arithmetic without saying so.
   */
  | 'superseded_by_preparer';

export interface DraftOmission {
  documentId: string | null;
  formType: string | null;
  fieldKey: string | null;
  reason: DraftOmissionReason;
  detail: string;
}

export interface DraftNode {
  nodeType: string;
  /** Null for a node this app synthesises rather than reads off a page — `general`. */
  documentId: string | null;
  formType: string | null;
  payload: Record<string, unknown>;
}

/**
 * Values a reviewer states because no document in the bundle carries them. Supplying them is
 * the preparer making a determination, which is the right place for it — the app never
 * infers filing status from a pile of forms.
 */
export interface DraftParams {
  filingStatus?: string;
  taxpayerAge65OrOlder?: boolean;
  spouseAge65OrOlder?: boolean;
  taxpayerBlind?: boolean;
  spouseBlind?: boolean;
  dependentCount?: number;
  /** Dependents the preparer entered (P18). Empty is "none stated", not "none". */
  dependents?: readonly PreparerDependent[];
  /** Itemised deduction figures, keyed by the node map's `column`. Absent values stay absent. */
  scheduleA?: PreparerScheduleA | null;
  /** Businesses and rental properties, entered as summaries. */
  activities?: readonly PreparerActivity[];
}

/**
 * A dependent as the preparer stated them (P18).
 *
 * **No TIN, by construction.** The engine marks `ssn`/`itin`/`atin` optional on its dependents
 * node, so a draft computes without one, and §7's rule is that a taxpayer identification number
 * is never stored here and never forwarded. A dependent's is a TIN like any other.
 */
export interface PreparerDependent {
  firstName: string;
  lastName: string;
  middleInitial?: string | null;
  /** `YYYY-MM-DD`, as the engine's date fields want it. */
  dob: string;
  relationship: string;
  monthsInHome: number;
  /** Determinations the engine accepts and never makes. Null means "not stated" (§9). */
  qualifyingChildForCtc?: boolean | null;
  disabled?: boolean | null;
  fullTimeStudent?: boolean | null;
  taxpayerProvidedOverHalfSupport?: boolean | null;
  dependentOnAnotherReturn?: boolean | null;
  grossIncomeCents?: number | null;
}

/** Keyed by the node map's `column`; cents for money, booleans for the force flags. */
export type PreparerScheduleA = Record<string, number | boolean | null | undefined>;

/** One business or rental property, entered as a summary rather than line by line. */
export interface PreparerActivity {
  /** `schedule_c` | `schedule_e` — matches an entry in the node map's `activities`. */
  kind: string;
  description: string;
  activityCode?: string | null;
  accountingMethod?: string | null;
  materialParticipation?: boolean | null;
  propertyType?: string | null;
  fairRentalDays?: number | null;
  personalUseDays?: number | null;
  grossCents?: number | null;
  expensesCents?: number | null;
  expensesDescription?: string | null;
}

export interface DraftInput {
  taxYear: number;
  nodeMapVersion: string;
  engine: NodeMapFile['engine'];
  nodes: DraftNode[];
  omissions: DraftOmission[];
  /** False whenever anything at all was withheld. Never presented as a finished return. */
  complete: boolean;
  documentsIncluded: number;
  documentsWithheld: number;
}

/**
 * Inputs a 1040 needs that no W-2 or 1099 reports. Enumerated rather than described, so the
 * review surface can list them and the preparer can see the shape of what is missing.
 */
const NOT_IN_BUNDLE: readonly { key: string; detail: string }[] = [
  { key: 'filing_status', detail: 'Filing status is not printed on any source document.' },
  { key: 'dependents', detail: 'Dependents, their ages and their relationships are not on any source document.' },
  { key: 'itemised_deductions', detail: 'Schedule A items other than the 1098 interest and any state tax withheld in this bundle.' },
  { key: 'estimated_payments', detail: 'Estimated tax payments and any prior-year overpayment applied.' },
  { key: 'capital_basis', detail: 'Cost basis for noncovered securities, and wash-sale and corporate-action adjustments.' },
  { key: 'carryovers', detail: 'Prior-year carryovers — capital loss, passive loss, charitable, credit and NOL.' },
  { key: 'prior_year_agi', detail: 'Prior-year AGI and whether deductions were itemised, which a 1099-G box 2 refund depends on.' },
];

/**
 * Which document fields a preparer's figures displace (P18).
 *
 * Keyed `nodeType.nodeField`. A pair only counts when the preparer **actually supplied** the
 * schedule figure: an empty Schedule A line displaces nothing, and the document flows as it
 * always did.
 *
 * The reason this exists at all is measured behaviour, not theory. Where both a document and a
 * preparer feed the same engine line, engine 2.0.4 uses the document and discards the
 * preparer's silently — a 1098 of 40,000 beats a typed 55,000 with no diagnostic anywhere. So
 * the app sends one side, and `scripts/probe-conflicts.mjs` re-measures that on every engine
 * upgrade rather than assuming it still holds.
 */
function supersededByPreparer(
  file: NodeMapFile,
  scheduleA: PreparerScheduleA | null | undefined,
): Map<string, { scheduleField: string; formType: string; fieldKey: string }> {
  const out = new Map<string, { scheduleField: string; formType: string; fieldKey: string }>();
  if (!scheduleA || !file.preparerInputs) return out;
  for (const field of file.preparerInputs.scheduleA.fields) {
    const supplied = scheduleA[field.column];
    if (supplied === null || supplied === undefined) continue;
    for (const sup of field.supersedes) {
      out.set(`${sup.nodeType}.${sup.nodeField}`, {
        scheduleField: field.nodeField,
        formType: sup.formType,
        fieldKey: sup.fieldKey,
      });
    }
  }
  return out;
}

function isMoney(schema: FormSchema, fieldKey: string): boolean {
  return schema.fields.find((f) => f.key === fieldKey)?.type === 'money';
}

/** Cents to the dollars the engine's catalogue expects. */
function toDollars(cents: number): number {
  return cents / 100;
}

/**
 * The engine value for a field, or `undefined` when there is nothing to send. `undefined`
 * means "leave the key off the payload" and is never rendered as 0, '' or false.
 */
function engineValue(schema: FormSchema, fieldKey: string, value: DraftFieldValue): unknown {
  if (value.cents !== null) return isMoney(schema, fieldKey) ? toDollars(value.cents) : value.cents;
  if (value.bool !== null) return value.bool;
  if (value.text !== null && value.text.trim() !== '') return value.text.trim();
  return undefined;
}

/** Withhold the whole document, naming the field that caused it. */
function withhold(
  doc: DraftDocument,
  fieldKey: string | null,
  reason: DraftOmissionReason,
  detail: string,
): DraftOmission {
  return { documentId: doc.documentId, formType: doc.formType, fieldKey, reason, detail };
}

/** One terminating full stop, whatever the schema's own reason already ended with. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trimEnd()) ? text.trimEnd() : `${text.trimEnd()}.`;
}

function fieldLabel(schema: FormSchema, fieldKey: string): string {
  const field = schema.fields.find((f) => f.key === fieldKey);
  if (!field) return fieldKey;
  return field.box ? `box ${field.box} (${field.label})` : field.label;
}

/**
 * Every engine field name the `general` node can carry from here.
 *
 * Exported because these are the one set of field names that live in code rather than in the
 * node map — `general` holds what the *reviewer* states rather than what a document says, so
 * it is on no form's map. `src/draft/catalog.ts` reads this list to check them against the
 * engine's catalogue like any other, which matters because four of the five are **optional**
 * on the engine: rename one and it is accepted, ignored, and the extra standard deduction for
 * an elderly or blind taxpayer quietly disappears from the draft.
 *
 * Keep this in step with the payload built in `buildDraftInput`.
 */
export const GENERAL_NODE_FIELDS = [
  'filing_status',
  'taxpayer_age_65_or_older',
  'spouse_age_65_or_older',
  'taxpayer_blind',
  'spouse_blind',
] as const;

/**
 * Build the engine's input from a bundle's documents.
 *
 * Returns every node that can be sent and every reason something could not be, without
 * deciding anything. A caller that wants a draft return reads `complete` first.
 */
export function buildDraftInput(
  file: NodeMapFile,
  documents: readonly DraftDocument[],
  params: DraftParams = {},
): DraftInput {
  const nodes: DraftNode[] = [];
  const omissions: DraftOmission[] = [];
  let withheldCount = 0;

  // Which document fields the preparer's own figures displace, if any (P18).
  const superseded = supersededByPreparer(file, params.scheduleA);

  for (const doc of documents) {
    const unmappable = unmappableFor(file, doc.formType);
    if (unmappable) {
      withheldCount += 1;
      omissions.push(
        withhold(doc, null, 'form_type_unmappable', `${unmappable.reason}: ${unmappable.detail}`),
      );
      continue;
    }

    // Before reading a single box: a document from another season does not belong in this
    // return's arithmetic. The worksheet still reports it and annotates the mismatch (§6);
    // the engine must not quietly add it in.
    if (doc.taxYear !== file.taxYear) {
      withheldCount += 1;
      omissions.push(
        withhold(
          doc,
          null,
          'off_year_document',
          `This ${doc.formType} is for ${doc.taxYear} and the bundle is ${file.taxYear}. ` +
            'It is reported on the worksheet and annotated there, but it is not added to a ' +
            `${file.taxYear} computation.`,
        ),
      );
      continue;
    }

    if (doc.schema.allJudgmentRequired) {
      withheldCount += 1;
      omissions.push(
        withhold(
          doc,
          null,
          'all_judgment_required',
          `${doc.formType} is reported as printed; every field lands in Judgment Required (§8, §9).`,
        ),
      );
      continue;
    }

    const form = formMapFor(file, doc.formType);
    if (!form) {
      // Unreachable once the map has loaded — `assertConsistent` requires every registered
      // form type to be declared. Kept because a silent skip here is the exact failure mode
      // this module is built to prevent.
      withheldCount += 1;
      omissions.push(
        withhold(
          doc,
          null,
          'form_type_unmappable',
          `${doc.formType} is absent from the ${file.taxYear} node map.`,
        ),
      );
      continue;
    }

    // Any populated judgment field withholds the document, whether or not it is mapped:
    // the preparer has to characterise it before any of this document's numbers are computed.
    const judgment = doc.schema.fields.find(
      (f) => f.judgmentRequired && (doc.fields.get(f.key)?.present ?? false),
    );
    if (judgment) {
      withheldCount += 1;
      omissions.push(
        withhold(
          doc,
          judgment.key,
          'judgment_required',
          // The schema's own reason is a sentence and usually ends in a full stop of its
          // own, so only add one when it does not — `(§9)..` reads as a typo in the panel.
          sentence(
            `${fieldLabel(doc.schema, judgment.key)} needs a preparer's judgment` +
              `${judgment.judgmentReason ? `: ${judgment.judgmentReason}` : ''}`,
          ),
        ),
      );
      continue;
    }

    const payload: Record<string, unknown> = { ...form.constants };
    let blocked: DraftOmission | undefined;

    for (const map of form.fields) {
      const value = doc.fields.get(map.fieldKey);
      const label = fieldLabel(doc.schema, map.fieldKey);

      if (!value || !value.present) {
        // A checkbox nobody ticked is `false` — a fact on the page, not a zero invented for a
        // money box. The node map may only set this on a `bool` field (the loader enforces it).
        if (map.falseWhenBlank) {
          payload[map.nodeField] = false;
          continue;
        }
        if (map.engineRequired) {
          blocked = withhold(
            doc,
            map.fieldKey,
            'engine_required_field_blank',
            `The engine requires ${label} and the box is blank. A blank is not a zero (§5), ` +
              'so this document is withheld rather than zero-filled.',
          );
          break;
        }
        continue;
      }

      // Rule 2: an unreviewed or untraceable value does not feed a computation.
      if (value.needsReview === true) {
        blocked = withhold(doc, map.fieldKey, 'needs_review', `${label} is flagged for review.`);
        break;
      }
      if (value.spanIds.length === 0) {
        blocked = withhold(
          doc,
          map.fieldKey,
          'no_spans',
          `${label} cites no span, so nothing ties it to the page (§6).`,
        );
        break;
      }
      if (value.cents !== null && value.cents < 0) {
        blocked = withhold(
          doc,
          map.fieldKey,
          'negative_amount',
          `${label} is negative and the engine declares this field non-negative.`,
        );
        break;
      }

      // The preparer supplied a figure for the engine line this box feeds, so the box is left
      // off the payload and the fact is recorded. Sending both would mean the engine silently
      // using the document's and discarding theirs — measured, see `supersededByPreparer`.
      //
      // Note this does NOT withhold the document: only this one field. The 1098's other boxes
      // still flow, which is the difference between a surgical override and dropping a form.
      const supersedes = superseded.get(`${form.nodeType}.${map.nodeField}`);
      if (supersedes) {
        const shown = engineValue(doc.schema, map.fieldKey, value);
        const reports = typeof shown === 'number' ? shown.toFixed(2) : String(shown);

        // Whether one field can be dropped or the whole document has to go depends on the
        // engine, and the two cases are not alike:
        //
        //   W-2 box 17 is OPTIONAL on the engine's node, so leaving it off is clean and the
        //   wages and federal withholding on the same form still flow.
        //
        //   1098 box 1 is REQUIRED, and a node missing it is refused outright — which would
        //   silently take the rest of that 1098 with it. So the document is withheld
        //   deliberately and the omission says what that costs, rather than the engine
        //   rejecting it and the draft quietly being short a form.
        if (map.engineRequired) {
          blocked = withhold(
            doc,
            map.fieldKey,
            'superseded_by_preparer',
            `You supplied a figure for ${label} under itemised deductions, and the draft uses ` +
              `yours. The engine requires ${label} on a ${doc.formType}, so this ` +
              `document is left out of the computation entirely rather than sent without it — ` +
              `anything else it reports is not in the draft either. It reports ${reports}, and ` +
              'the worksheet still shows the document unchanged.',
          );
          break;
        }

        omissions.push({
          documentId: doc.documentId,
          formType: doc.formType,
          fieldKey: map.fieldKey,
          reason: 'superseded_by_preparer',
          detail:
            `${label} was not sent to the engine: you supplied a figure for it under itemised ` +
            `deductions, and that is what the draft uses. This ${doc.formType} reports ${reports}. ` +
            'The rest of the document is still computed, and the worksheet reports it unchanged.',
        });
        continue;
      }

      const engine = engineValue(doc.schema, map.fieldKey, value);
      if (engine !== undefined) payload[map.nodeField] = engine;
      else if (map.engineRequired) {
        blocked = withhold(
          doc,
          map.fieldKey,
          'engine_required_field_blank',
          `The engine requires ${label} and this app has no value for it.`,
        );
        break;
      }
    }

    if (blocked) {
      withheldCount += 1;
      omissions.push(blocked);
      continue;
    }

    for (const group of form.codeGroups) {
      const entries: { code: string; amount: number }[] = [];
      for (const pair of group.pairs) {
        const code = doc.fields.get(pair.code);
        const amount = doc.fields.get(pair.amount);
        const codeText = code?.text?.trim().toUpperCase();
        // A code with no amount, or an amount with no code, is half a fact. Reported as an
        // omission rather than sent as a guess.
        if (!codeText && (amount?.cents ?? null) === null) continue;
        if (!codeText || amount?.cents === null || amount?.cents === undefined) {
          omissions.push(
            withhold(
              doc,
              !codeText ? pair.code : pair.amount,
              'judgment_required',
              `${fieldLabel(doc.schema, pair.code)} and ${fieldLabel(doc.schema, pair.amount)} ` +
                'must both be read before the pair can be sent; one of them is blank.',
            ),
          );
          continue;
        }
        if (amount.cents < 0) {
          omissions.push(
            withhold(doc, pair.amount, 'negative_amount', `${fieldLabel(doc.schema, pair.amount)} is negative.`),
          );
          continue;
        }
        entries.push({ code: codeText, amount: toDollars(amount.cents) });
      }
      if (entries.length > 0) payload[group.nodeField] = entries;
    }

    for (const monthly of form.monthlyArrays) {
      // The engine wants a fixed twelve. A partially-read year cannot be padded with zeros —
      // that would report a month of no coverage as a month of no premium. The cents are
      // collected without a fallback so there is no place for a zero to creep in (§5).
      const cents: number[] = [];
      let blankMonth: string | undefined;
      for (const key of monthly.fieldKeys) {
        const value = doc.fields.get(key)?.cents ?? null;
        if (value === null) {
          blankMonth = key;
          break;
        }
        cents.push(value);
      }
      if (blankMonth !== undefined) {
        omissions.push(
          withhold(
            doc,
            blankMonth,
            'engine_required_field_blank',
            `${monthly.nodeField} needs all twelve months and ${fieldLabel(doc.schema, blankMonth)} ` +
              'is blank. Padding with zeros would report a month of no coverage as a month of no ' +
              'premium (§5).',
          ),
        );
        continue;
      }
      payload[monthly.nodeField] = cents.map(toDollars);
    }

    nodes.push({
      nodeType: form.nodeType,
      documentId: doc.documentId,
      formType: doc.formType,
      payload,
    });
  }

  // What the reviewer stated, and everything still unstated.
  //
  // The filing status is checked against the engine's own vocabulary before it is sent. The
  // codes are the engine's and change per release — 2.0.4 wants `mfj`, not
  // `married_filing_jointly` — and an unchecked value is refused at the `general` node, which
  // loses the standard deduction and the whole tax computation with it. Better a named
  // omission than a draft whose taxable income is silently its AGI.
  const general: Record<string, unknown> = {};
  const knownStatus =
    params.filingStatus !== undefined &&
    file.filingStatuses.some((f) => f.code === params.filingStatus);

  if (params.filingStatus !== undefined && !knownStatus) {
    omissions.push({
      documentId: null,
      formType: null,
      fieldKey: 'filing_status',
      reason: 'not_in_bundle',
      detail:
        `"${params.filingStatus}" is not a filing status this engine accepts. Expected one of: ` +
        `${file.filingStatuses.map((f) => f.code).join(', ')}.`,
    });
  }
  if (knownStatus) general['filing_status'] = params.filingStatus;
  if (params.taxpayerAge65OrOlder !== undefined) general['taxpayer_age_65_or_older'] = params.taxpayerAge65OrOlder;
  if (params.spouseAge65OrOlder !== undefined) general['spouse_age_65_or_older'] = params.spouseAge65OrOlder;
  if (params.taxpayerBlind !== undefined) general['taxpayer_blind'] = params.taxpayerBlind;
  if (params.spouseBlind !== undefined) general['spouse_blind'] = params.spouseBlind;
  // Dependents ride on the `general` node (P18). Nothing here is inferred: a dependent exists
  // because a preparer entered one, and every determination flag is sent only when stated.
  const inputs = file.preparerInputs;
  const statedDependents = params.dependents ?? [];
  if (inputs && statedDependents.length > 0) {
    general[inputs.dependents.nodeField] = statedDependents.map((d) => {
      const item: Record<string, unknown> = {};
      for (const map of inputs.dependents.fields) {
        const raw = (d as unknown as Record<string, unknown>)[map.column];
        if (raw === null || raw === undefined || raw === '') continue;
        item[map.nodeField] = map.money && typeof raw === 'number' ? toDollars(raw) : raw;
      }
      return item;
    });
  }

  if (general['filing_status'] !== undefined) {
    nodes.push({ nodeType: 'general', documentId: null, formType: null, payload: general });
  }

  // Itemised deductions, as stated. Only fields the preparer actually filled are sent: an
  // untouched line is absent from the payload, never a zero (§5).
  if (inputs && params.scheduleA) {
    const scheduleA: Record<string, unknown> = {};
    for (const map of [...inputs.scheduleA.fields, ...inputs.scheduleA.flags]) {
      const raw = params.scheduleA[map.column];
      if (raw === null || raw === undefined) continue;
      // Money is stored as cents and sent as dollars; the force flags are booleans and pass
      // straight through.
      scheduleA[map.nodeField] = map.money && typeof raw === 'number' ? toDollars(raw) : raw;
    }
    if (Object.keys(scheduleA).length > 0) {
      nodes.push({ nodeType: inputs.scheduleA.nodeType, documentId: null, formType: null, payload: scheduleA });
    }
  }

  // Businesses and rental properties, entered as summaries.
  for (const activity of params.activities ?? []) {
    const map = inputs?.activities.find((a) => a.kind === activity.kind);
    if (!map) {
      // An activity kind the node map does not carry. The only way to reach this is an engine
      // that cannot take it — Schedule F on 2.0.4 — so say which, rather than drop it.
      const unsupported = inputs?.unsupportedActivities.find((u) => u.kind === activity.kind);
      omissions.push({
        documentId: null,
        formType: null,
        fieldKey: activity.kind,
        reason: 'not_in_bundle',
        detail: unsupported
          ? `${unsupported.label} — "${activity.description}" is not in this draft. ${unsupported.detail}`
          : `"${activity.description}" is an activity of a kind this node map does not map (${activity.kind}).`,
      });
      continue;
    }

    const payload: Record<string, unknown> = { ...map.constants };
    let missingRequired: string | undefined;
    for (const field of map.fields) {
      const raw = (activity as unknown as Record<string, unknown>)[field.column];
      if (raw === null || raw === undefined || raw === '') {
        if (field.engineRequired) missingRequired ??= field.column;
        continue;
      }
      // Which fields convert is declared in the node map, not sniffed. `property_type` is a
      // number on the engine while a business code is a string of digits, so coercing anything
      // that looks numeric would quietly break the latter.
      if (field.money && typeof raw === 'number') payload[field.nodeField] = toDollars(raw);
      else if (field.numeric) payload[field.nodeField] = Number(raw);
      else payload[field.nodeField] = raw;
    }

    if (missingRequired !== undefined) {
      omissions.push({
        documentId: null,
        formType: null,
        fieldKey: missingRequired,
        reason: 'engine_required_field_blank',
        detail:
          `${map.label} — "${activity.description}" is not in this draft: the engine requires ` +
          `${missingRequired} and it has not been entered. It is left out rather than guessed at.`,
      });
      continue;
    }

    // The lump expense, where the node takes an array of {description, amount} rather than a
    // single number. Schedule C has a plain field; Schedule E does not.
    if (map.expenseArray && activity.expensesCents !== null && activity.expensesCents !== undefined) {
      payload[map.expenseArray] = [
        {
          description: activity.expensesDescription?.trim() || `Per ${map.label}`,
          amount: toDollars(activity.expensesCents),
        },
      ];
    }

    nodes.push({ nodeType: map.nodeType, documentId: null, formType: null, payload });
  }

  for (const missing of NOT_IN_BUNDLE) {
    if (missing.key === 'filing_status' && knownStatus) continue;
    if (missing.key === 'dependents' && (statedDependents.length > 0 || params.dependentCount === 0)) continue;
    // Itemised deductions stop being "not in the bundle" once a preparer has supplied them.
    if (missing.key === 'itemised_deductions' && params.scheduleA && Object.values(params.scheduleA).some((v) => v !== null && v !== undefined)) continue;
    omissions.push({
      documentId: null,
      formType: null,
      fieldKey: missing.key,
      reason: 'not_in_bundle',
      detail: missing.detail,
    });
  }

  return {
    taxYear: file.taxYear,
    nodeMapVersion: file.version,
    engine: file.engine,
    nodes,
    omissions,
    complete: omissions.length === 0,
    documentsIncluded: nodes.filter((n) => n.documentId !== null).length,
    documentsWithheld: withheldCount,
  };
}
