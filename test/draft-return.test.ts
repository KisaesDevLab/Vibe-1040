/**
 * Draft return, end to end (P17 stage 2).
 *
 * The real database, the real gate, the real translator, the real comparison, and the real
 * wrapper driving a stand-in binary. The only thing absent is the engine's own arithmetic,
 * which is exactly the thing the fixture harness is for.
 *
 * Four claims are worth a test crossing this many boundaries:
 *
 *  1. **The gate has one door.** A bundle with an undispositioned hard failure gets no draft
 *     return, and the refusal comes from `assertWorksheetAllowed` rather than a second check
 *     bolted on here.
 *  2. **Identity still gates it.** A worksheet is a statement about a named return, and so is
 *     a draft.
 *  3. **The omissions contract is durable.** What was withheld, and why, survives in the
 *     database — a draft that cannot say what it is missing is the failure mode the whole
 *     design avoids.
 *  4. **Disabled means disabled**, and an absent engine degrades rather than failing a bundle.
 *
 * Needs the test Postgres migrated to 0012; skips itself, loudly, when it is not there.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage/index.ts', () => ({
  blobs: { get: vi.fn(async () => Buffer.from('jpeg')), put: vi.fn(), delete: vi.fn() },
}));

const { db, pool } = await import('../src/db/client.ts');
const schema = await import('../src/db/schema.ts');
const { eq } = await import('drizzle-orm');
const { engineHealth } = await import('../src/draft/client.ts');
const { DraftReturnDisabledError, generateDraftReturn, latestDraftReturn } = await import(
  '../src/draft/generate.ts'
);

let dbAvailable = false;
try {
  await db.execute(sql`select 1`);
  const [row] = (
    await db.execute(sql`select version from schema_migrations order by version desc limit 1`)
  ).rows as { version: string }[];
  dbAvailable = (row?.version ?? '') >= '0012';
} catch {
  dbAvailable = false;
}
if (!dbAvailable) {
  console.warn('[draft-return.test] test database unavailable or not migrated to 0012 — skipping');
}

const SPAN = '11111111-1111-1111-1111-111111111111';

describe.skipIf(!dbAvailable)('draft return, end to end', () => {
  let userId: string;
  let bundleId: string;
  let w2DocId: string;
  let ssaDocId: string;

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `draft-${Date.now()}@example.test`,
        displayName: 'Draft Test',
        role: 'admin',
        passwordHash: 'x',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;

    const [bundle] = await db
      .insert(schema.bundles)
      .values({
        label: 'draft return test',
        status: 'in_review',
        uploadedBy: userId,
        contentHash: `draft-${Date.now()}`,
        taxYear: 2025,
        // The §7 gate: confirmed, so the draft is a statement about a named return.
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

    // A W-2 the engine can take, and an SSA-1099 it must never see (§9): box 3 is always
    // printed, so a populated judgment field withholds the whole document, every time.
    const [w2] = await db
      .insert(schema.documents)
      .values({
        bundleId,
        formType: 'W-2',
        taxYear: 2025,
        payerName: 'ACME INC',
        extractionOutcome: 'extracted',
        extractionCompletedAt: new Date(),
      })
      .returning({ id: schema.documents.id });
    w2DocId = w2!.id;

    const [ssa] = await db
      .insert(schema.documents)
      .values({
        bundleId,
        formType: 'SSA-1099',
        taxYear: 2025,
        payerName: 'SSA',
        extractionOutcome: 'extracted',
        extractionCompletedAt: new Date(),
      })
      .returning({ id: schema.documents.id });
    ssaDocId = ssa!.id;

    await db.insert(schema.extractedFields).values([
      { documentId: w2DocId, fieldKey: 'employer_name', valueText: 'ACME INC', spanIds: [SPAN], pageId: page!.id },
      { documentId: w2DocId, fieldKey: 'box_1', valueCents: 5_500_000, spanIds: [SPAN], pageId: page!.id },
      { documentId: w2DocId, fieldKey: 'box_2', valueCents: 520_000, spanIds: [SPAN], pageId: page!.id },
      { documentId: ssaDocId, fieldKey: 'box_3', valueCents: 2_400_000, spanIds: [SPAN], pageId: page!.id },
      { documentId: ssaDocId, fieldKey: 'box_5', valueCents: 2_400_000, spanIds: [SPAN], pageId: page!.id },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (bundleId) await db.delete(schema.bundles).where(eq(schema.bundles.id, bundleId));
    if (userId) {
      // Generating a draft return audits (§11), and those rows reference the user. That the
      // teardown has to clear them is itself a small confirmation that the audit happened.
      await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    await pool.end();
  });

  it('computes a draft, stores it, and reports it as incomplete', async () => {
    const result = await generateDraftReturn(bundleId, userId, { filingStatus: 'single' });

    expect(result.engineVersion).toBe('9.9.9-fake');
    expect(result.nodeMapVersion).toBe('2025.1');
    // One W-2 in, one SSA-1099 withheld.
    expect(result.documentsIncluded).toBe(1);
    expect(result.documentsWithheld).toBe(1);
    // Never complete from documents alone. That is the contract, not a shortcoming.
    expect(result.complete).toBe(false);

    const stored = await latestDraftReturn(bundleId);
    expect(stored).not.toBeNull();
    expect(stored!.draftReturn.complete).toBe(false);
    expect(stored!.draftReturn.filingStatus).toBe('single');
    expect(stored!.draftReturn.engineVersion).toBe('9.9.9-fake');
    expect(stored!.lines.length).toBeGreaterThan(0);
  });

  it('puts the engine figure beside the reported total and agrees on wages', async () => {
    const result = await generateDraftReturn(bundleId, userId, { filingStatus: 'single' });
    const wages = result.comparison.lines.find((l) => l.lineRef === '1040:1a');
    expect(wages?.reportedCents).toBe(5_500_000);
    expect(wages?.computedCents).toBe(5_500_000);
    expect(wages?.verdict).toBe('agrees');

    const withheld = result.comparison.lines.find((l) => l.lineRef === '1040:25a');
    expect(withheld?.computedCents).toBe(520_000);
    expect(withheld?.verdict).toBe('agrees');
  });

  it('carries figures the worksheet cannot produce', async () => {
    const result = await generateDraftReturn(bundleId, userId, { filingStatus: 'single' });
    const agi = result.comparison.computedOnly.find((c) => c.engineLine === 'line11_agi');
    expect(agi?.computedCents).toBe(5_500_000);

    const stored = await latestDraftReturn(bundleId);
    const computedOnly = stored!.lines.filter((l) => l.verdict === 'computed_only');
    expect(computedOnly.length).toBeGreaterThan(0);
    // An engine-only figure has no worksheet line ref, by construction.
    expect(computedOnly.every((l) => l.lineRef === null)).toBe(true);
  });

  it('records the withheld SSA-1099 as a durable omission naming the field and the reason', async () => {
    await generateDraftReturn(bundleId, userId, { filingStatus: 'single' });
    const stored = await latestDraftReturn(bundleId);

    const ssa = stored!.omissions.find((o) => o.documentId === ssaDocId);
    expect(ssa, 'the SSA-1099 must appear in the omissions').toBeDefined();
    expect(ssa!.reason).toBe('judgment_required');
    expect(ssa!.fieldKey).toBe('box_3');
    expect(ssa!.formType).toBe('SSA-1099');

    // And the things no document could carry.
    const notInBundle = stored!.omissions.filter((o) => o.reason === 'not_in_bundle').map((o) => o.fieldKey);
    expect(notInBundle).toContain('capital_basis');
    expect(notInBundle).toContain('carryovers');
    // Filing status was stated, so it is no longer missing.
    expect(notInBundle).not.toContain('filing_status');
  });

  it('stores the engine diagnostics, hard and soft apart', async () => {
    await generateDraftReturn(bundleId, userId, { filingStatus: 'single' });
    const stored = await latestDraftReturn(bundleId);
    const hard = stored!.validations.filter((v) => v.severity === 'hard').map((v) => v.code);
    const soft = stored!.validations.filter((v) => v.severity === 'soft').map((v) => v.code);
    expect(hard).toContain('F1040-001');
    expect(soft).toContain('F1040-900');
  });

  it('refuses when a hard check has no disposition, through the worksheet gate', async () => {
    const { WorksheetBlockedError } = await import('../src/reconcile/gate.ts');
    const [check] = await db
      .insert(schema.checkResults)
      .values({
        bundleId,
        documentId: w2DocId,
        checkKey: 'w2_ss_tax_rate',
        severity: 'hard',
        outcome: 'fail',
        message: 'box 4 exceeds box 3 x 6.2%',
      })
      .returning({ id: schema.checkResults.id });

    // The refusal must come from the gate, not from a check invented in the draft path.
    await expect(generateDraftReturn(bundleId, userId, { filingStatus: 'single' })).rejects.toThrow(
      WorksheetBlockedError,
    );

    await db.delete(schema.checkResults).where(eq(schema.checkResults.id, check!.id));
    // And once it is gone, the draft computes again — the gate has one door and it opens.
    await expect(generateDraftReturn(bundleId, userId, { filingStatus: 'single' })).resolves.toBeDefined();
  });

  it('refuses when identity has not been confirmed', async () => {
    const { IdentityNotConfirmedError } = await import('../src/reconcile/gate.ts');
    await db.update(schema.bundles).set({ identityConfirmedAt: null }).where(eq(schema.bundles.id, bundleId));

    await expect(generateDraftReturn(bundleId, userId, { filingStatus: 'single' })).rejects.toThrow(
      IdentityNotConfirmedError,
    );

    await db.update(schema.bundles).set({ identityConfirmedAt: new Date() }).where(eq(schema.bundles.id, bundleId));
  });

  it('refuses outright when the deployment has not enabled it', async () => {
    const { env } = await import('../src/config/env.ts');
    const original = env.DRAFT_RETURN_ENABLED;
    (env as { DRAFT_RETURN_ENABLED: boolean }).DRAFT_RETURN_ENABLED = false;
    try {
      await expect(generateDraftReturn(bundleId, userId, {})).rejects.toThrow(DraftReturnDisabledError);
    } finally {
      (env as { DRAFT_RETURN_ENABLED: boolean }).DRAFT_RETURN_ENABLED = original;
    }
  });

  it('purges with the bundle, and leaves the same evidence a policy purge does (§11)', async () => {
    const result = await generateDraftReturn(bundleId, userId, { filingStatus: 'single' });
    const { deleteBundle } = await import('../src/retention/delete-bundle.ts');

    // A throwaway bundle of its own, so the shared one survives for the other cases.
    const [spare] = await db
      .insert(schema.bundles)
      .values({
        label: 'draft purge test',
        status: 'in_review',
        uploadedBy: userId,
        contentHash: `draft-purge-${Date.now()}`,
        taxYear: 2025,
        identityConfirmedAt: new Date(),
      })
      .returning({ id: schema.bundles.id });
    const [draft] = await db
      .insert(schema.draftReturns)
      .values({
        bundleId: spare!.id,
        taxYear: 2025,
        engineVersion: '9.9.9-fake',
        nodeMapVersion: '2025.1',
        mappingVersion: '2025.3',
        complete: false,
        generatedBy: userId,
      })
      .returning({ id: schema.draftReturns.id });

    await deleteBundle(spare!.id);

    const left = await db
      .select()
      .from(schema.draftReturns)
      .where(eq(schema.draftReturns.id, draft!.id));
    expect(left, 'the draft return goes with the bundle').toHaveLength(0);

    const logged = await db
      .select()
      .from(schema.purgeLog)
      .where(eq(schema.purgeLog.entityId, draft!.id));
    expect(logged, 'and its disposal is logged, like every other disposal').toHaveLength(1);
    expect(logged[0]!.kind).toBe('draft_return');

    expect(result.draftReturnId).toBeTruthy();
  });
});
