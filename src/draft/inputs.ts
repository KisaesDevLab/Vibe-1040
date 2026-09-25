/**
 * Reading and writing what the preparer supplies (P18, CLAUDE.md §14).
 *
 * §14 rule 5 already routes filing status and the age/blindness flags through the reviewer,
 * because no source document carries them and inferring one from a pile of forms would be the
 * app making a determination. This module is the same arrangement for dependents, itemised
 * deductions and business/rental summaries — persisted rather than passed per request, so a
 * preparer does not retype a Schedule C every time a draft is recomputed.
 *
 * Two rules run through everything here:
 *
 *  1. **A blank is not a zero (§5).** Every money value is nullable end to end. A field the
 *     preparer never touched reaches the engine as absent; there is no place in this module
 *     where a missing value becomes `0`.
 *  2. **Nothing is inferred (§9, §11).** A determination — whether a child qualifies for the
 *     credit, whether a business is materially participated in, whether to force itemising —
 *     is null until a person says otherwise. "Not stated" and "stated as no" are different
 *     answers and only a preparer may give either.
 *
 * There is deliberately **no TIN anywhere**, including for dependents (§7).
 */
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  draftInputActivities,
  draftInputDependents,
  draftInputScheduleA,
  draftInputs,
} from '../db/schema.ts';
import { buildDraftInputForBundle } from './build.ts';
import { loadNodeMap } from './nodes.ts';
import type { PreparerActivity, PreparerDependent, PreparerScheduleA } from './translate.ts';

export interface DraftInputRecord {
  filingStatus: string | null;
  taxpayerAge65OrOlder: boolean | null;
  spouseAge65OrOlder: boolean | null;
  taxpayerBlind: boolean | null;
  spouseBlind: boolean | null;
  dependents: (PreparerDependent & { id: string })[];
  /**
   * The itemised figures only. No id: there is exactly one row per bundle, addressed by the
   * bundle, and an index-signature type cannot carry a string id alongside its money values.
   */
  scheduleA: PreparerScheduleA | null;
  activities: (PreparerActivity & { id: string })[];
  updatedAt: Date | null;
}

/** Everything a bundle's preparer has stated, shaped for the translator and the UI. */
export async function draftInputsForBundle(bundleId: string): Promise<DraftInputRecord> {
  const [root] = await db.select().from(draftInputs).where(eq(draftInputs.bundleId, bundleId)).limit(1);
  const [scheduleA] = await db
    .select()
    .from(draftInputScheduleA)
    .where(eq(draftInputScheduleA.bundleId, bundleId))
    .limit(1);
  const dependents = await db
    .select()
    .from(draftInputDependents)
    .where(eq(draftInputDependents.bundleId, bundleId))
    .orderBy(asc(draftInputDependents.ordinal));
  const activities = await db
    .select()
    .from(draftInputActivities)
    .where(eq(draftInputActivities.bundleId, bundleId))
    .orderBy(asc(draftInputActivities.ordinal));

  return {
    filingStatus: root?.filingStatus ?? null,
    taxpayerAge65OrOlder: root?.taxpayerAge65OrOlder ?? null,
    spouseAge65OrOlder: root?.spouseAge65OrOlder ?? null,
    taxpayerBlind: root?.taxpayerBlind ?? null,
    spouseBlind: root?.spouseBlind ?? null,
    updatedAt: root?.updatedAt ?? null,
    dependents: dependents.map((d) => ({
      id: d.id,
      firstName: d.firstName,
      lastName: d.lastName,
      middleInitial: d.middleInitial,
      dob: d.dob,
      relationship: d.relationship,
      monthsInHome: d.monthsInHome,
      qualifyingChildForCtc: d.qualifyingChildForCtc,
      disabled: d.disabled,
      fullTimeStudent: d.fullTimeStudent,
      taxpayerProvidedOverHalfSupport: d.taxpayerProvidedOverHalfSupport,
      dependentOnAnotherReturn: d.dependentOnAnotherReturn,
      grossIncomeCents: d.grossIncomeCents,
    })),
    scheduleA: scheduleA
      ? {
          medicalCents: scheduleA.medicalCents,
          stateIncomeTaxCents: scheduleA.stateIncomeTaxCents,
          salesTaxCents: scheduleA.salesTaxCents,
          realEstateTaxCents: scheduleA.realEstateTaxCents,
          personalPropertyTaxCents: scheduleA.personalPropertyTaxCents,
          otherTaxesCents: scheduleA.otherTaxesCents,
          mortgageInterest1098Cents: scheduleA.mortgageInterest1098Cents,
          mortgageInterestNo1098Cents: scheduleA.mortgageInterestNo1098Cents,
          pointsNo1098Cents: scheduleA.pointsNo1098Cents,
          investmentInterestCents: scheduleA.investmentInterestCents,
          cashContributionsCents: scheduleA.cashContributionsCents,
          noncashContributionsCents: scheduleA.noncashContributionsCents,
          contributionCarryoverCents: scheduleA.contributionCarryoverCents,
          casualtyTheftLossCents: scheduleA.casualtyTheftLossCents,
          otherDeductionsCents: scheduleA.otherDeductionsCents,
          forceItemized: scheduleA.forceItemized,
          forceStandard: scheduleA.forceStandard,
        }
      : null,
    activities: activities.map((a) => ({
      id: a.id,
      kind: a.kind,
      description: a.description,
      activityCode: a.activityCode,
      accountingMethod: a.accountingMethod,
      materialParticipation: a.materialParticipation,
      propertyType: a.propertyType,
      fairRentalDays: a.fairRentalDays,
      personalUseDays: a.personalUseDays,
      grossCents: a.grossCents,
      expensesCents: a.expensesCents,
      expensesDescription: a.expensesDescription,
    })),
  };
}

/**
 * Every optional key here is written `| undefined` rather than left bare, and that is deliberate
 * under `exactOptionalPropertyTypes`.
 *
 * A route parses its body with zod, which produces `{ medicalCents?: number | null | undefined }`
 * — key present and undefined is indistinguishable from key absent once it has been through
 * `JSON.parse`. Drizzle treats both the same way too: an undefined value is dropped from the
 * generated statement rather than written as NULL. So the types say what actually arrives, rather
 * than making each caller launder its own parsed body into a narrower shape.
 *
 * What is *not* interchangeable is `null`. An absent key leaves the stored figure alone; `null`
 * clears it. Both reach the engine as absent (§5), but only one of them forgets what a preparer
 * typed, so the distinction has to survive to the database.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export interface DraftInputRootValues {
  filingStatus?: string | null | undefined;
  taxpayerAge65OrOlder?: boolean | null | undefined;
  spouseAge65OrOlder?: boolean | null | undefined;
  taxpayerBlind?: boolean | null | undefined;
  spouseBlind?: boolean | null | undefined;
}

/** The return-level statements: filing status, and the age and blindness flags. */
export async function saveDraftInputRoot(
  bundleId: string,
  userId: string,
  values: DraftInputRootValues,
): Promise<void> {
  await db
    .insert(draftInputs)
    .values({ bundleId, ...values, updatedBy: userId })
    .onConflictDoUpdate({
      target: draftInputs.bundleId,
      set: { ...values, updatedBy: userId, updatedAt: new Date() },
    });
}

/**
 * Validate a filing status against the engine's own vocabulary before it is stored.
 *
 * The codes are the engine's and change per release — 2.0.4 wants `mfj`, not
 * `married_filing_jointly`, and an unrecognised value is refused at the `general` node, which
 * loses the standard deduction and the whole tax computation with it. Catching it here means a
 * preparer is told at the moment they choose rather than when a draft silently comes back
 * wrong.
 */
export async function isKnownFilingStatus(taxYear: number, code: string): Promise<boolean> {
  const file = await loadNodeMap(taxYear);
  return file.filingStatuses.some((f) => f.code === code);
}

/** `son`, `daughter`, … as the engine spells them. An unknown one is refused at the node. */
export async function isKnownRelationship(taxYear: number, code: string): Promise<boolean> {
  const file = await loadNodeMap(taxYear);
  return (file.preparerInputs?.dependents.relationships ?? []).some((r) => r.code === code);
}

/** The activity kinds this engine release can actually take — farms are not among them. */
export async function supportedActivityKinds(taxYear: number): Promise<string[]> {
  const file = await loadNodeMap(taxYear);
  return (file.preparerInputs?.activities ?? []).map((a) => a.kind);
}

export type DependentInput = Patch<Omit<PreparerDependent, 'firstName' | 'lastName' | 'dob' | 'relationship' | 'monthsInHome'>> &
  Pick<PreparerDependent, 'firstName' | 'lastName' | 'dob' | 'relationship' | 'monthsInHome'>;

export async function addDependent(
  bundleId: string,
  values: DependentInput,
): Promise<{ id: string }> {
  const existing = await db
    .select({ ordinal: draftInputDependents.ordinal })
    .from(draftInputDependents)
    .where(eq(draftInputDependents.bundleId, bundleId));
  const ordinal = existing.reduce((max, r) => Math.max(max, r.ordinal), -1) + 1;

  const [row] = await db
    .insert(draftInputDependents)
    .values({ bundleId, ordinal, ...values })
    .returning({ id: draftInputDependents.id });
  return { id: row!.id };
}

export async function updateDependent(
  bundleId: string,
  dependentId: string,
  values: Patch<DependentInput>,
): Promise<boolean> {
  const res = await db
    .update(draftInputDependents)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(draftInputDependents.id, dependentId), eq(draftInputDependents.bundleId, bundleId)))
    .returning({ id: draftInputDependents.id });
  return res.length > 0;
}

export async function removeDependent(bundleId: string, dependentId: string): Promise<boolean> {
  const res = await db
    .delete(draftInputDependents)
    .where(and(eq(draftInputDependents.id, dependentId), eq(draftInputDependents.bundleId, bundleId)))
    .returning({ id: draftInputDependents.id });
  return res.length > 0;
}

/**
 * Itemised deductions. Every key is optional and `null` is a real value meaning "cleared".
 *
 * Note what this does **not** do: it never substitutes 0 for an absent key. A caller that omits
 * `medicalCents` leaves whatever was there; a caller that sends `null` clears it. Both reach the
 * engine as absent, which is the point (§5).
 */
export async function saveScheduleA(
  bundleId: string,
  userId: string,
  values: Record<string, number | boolean | null>,
): Promise<void> {
  await db
    .insert(draftInputScheduleA)
    .values({ bundleId, ...values, updatedBy: userId })
    .onConflictDoUpdate({
      target: draftInputScheduleA.bundleId,
      set: { ...values, updatedBy: userId, updatedAt: new Date() },
    });
}

export type ActivityInput = Patch<Omit<PreparerActivity, 'kind' | 'description'>> &
  Pick<PreparerActivity, 'kind' | 'description'>;

export async function addActivity(
  bundleId: string,
  userId: string,
  values: ActivityInput,
): Promise<{ id: string }> {
  const existing = await db
    .select({ ordinal: draftInputActivities.ordinal })
    .from(draftInputActivities)
    .where(eq(draftInputActivities.bundleId, bundleId));
  const ordinal = existing.reduce((max, r) => Math.max(max, r.ordinal), -1) + 1;

  const [row] = await db
    .insert(draftInputActivities)
    .values({ bundleId, ordinal, ...values, updatedBy: userId })
    .returning({ id: draftInputActivities.id });
  return { id: row!.id };
}

export async function updateActivity(
  bundleId: string,
  activityId: string,
  userId: string,
  values: Patch<ActivityInput>,
): Promise<boolean> {
  const res = await db
    .update(draftInputActivities)
    .set({ ...values, updatedBy: userId, updatedAt: new Date() })
    .where(and(eq(draftInputActivities.id, activityId), eq(draftInputActivities.bundleId, bundleId)))
    .returning({ id: draftInputActivities.id });
  return res.length > 0;
}

export async function removeActivity(bundleId: string, activityId: string): Promise<boolean> {
  const res = await db
    .delete(draftInputActivities)
    .where(and(eq(draftInputActivities.id, activityId), eq(draftInputActivities.bundleId, bundleId)))
    .returning({ id: draftInputActivities.id });
  return res.length > 0;
}

/** One itemised line a document in this bundle already feeds, and with what. */
export interface DocumentBackedScheduleALine {
  /** The `draft_input_schedule_a` column a preparer would type into. */
  column: string;
  /** The engine field both sides would feed. */
  nodeField: string;
  sources: {
    documentId: string | null;
    documentLabel: string;
    formType: string;
    /** This app's own field key, so the UI can name the box on the page. */
    fieldKey: string;
    cents: number;
  }[];
}

/**
 * Which itemised lines the bundle's own documents already feed (P18).
 *
 * Exists because of measured engine behaviour, not a UI preference: where a document and a
 * preparer both feed one Schedule A line, engine 2.0.4 uses the document and discards the typed
 * figure without a word. The app therefore sends one side and records the other as a
 * `superseded_by_preparer` omission — but a preparer has to know *before* typing that the box in
 * front of them displaces a 1098 rather than adding to it. This is what the entry surface reads
 * to say so.
 *
 * It is deliberately derived from a real translation rather than from the documents directly.
 * Asking the database "is there a 1098 in this bundle" would answer a different question: a 1098
 * from last season, one withheld for review, or one whose box 1 is blank feeds nothing, and
 * telling a preparer they are overriding a figure that was never sent would be its own quiet
 * lie. Building the payload with no preparer figures supplied reports exactly what the engine
 * would otherwise receive.
 */
export async function documentBackedScheduleALines(
  bundleId: string,
  taxYear: number | null,
): Promise<DocumentBackedScheduleALine[]> {
  if (taxYear === null) return [];

  let file: Awaited<ReturnType<typeof loadNodeMap>>;
  let built: Awaited<ReturnType<typeof buildDraftInputForBundle>>;
  try {
    file = await loadNodeMap(taxYear);
    // No `scheduleA` in the params, so nothing is superseded and every document field the
    // engine would receive is present in the payload.
    built = await buildDraftInputForBundle(bundleId);
  } catch {
    // A bundle with no confirmed tax year, or a season with no node map. Neither is an error
    // here: there is simply nothing to warn a preparer about yet.
    return [];
  }

  const inputs = file.preparerInputs;
  if (!inputs) return [];

  const out: DocumentBackedScheduleALine[] = [];
  for (const field of inputs.scheduleA.fields) {
    if (field.supersedes.length === 0) continue;

    const sources: DocumentBackedScheduleALine['sources'] = [];
    for (const sup of field.supersedes) {
      for (const node of built.nodes) {
        if (node.nodeType !== sup.nodeType) continue;
        const value = node.payload[sup.nodeField];
        if (typeof value !== 'number') continue;
        sources.push({
          documentId: node.documentId,
          documentLabel: (node.documentId && built.documentLabels[node.documentId]) || sup.formType,
          formType: sup.formType,
          fieldKey: sup.fieldKey,
          // The payload carries dollars because that is what the engine's catalogue wants; the
          // rest of the app speaks cents. The conversion is exact in this direction — the
          // payload value is itself `cents / 100`.
          cents: Math.round(value * 100),
        });
      }
    }

    if (sources.length > 0) out.push({ column: field.column, nodeField: field.nodeField, sources });
  }
  return out;
}
