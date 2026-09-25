/**
 * The draft-return and draft-input routes, over HTTP (P17, P18).
 *
 * Everything under these routes has been exercised before — by the browser, by `curl`, and by
 * calling the service modules directly — but never by a test, which is what the PR's own "not
 * verified" list said. The gap matters because a route is more than the function it calls: the
 * auth check, the zod schema, the 404 for a bundle that is not there, the audit row, and the
 * status code a client branches on all live here and nowhere else.
 *
 * The real server via `buildServer()` + `inject()`, the real database, and the wrapper the
 * global setup starts. Authentication is real too — a session row is seeded and the cookie is
 * sent, rather than `requireUser` being mocked out, because "does this route need a session"
 * is one of the things worth asserting.
 *
 * Needs the test Postgres migrated to 0013; skips itself, loudly, when it is not there.
 */
import { randomBytes, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Importing the routes pulls in the queues, which would open a Redis connection.
vi.mock('../src/queue/queues.ts', () => ({
  pipelineQueue: { add: vi.fn(async () => undefined), getJobs: vi.fn(async () => []) },
  rasterQueue: { add: vi.fn(async () => undefined) },
  rasterEvents: { on: vi.fn() },
  connection: {},
  QUEUE_NAMES: { RASTER: 'v1040.raster', PIPELINE: 'v1040.pipeline' },
  closeQueues: vi.fn(async () => undefined),
}));
vi.mock('../src/storage/index.ts', () => ({
  blobs: { get: vi.fn(async () => Buffer.from('jpeg')), put: vi.fn(), delete: vi.fn() },
}));

const { db, pool } = await import('../src/db/client.ts');
const schema = await import('../src/db/schema.ts');
const { eq } = await import('drizzle-orm');

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
  console.warn('[draft-routes.test] test database unavailable or not migrated to 0013 — skipping');
}

interface ErrorBody {
  error: string;
  message?: string;
  supported?: string[];
}

interface DraftInputsResponse {
  filingStatus: string | null;
  dependents: { id: string; monthsInHome: number; qualifyingChildForCtc: boolean | null }[];
  scheduleA: Record<string, number | boolean | null> | null;
  activities: { id: string; kind: string }[];
  filingStatuses: { code: string; label: string }[];
  relationships: { code: string; label: string }[];
  activityKinds: { kind: string; label: string }[];
  unsupportedActivities: { kind: string; label: string; detail: string }[];
  scheduleAFields: { column: string; label: string; group: string | null; money: boolean }[];
  documentBacked: {
    column: string;
    sources: { formType: string; fieldKey: string; cents: number; documentLabel: string }[];
  }[];
}

interface DraftResponse {
  complete: boolean;
  engineVersion: string;
  comparison: { undeclaredLines: string[] };
  omissions: { reason: string; formType: string | null }[];
}

interface StoredDraftResponse {
  draftReturn: { filingStatus: string | null };
  omissions: { reason: string; formType: string | null; detail: string }[];
}

const SPAN = '33333333-3333-3333-3333-333333333333';
/** A uuid that is well-formed and belongs to nothing, for the 404 paths. */
const ABSENT = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!dbAvailable)('the draft routes, over HTTP', () => {
  let app: Awaited<ReturnType<typeof import('../src/server.ts')['buildServer']>>;
  let userId: string;
  let bundleId: string;
  let cookies: Record<string, string>;

  /** Every request in this file goes through the real session check. */
  const get = (url: string) => app.inject({ method: 'GET', url, cookies });
  const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject(
      payload === undefined
        ? { method, url, cookies }
        : { method, url, cookies, payload: payload as Record<string, unknown> },
    );

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `routes-${Date.now()}@example.test`,
        displayName: 'Routes Test',
        role: 'admin',
        passwordHash: 'x',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;

    // A real session row, MFA satisfied, because `requireUser` refuses one that is not (§11).
    const token = randomBytes(32).toString('base64url');
    await db.insert(schema.sessions).values({
      userId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3_600_000),
      mfaSatisfiedAt: new Date(),
    });
    cookies = { v1040_session: token };

    const [bundle] = await db
      .insert(schema.bundles)
      .values({
        label: 'draft routes test',
        status: 'in_review',
        uploadedBy: userId,
        contentHash: `routes-${Date.now()}`,
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

    // A 1098, so line 8a is document-backed and the override has something to displace.
    const [doc] = await db
      .insert(schema.documents)
      .values({
        bundleId,
        formType: '1098',
        taxYear: 2025,
        payerName: 'HERITAGE MORTGAGE CO',
        extractionOutcome: 'extracted',
        extractionCompletedAt: new Date(),
      })
      .returning({ id: schema.documents.id });
    await db.insert(schema.extractedFields).values([
      { documentId: doc!.id, fieldKey: 'recipient_name', valueText: 'HERITAGE MORTGAGE CO', spanIds: [SPAN], pageId: page!.id },
      { documentId: doc!.id, fieldKey: 'box_1', valueCents: 1_284_400, spanIds: [SPAN], pageId: page!.id },
    ]);

    const { buildServer } = await import('../src/server.ts');
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (bundleId) await db.delete(schema.bundles).where(eq(schema.bundles.id, bundleId));
    if (userId) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    await pool.end();
  });

  describe('who may read a taxpayer’s figures', () => {
    it('refuses every draft-input route without a session', async () => {
      for (const url of [
        `/api/bundles/${bundleId}/draft-inputs`,
        `/api/bundles/${bundleId}/draft-return`,
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `${url} must not answer an anonymous caller`).toBe(401);
      }
      // And a write, which is the one that would otherwise alter a return.
      const write = await app.inject({
        method: 'PATCH',
        url: `/api/bundles/${bundleId}/draft-inputs`,
        payload: { filingStatus: 'mfj' },
      });
      expect(write.statusCode).toBe(401);
    });

    it('404s a bundle that does not exist, rather than leaking an empty record', async () => {
      expect((await get(`/api/bundles/${ABSENT}/draft-inputs`)).statusCode).toBe(404);
      expect((await send('PATCH', `/api/bundles/${ABSENT}/draft-inputs`, { filingStatus: 'mfj' })).statusCode).toBe(404);
    });
  });

  describe('GET draft-inputs', () => {
    it('serves the engine’s own vocabularies, so the UI cannot hardcode codes it refuses', async () => {
      const res = await get(`/api/bundles/${bundleId}/draft-inputs`);
      expect(res.statusCode).toBe(200);
      const body = res.json<DraftInputsResponse>();

      expect(body.filingStatus).toBeNull();
      // The regression the real engine caught: the engine's codes, not long names.
      expect(body.filingStatuses.map((f) => f.code)).toEqual(['single', 'mfj', 'mfs', 'hoh', 'qss']);
      expect(body.relationships.map((r) => r.code)).toContain('daughter');
      expect(body.activityKinds.map((a) => a.kind)).toEqual(['schedule_c', 'schedule_e']);
      // A farm is named as unavailable rather than quietly missing from the list.
      expect(body.unsupportedActivities.map((u) => u.kind)).toContain('schedule_f');
      // Every Schedule A field carries a label, because a field with no label does not get
      // rendered — a figure nobody can enter and nobody knows is missing.
      expect(body.scheduleAFields.length).toBeGreaterThan(0);
      expect(body.scheduleAFields.every((f) => f.label.length > 0)).toBe(true);
    });

    it('names the document a typed figure would displace', async () => {
      const body = (await get(`/api/bundles/${bundleId}/draft-inputs`)).json<DraftInputsResponse>();
      const line = body.documentBacked.find((b) => b.column === 'mortgageInterest1098Cents');
      expect(line, 'the bundle has a current-year 1098, so line 8a is document-backed').toBeDefined();
      expect(line!.sources[0]!.cents).toBe(1_284_400);
      expect(line!.sources[0]!.documentLabel).toContain('HERITAGE MORTGAGE CO');
    });
  });

  describe('a code the engine would refuse', () => {
    it('is refused here, with a taxonomy code a client can branch on', async () => {
      const res = await send('PATCH', `/api/bundles/${bundleId}/draft-inputs`, {
        filingStatus: 'married_filing_jointly',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error).toBe('unknown_filing_status');
      // And nothing was stored: a refused write must not half-apply.
      expect((await get(`/api/bundles/${bundleId}/draft-inputs`)).json<DraftInputsResponse>().filingStatus).toBeNull();
    });

    it('refuses an unknown relationship and an unsupported activity, each by name', async () => {
      const rel = await send('POST', `/api/bundles/${bundleId}/draft-inputs/dependents`, {
        firstName: 'X', lastName: 'Y', dob: '2014-01-01', relationship: 'niece', monthsInHome: 12,
      });
      expect(rel.statusCode).toBe(400);
      expect(rel.json<ErrorBody>().error).toBe('unknown_relationship');

      const farm = await send('POST', `/api/bundles/${bundleId}/draft-inputs/activities`, {
        kind: 'schedule_f', description: 'FARM',
      });
      expect(farm.statusCode).toBe(400);
      const body = farm.json<ErrorBody>();
      expect(body.error).toBe('unsupported_activity');
      // The measured reason, not a shrug — and what the preparer *can* enter instead.
      expect(body.message).toMatch(/schedule_f is not a valid input/);
      expect(body.supported).toEqual(['schedule_c', 'schedule_e']);
    });

    it('refuses a malformed body before it reaches the database', async () => {
      // 13 months in the home is not a typo the app should store and pass on.
      const res = await send('POST', `/api/bundles/${bundleId}/draft-inputs/dependents`, {
        firstName: 'X', lastName: 'Y', dob: '2014-01-01', relationship: 'daughter', monthsInHome: 13,
      });
      expect(res.statusCode).toBe(400);
      const dob = await send('POST', `/api/bundles/${bundleId}/draft-inputs/dependents`, {
        firstName: 'X', lastName: 'Y', dob: '01/01/2014', relationship: 'daughter', monthsInHome: 12,
      });
      expect(dob.statusCode).toBe(400);
    });
  });

  describe('the full round trip a preparer makes', () => {
    it('stores, reads back, amends and removes — and audits every write', async () => {
      expect((await send('PATCH', `/api/bundles/${bundleId}/draft-inputs`, { filingStatus: 'mfj' })).statusCode).toBe(200);

      const added = await send('POST', `/api/bundles/${bundleId}/draft-inputs/dependents`, {
        firstName: 'ANNA', lastName: 'SMITH', dob: '2014-03-02', relationship: 'daughter', monthsInHome: 12,
      });
      expect(added.statusCode).toBe(200);
      const dependentId = added.json<{ id: string }>().id;

      const afterAdd = (await get(`/api/bundles/${bundleId}/draft-inputs`)).json<DraftInputsResponse>();
      expect(afterAdd.filingStatus).toBe('mfj');
      expect(afterAdd.dependents).toHaveLength(1);
      // Added without a determination, so it is not stated — never false (§9).
      expect(afterAdd.dependents[0]!.qualifyingChildForCtc).toBeNull();

      expect(
        (await send('PATCH', `/api/bundles/${bundleId}/draft-inputs/dependents/${dependentId}`, {
          qualifyingChildForCtc: true,
        })).statusCode,
      ).toBe(200);

      // A Schedule A figure that displaces the 1098, and one that displaces nothing.
      expect(
        (await send('PUT', `/api/bundles/${bundleId}/draft-inputs/schedule-a`, {
          mortgageInterest1098Cents: 1_500_000,
          cashContributionsCents: 1_250_000,
        })).statusCode,
      ).toBe(200);

      const stored = (await get(`/api/bundles/${bundleId}/draft-inputs`)).json<DraftInputsResponse>();
      expect(stored.dependents[0]!.qualifyingChildForCtc).toBe(true);
      // The Schedule A row exists now, which is itself the assertion: it is null until a
      // preparer states something.
      expect(stored.scheduleA).not.toBeNull();
      expect(stored.scheduleA!['mortgageInterest1098Cents']).toBe(1_500_000);
      // Untouched lines are null, not zero (§5), all the way through the HTTP boundary.
      expect(stored.scheduleA!['medicalCents']).toBeNull();
      expect(stored.scheduleA!['forceItemized']).toBeNull();

      // Every one of those writes is a determination a person made, so the record says who.
      const rows = (
        await db.execute(
          sql`select action from audit_log where user_id = ${userId} and action like 'draft.%' order by at`,
        )
      ).rows as { action: string }[];
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('draft.inputs_updated');
      expect(actions).toContain('draft.dependent_added');
      expect(actions).toContain('draft.dependent_updated');

      expect((await send('DELETE', `/api/bundles/${bundleId}/draft-inputs/dependents/${dependentId}`)).statusCode).toBe(200);
      // Gone, and a second delete is a 404 rather than a silent success.
      expect((await send('DELETE', `/api/bundles/${bundleId}/draft-inputs/dependents/${dependentId}`)).statusCode).toBe(404);

      // Put it back: the draft-return test below needs a dependent to have been stated.
      await send('POST', `/api/bundles/${bundleId}/draft-inputs/dependents`, {
        firstName: 'ANNA', lastName: 'SMITH', dob: '2014-03-02', relationship: 'daughter',
        monthsInHome: 12, qualifyingChildForCtc: true,
      });
    });

    it('will not let one bundle’s id reach another bundle’s row', async () => {
      const [other] = await db
        .insert(schema.bundles)
        .values({
          label: 'other bundle',
          status: 'in_review',
          uploadedBy: userId,
          contentHash: `routes-other-${Date.now()}`,
          taxYear: 2025,
        })
        .returning({ id: schema.bundles.id });

      const mine = await send('POST', `/api/bundles/${bundleId}/draft-inputs/dependents`, {
        firstName: 'BEN', lastName: 'SMITH', dob: '2016-05-11', relationship: 'son', monthsInHome: 12,
      });
      const id = mine.json<{ id: string }>().id;

      // The same dependent id, addressed through a bundle it does not belong to.
      expect((await send('PATCH', `/api/bundles/${other!.id}/draft-inputs/dependents/${id}`, { monthsInHome: 1 })).statusCode).toBe(404);
      expect((await send('DELETE', `/api/bundles/${other!.id}/draft-inputs/dependents/${id}`)).statusCode).toBe(404);
      // And it is untouched.
      const still = (await get(`/api/bundles/${bundleId}/draft-inputs`)).json<DraftInputsResponse>();
      expect(still.dependents.find((d) => d.id === id)?.monthsInHome).toBe(12);

      await db.delete(schema.bundles).where(eq(schema.bundles.id, other!.id));
    });
  });

  describe('POST draft-return', () => {
    it('computes from the stored inputs with no filing status on the wire', async () => {
      // The P18 change: filing status lives on the record, so a draft cannot be computed under
      // one the record disagrees with. An empty body is the UI's actual request.
      const res = await send('POST', `/api/bundles/${bundleId}/draft-return`, {});
      expect(res.statusCode).toBe(200);
      const draft = res.json<DraftResponse>();
      expect(draft.engineVersion).toBe('9.9.9-fake');
      // Never complete from documents alone. That is the contract, not a shortcoming.
      expect(draft.complete).toBe(false);
      // The stored filing status reached the engine — without it the `general` node is refused
      // and the whole computation is lost.
      expect(draft.omissions.map((o) => o.reason)).not.toContain('engine_rejected');

      const stored = (await get(`/api/bundles/${bundleId}/draft-return`)).json<StoredDraftResponse>();
      expect(stored.draftReturn.filingStatus).toBe('mfj');
    });

    it('records the 1098 the preparer’s figure displaced', async () => {
      await send('POST', `/api/bundles/${bundleId}/draft-return`, {});
      const stored = (await get(`/api/bundles/${bundleId}/draft-return`)).json<StoredDraftResponse>();
      const override = stored.omissions.find((o) => o.reason === 'superseded_by_preparer');
      expect(override, 'an overridden document must survive as a durable omission').toBeDefined();
      expect(override!.formType).toBe('1098');
      // Both figures, in words, because the whole point is that the draft says what it did.
      expect(override!.detail).toMatch(/12844\.00/);
    });

    it('404s a draft for a bundle that has none', async () => {
      const [empty] = await db
        .insert(schema.bundles)
        .values({
          label: 'no draft here',
          status: 'in_review',
          uploadedBy: userId,
          contentHash: `routes-empty-${Date.now()}`,
          taxYear: 2025,
        })
        .returning({ id: schema.bundles.id });
      expect((await get(`/api/bundles/${empty!.id}/draft-return`)).statusCode).toBe(404);
      await db.delete(schema.bundles).where(eq(schema.bundles.id, empty!.id));
    });
  });
});
