/**
 * Preparer-supplied draft inputs (P18).
 *
 * What a source-document bundle cannot know and a person therefore states: dependents, itemised
 * deductions, and business and rental summaries. The real database, the real node map, the real
 * translator.
 *
 * Four claims earn a test here, and each one is a way this could quietly go wrong:
 *
 *  1. **Blank is not zero (§5).** A figure the preparer never touched is `null` all the way
 *     through, and an absent key in a patch leaves the stored figure alone while an explicit
 *     `null` clears it. Three different meanings of "nothing", kept apart.
 *  2. **No TIN, by construction (§7).** Not in the dependents table, not in what this module
 *     returns. The engine marks a dependent's SSN optional, so there is no reason to hold one.
 *  3. **`documentBackedScheduleALines` tells the truth about what it would displace.** It is
 *     derived from a real translation rather than from "is there a 1098 in this bundle",
 *     because a prior-year 1098 feeds the engine nothing — and telling a preparer they are
 *     overriding a figure that was never sent is its own quiet lie.
 *  4. **An unknown code is refused where it is typed**, not accepted and lost at compute time.
 *     Engine 2.0.4 wants `mfj`, and refuses a whole node for anything else.
 *
 * Needs the test Postgres migrated to 0013; skips itself, loudly, when it is not there.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage/index.ts', () => ({
  blobs: { get: vi.fn(async () => Buffer.from('jpeg')), put: vi.fn(), delete: vi.fn() },
}));

const { db, pool } = await import('../src/db/client.ts');
const schema = await import('../src/db/schema.ts');
const { eq } = await import('drizzle-orm');
const {
  addActivity,
  addDependent,
  documentBackedScheduleALines,
  draftInputsForBundle,
  isKnownFilingStatus,
  isKnownRelationship,
  removeDependent,
  saveDraftInputRoot,
  saveScheduleA,
  supportedActivityKinds,
  updateDependent,
} = await import('../src/draft/inputs.ts');

let dbAvailable = false;
try {
  await db.execute(sql`select 1`);
  const [row] = (
    await db.execute(sql`select version from schema_migrations order by version desc limit 1`)
  ).rows as { version: string }[];
  dbAvailable = (row?.version ?? '') >= '0013';
} catch {
  dbAvailable = false;
}
if (!dbAvailable) {
  console.warn('[draft-inputs.test] test database unavailable or not migrated to 0013 — skipping');
}

const SPAN = '22222222-2222-2222-2222-222222222222';

describe.skipIf(!dbAvailable)('preparer-supplied draft inputs', () => {
  let userId: string;
  let bundleId: string;
  let thisYear1098: string;
  let priorYear1098: string;

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `inputs-${Date.now()}@example.test`,
        displayName: 'Inputs Test',
        role: 'admin',
        passwordHash: 'x',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;

    const [bundle] = await db
      .insert(schema.bundles)
      .values({
        label: 'preparer inputs test',
        status: 'in_review',
        uploadedBy: userId,
        contentHash: `inputs-${Date.now()}`,
        taxYear: 2025,
        identityConfirmedAt: new Date(),
      })
      .returning({ id: schema.bundles.id });
    bundleId = bundle!.id;

    const [file] = await db
      .insert(schema.sourceFiles)
      .values({
        bundleId,
        filename: 'packet.pdf',
        mediaType: 'application/pdf',
        byteSize: 1,
        sha256: 'x',
        storageKey: 'k',
      })
      .returning({ id: schema.sourceFiles.id });

    const [page] = await db
      .insert(schema.pages)
      .values({
        bundleId,
        sourceFileId: file!.id,
        pageNumber: 1,
        route: 'text_layer',
        dpi: 200,
        widthPx: 1700,
        heightPx: 2200,
        rasterStorageKey: 'r1',
      })
      .returning({ id: schema.pages.id });

    // Two 1098s: this season's, which the engine will receive, and last season's, which §14
    // rule 6 withholds. The pair is the whole point — one of them is a figure a preparer would
    // be overriding and the other is not, and only a real translation can tell them apart.
    const mk = async (taxYear: number, payerName: string): Promise<string> => {
      const [doc] = await db
        .insert(schema.documents)
        .values({
          bundleId,
          formType: '1098',
          taxYear,
          payerName,
          extractionOutcome: 'extracted',
          extractionCompletedAt: new Date(),
        })
        .returning({ id: schema.documents.id });
      return doc!.id;
    };
    thisYear1098 = await mk(2025, 'FIRST NATIONAL');
    priorYear1098 = await mk(2024, 'OLD LENDER');

    await db.insert(schema.extractedFields).values([
      { documentId: thisYear1098, fieldKey: 'recipient_name', valueText: 'FIRST NATIONAL', spanIds: [SPAN], pageId: page!.id },
      { documentId: thisYear1098, fieldKey: 'box_1', valueCents: 4_000_000, spanIds: [SPAN], pageId: page!.id },
      { documentId: thisYear1098, fieldKey: 'box_10', valueText: 'REAL ESTATE TAX 3,200', spanIds: [SPAN], pageId: page!.id },
      { documentId: priorYear1098, fieldKey: 'recipient_name', valueText: 'OLD LENDER', spanIds: [SPAN], pageId: page!.id },
      { documentId: priorYear1098, fieldKey: 'box_1', valueCents: 3_100_000, spanIds: [SPAN], pageId: page!.id },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (bundleId) await db.delete(schema.bundles).where(eq(schema.bundles.id, bundleId));
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('reads back nothing at all for a bundle nobody has typed into', async () => {
    const stored = await draftInputsForBundle(bundleId);
    // Not `false`, not `0`, not `[]` standing in for a stated "none": null and empty mean
    // "nobody has said", which is a different answer from "no" (§9).
    expect(stored.filingStatus).toBeNull();
    expect(stored.taxpayerAge65OrOlder).toBeNull();
    expect(stored.spouseBlind).toBeNull();
    expect(stored.scheduleA).toBeNull();
    expect(stored.dependents).toEqual([]);
    expect(stored.activities).toEqual([]);
  });

  it('keeps absent, null and a figure as three different things on a Schedule A line', async () => {
    await saveScheduleA(bundleId, userId, { medicalCents: 812_34, cashContributionsCents: 500_000 });
    expect((await draftInputsForBundle(bundleId)).scheduleA).toMatchObject({
      medicalCents: 812_34,
      cashContributionsCents: 500_000,
      // Every other line is untouched and therefore null, never 0. A zero here would become a
      // zero on the engine payload and destroy the distinction §5 exists to preserve.
      realEstateTaxCents: null,
      investmentInterestCents: null,
      forceItemized: null,
    });

    // An absent key leaves the stored figure alone.
    await saveScheduleA(bundleId, userId, { cashContributionsCents: 600_000 });
    expect((await draftInputsForBundle(bundleId)).scheduleA).toMatchObject({
      medicalCents: 812_34,
      cashContributionsCents: 600_000,
    });

    // An explicit null clears it. Both reach the engine as absent; only one of them forgets
    // what a preparer typed, so the two cannot be collapsed.
    await saveScheduleA(bundleId, userId, { medicalCents: null });
    expect((await draftInputsForBundle(bundleId)).scheduleA).toMatchObject({
      medicalCents: null,
      cashContributionsCents: 600_000,
    });
  });

  it('holds a dependent with no identification number anywhere', async () => {
    const { id } = await addDependent(bundleId, {
      firstName: 'ANNA',
      lastName: 'SMITH',
      dob: '2014-03-02',
      relationship: 'daughter',
      monthsInHome: 12,
      qualifyingChildForCtc: true,
    });

    const stored = await draftInputsForBundle(bundleId);
    expect(stored.dependents).toHaveLength(1);
    expect(stored.dependents[0]).toMatchObject({
      id,
      firstName: 'ANNA',
      relationship: 'daughter',
      monthsInHome: 12,
      qualifyingChildForCtc: true,
      // Stated as nothing, not stated as false. Whether a child is a full-time student is a
      // determination and the app makes none.
      fullTimeStudent: null,
      disabled: null,
    });

    // §7, checked against the table itself rather than against the reading code: there is no
    // column that could hold a TIN, so no future caller can start writing one.
    const cols = (
      await db.execute(
        sql`select column_name from information_schema.columns where table_name = 'draft_input_dependents'`,
      )
    ).rows as { column_name: string }[];
    const names = cols.map((c) => c.column_name).join(' ');
    expect(names).not.toMatch(/ssn|itin|atin|tin/);
    // And nothing the module hands out either.
    expect(JSON.stringify(stored)).not.toMatch(/ssn|itin|atin/i);

    expect(await updateDependent(bundleId, id, { monthsInHome: 7 })).toBe(true);
    expect((await draftInputsForBundle(bundleId)).dependents[0]!.monthsInHome).toBe(7);
    // Another bundle's id is not this bundle's to touch or to delete.
    expect(await updateDependent(bundleId, SPAN, { monthsInHome: 1 })).toBe(false);
    expect(await removeDependent(bundleId, id)).toBe(true);
    expect(await removeDependent(bundleId, id)).toBe(false);
  });

  it('refuses a code the engine would refuse, at the point it is typed', async () => {
    expect(await isKnownFilingStatus(2025, 'mfj')).toBe(true);
    // The regression the real engine caught: a plausible spelling the engine does not know,
    // which loses the standard deduction and the whole computation with it.
    expect(await isKnownFilingStatus(2025, 'married_filing_jointly')).toBe(false);
    expect(await isKnownRelationship(2025, 'daughter')).toBe(true);
    expect(await isKnownRelationship(2025, 'niece')).toBe(false);

    const kinds = await supportedActivityKinds(2025);
    expect(kinds).toContain('schedule_c');
    expect(kinds).toContain('schedule_e');
    // Engine 2.0.4 refuses a `schedule_f` node outright, so a farm is not offered. It is
    // listed as unsupported with a reason rather than accepted and dropped later.
    expect(kinds).not.toContain('schedule_f');
  });

  it('stores a business summary as the preparer stated it', async () => {
    const { id } = await addActivity(bundleId, userId, {
      kind: 'schedule_c',
      description: 'CONSULTING',
      activityCode: '541600',
      accountingMethod: 'cash',
      materialParticipation: true,
      grossCents: 12_000_000,
      expensesCents: 4_500_000,
      expensesDescription: 'Summary of business expenses',
    });
    const stored = await draftInputsForBundle(bundleId);
    expect(stored.activities).toHaveLength(1);
    expect(stored.activities[0]).toMatchObject({
      id,
      kind: 'schedule_c',
      // A digit string that must stay a string: the engine's business code is text, and
      // coercing it to a number breaks the node.
      activityCode: '541600',
      grossCents: 12_000_000,
      expensesCents: 4_500_000,
    });
  });

  describe('what a preparer figure would displace', () => {
    it('names the 1098 the engine actually receives, and not last season s', async () => {
      const backed = await documentBackedScheduleALines(bundleId, 2025);
      const line = backed.find((b) => b.column === 'mortgageInterest1098Cents');
      expect(line, 'the bundle has a current-year 1098, so line 8a is document-backed').toBeDefined();
      expect(line!.nodeField).toBe('line_8a_mortgage_interest_1098');

      // Exactly one source: the 2025 form. The 2024 one is withheld from the engine by §14
      // rule 6, so a preparer typing into this box displaces 40,000 and nothing else.
      expect(line!.sources).toHaveLength(1);
      expect(line!.sources[0]).toMatchObject({
        documentId: thisYear1098,
        formType: '1098',
        fieldKey: 'box_1',
        cents: 4_000_000,
      });
      expect(line!.sources[0]!.documentLabel).toContain('FIRST NATIONAL');
      expect(line!.sources.map((s) => s.documentId)).not.toContain(priorYear1098);
    });

    it('says nothing about a line no document in the bundle feeds', async () => {
      const backed = await documentBackedScheduleALines(bundleId, 2025);
      // There is no W-2 here, so state income tax is the preparer's to state outright.
      expect(backed.find((b) => b.column === 'stateIncomeTaxCents')).toBeUndefined();
      // And a line nothing could ever feed is never in this list at all.
      expect(backed.find((b) => b.column === 'cashContributionsCents')).toBeUndefined();
    });

    it('reports nothing rather than throwing for a bundle with no confirmed tax year', async () => {
      await expect(documentBackedScheduleALines(bundleId, null)).resolves.toEqual([]);
    });
  });

  it('stores the filing status once, so a preparer does not retype it per draft', async () => {
    await saveDraftInputRoot(bundleId, userId, { filingStatus: 'mfj', taxpayerAge65OrOlder: true });
    const stored = await draftInputsForBundle(bundleId);
    expect(stored.filingStatus).toBe('mfj');
    expect(stored.taxpayerAge65OrOlder).toBe(true);
    // Untouched by that write, and still unstated rather than false.
    expect(stored.spouseAge65OrOlder).toBeNull();
    expect(stored.updatedAt).toBeInstanceOf(Date);
  });
});
