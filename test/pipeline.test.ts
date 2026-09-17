/**
 * Stage hand-off integration test.
 *
 * Walks a bundle that looks like a real client packet — a cover letter, a native W-2, a
 * blank duplex back side, and a form nobody registered — from raster output to a reconciled
 * status, with the router mocked and the database real. Before 0007 this bundle stalled
 * twice: the blank page never "had spans" so layout never completed, and the cover letter
 * never left `classified` so reconcile never ran. Neither was covered by a test, because no
 * test crossed a stage boundary.
 *
 * Needs the test Postgres from `docker-compose.dev.yml` with migrations applied; skips
 * itself when it cannot connect, and says so.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

vi.mock('../src/router/client.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/router/client.ts')>();
  return { ...original, completeJson: vi.fn(), completeText: vi.fn() };
});

const { db, pool } = await import('../src/db/client.ts');
const schema = await import('../src/db/schema.ts');
const { completeJson } = await import('../src/router/client.ts');
const { pipelineQueue } = await import('../src/queue/queues.ts');
const pipeline = await import('../src/queue/pipeline.ts');
const { TASK_CLASS } = await import('../src/router/task-classes.ts');
const { eq, and } = await import('drizzle-orm');

let dbAvailable = false;
try {
  await db.execute(sql`select 1`);
  const [row] = (await db.execute(sql`select version from schema_migrations order by version desc limit 1`)).rows as {
    version: string;
  }[];
  dbAvailable = (row?.version ?? '') >= '0007';
} catch {
  dbAvailable = false;
}
if (!dbAvailable) {
  console.warn('[pipeline.test] test database unavailable or not migrated to 0007 — skipping');
}

const mockedJson = completeJson as unknown as ReturnType<typeof vi.fn>;
const queued = pipelineQueue.add as unknown as ReturnType<typeof vi.fn>;

const classification = (over: Record<string, unknown>) => ({
  form_type: null,
  confidence: 0.9,
  continues_previous: false,
  corrected: false,
  void: false,
  is_summary: false,
  is_supplemental: false,
  unrecognised_form: false,
  payer_name: null,
  tax_year: 2025,
  section_code: null,
  ...over,
});

describe.skipIf(!dbAvailable)('pipeline stage hand-offs (0007)', () => {
  let userId: string;
  let bundleId: string;
  let fileId: string;
  const pageIds: Record<number, string> = {};

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `pipeline-${Date.now()}@example.test`, displayName: 'Pipeline Test', role: 'admin', passwordHash: 'x' })
      .returning({ id: schema.users.id });
    userId = user!.id;
    const [bundle] = await db
      .insert(schema.bundles)
      .values({ label: 'pipeline test', status: 'triaging', uploadedBy: userId, contentHash: `pipeline-${Date.now()}` })
      .returning({ id: schema.bundles.id });
    bundleId = bundle!.id;
    const [file] = await db
      .insert(schema.sourceFiles)
      .values({ bundleId, filename: 'packet.pdf', mediaType: 'application/pdf', byteSize: 1, sha256: 'x', storageKey: 'k' })
      .returning({ id: schema.sourceFiles.id });
    fileId = file!.id;
  });

  afterAll(async () => {
    if (bundleId) await db.delete(schema.bundles).where(eq(schema.bundles.id, bundleId));
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('stores exact text-layer spans from the sidecar and marks those pages laid out', async () => {
    const w2Spans = [
      { text: '1 Wages, tips, other compensation', x0: 0.05, y0: 0.2, x1: 0.3, y1: 0.212 },
      { text: '85,000.00', x0: 0.06, y0: 0.215, x1: 0.2, y1: 0.227 },
      { text: '2 Federal income tax withheld', x0: 0.55, y0: 0.2, x1: 0.8, y1: 0.212 },
      { text: '11,420.00', x0: 0.56, y0: 0.215, x1: 0.7, y1: 0.227 },
      { text: 'ACME MANUFACTURING INC', x0: 0.06, y0: 0.1, x1: 0.3, y1: 0.112 },
    ];
    await pipeline.recordRasterOutput(bundleId, fileId, [
      { pageNumber: 1, route: 'text_layer', hasTextLayer: true, textLayerGarbled: false, textLayer: 'Dear client, enclosed are your documents.', dpi: 200, encoding: 'image/jpeg', widthPx: 1700, heightPx: 2200, encodedBytes: 1, rasterStorageKey: 'r1', triageReason: 't', layoutSpans: [{ text: 'Dear client, enclosed are your documents.', x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.11 }] },
      { pageNumber: 2, route: 'text_layer', hasTextLayer: true, textLayerGarbled: false, textLayer: 'Form W-2 Wage and Tax Statement 2024', dpi: 200, encoding: 'image/jpeg', widthPx: 1700, heightPx: 2200, encodedBytes: 1, rasterStorageKey: 'r2', triageReason: 't', layoutSpans: w2Spans },
      { pageNumber: 3, route: 'raster', hasTextLayer: false, textLayerGarbled: false, textLayer: null, dpi: 300, encoding: 'image/jpeg', widthPx: 2550, heightPx: 3300, encodedBytes: 1, rasterStorageKey: 'r3', triageReason: 'no embedded text', layoutSpans: null },
      { pageNumber: 4, route: 'text_layer', hasTextLayer: true, textLayerGarbled: false, textLayer: 'Form 1099-DA Digital Asset Proceeds', dpi: 200, encoding: 'image/jpeg', widthPx: 1700, heightPx: 2200, encodedBytes: 1, rasterStorageKey: 'r4', triageReason: 't', layoutSpans: [{ text: 'Form 1099-DA', x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.11 }] },
    ]);

    const rows = await db.select().from(schema.pages).where(eq(schema.pages.bundleId, bundleId));
    expect(rows).toHaveLength(4);
    for (const row of rows) pageIds[row.pageNumber] = row.id;

    const p2 = rows.find((r) => r.pageNumber === 2)!;
    expect(p2.layoutCompletedAt).not.toBeNull();
    expect(p2.layoutSource).toBe('text_layer');
    expect(p2.spanCount).toBe(5);
    const p3 = rows.find((r) => r.pageNumber === 3)!;
    expect(p3.layoutCompletedAt).toBeNull();

    const spans = await db.select().from(schema.layoutSpans).where(eq(schema.layoutSpans.pageId, p2.id));
    expect(spans.map((s) => s.producedByModel)).toEqual(Array(5).fill(pipeline.TEXT_LAYER_SPAN_PRODUCER));
  });

  it('classifies, splits, and fans layout out only to the page that still needs it', async () => {
    const answers = [
      classification({ is_supplemental: true }),
      classification({ form_type: 'Form W2', tax_year: 2024, payer_name: 'ACME MANUFACTURING INC' }),
      classification({ is_supplemental: true, tax_year: null }),
      classification({ form_type: '1099-DA' }),
    ];
    mockedJson.mockImplementation(async (taskClass: string) => {
      if (taskClass !== TASK_CLASS.PAGE_CLASSIFY) throw new Error(`unexpected ${taskClass}`);
      return { data: answers.shift(), model: 'test-model', requestId: 'req' };
    });
    queued.mockClear();

    await pipeline.classifyBundle(bundleId, userId);

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.bundleId, bundleId));
    expect(docs).toHaveLength(4);
    const w2 = docs.find((d) => d.formType === 'W-2')!;
    expect(w2, 'the model said "Form W2" and normalization mapped it').toBeDefined();
    expect(w2.taxYear).toBe(2024);
    expect(docs.some((d) => d.formType === '1099-DA')).toBe(true);

    const layoutJobs = queued.mock.calls.filter((c) => c[0] === 'layout_page');
    expect(layoutJobs).toHaveLength(1);
    expect(layoutJobs[0]![1]).toMatchObject({ pageId: pageIds[3] });
    const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, bundleId));
    expect(bundle!.status).toBe('extracting');
  });

  it('a blank page with zero spans completes layout and hands off to extraction', async () => {
    mockedJson.mockImplementation(async (taskClass: string) => {
      if (taskClass !== TASK_CLASS.LAYOUT) throw new Error(`unexpected ${taskClass}`);
      return { data: { spans: [] }, model: 'vision-model', requestId: 'req' };
    });
    queued.mockClear();

    await pipeline.layoutPage(bundleId, pageIds[3]!, userId);
    const [p3] = await db.select().from(schema.pages).where(eq(schema.pages.id, pageIds[3]!));
    expect(p3!.layoutCompletedAt).not.toBeNull();
    expect(p3!.spanCount).toBe(0);
    expect(p3!.layoutSource).toBe('model');

    expect(await pipeline.advanceAfterLayout(bundleId, userId)).toBe('fanned_out');
    const extractJobs = queued.mock.calls.filter((c) => c[0] === 'extract_document');
    expect(extractJobs).toHaveLength(4);
    // A second job observing completion must not fan out again (0008).
    expect(await pipeline.advanceAfterLayout(bundleId, userId)).toBe('already');
    expect(queued.mock.calls.filter((c) => c[0] === 'extract_document')).toHaveLength(4);
  });

  it('every document records an outcome, including the ones that extract nothing', async () => {
    mockedJson.mockImplementation(async (taskClass: string) => {
      if (taskClass !== TASK_CLASS.FIELD_EXTRACT) throw new Error(`unexpected ${taskClass}`);
      return {
        data: {
          fields: [
            { field_key: 'box_1', value: '85,000.00', span_indices: [1] },
            // Cites the right span but reports a number that is not in it: a misread.
            { field_key: 'box_2', value: '9,999.00', span_indices: [3] },
            { field_key: 'employer_name', value: 'ACME MANUFACTURING INC', span_indices: [4] },
            // A TIN makes extraction re-propose identity for this one 2024 document. That
            // proposal must not overwrite the bundle's majority year (2025).
            { field_key: 'employee_tin', value: '123-45-6789', span_indices: [0] },
            { field_key: 'box_3', value: null, span_indices: [] },
            // The model's three spellings of "empty": a bare "$", a zero it cannot cite, and
            // an unchecked box. None is a review item and none is an orphan (§5).
            { field_key: 'box_7', value: '$', span_indices: [] },
            { field_key: 'box_8', value: '0', span_indices: [] },
            { field_key: 'box_13_retirement', value: 'false', span_indices: [] },
            { field_key: 'box_13_statutory', value: 'true', span_indices: [] },
            { field_key: 'made_up_key', value: '1', span_indices: [0] },
          ],
        },
        model: 'text-model',
        requestId: 'req',
      };
    });
    queued.mockClear();

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.bundleId, bundleId));
    for (const doc of docs) {
      expect(await pipeline.advanceAfterExtraction(bundleId, userId), 'must not advance early').toBe('waiting');
      await pipeline.extractDocument(bundleId, doc.id, userId);
    }
    expect(await pipeline.advanceAfterExtraction(bundleId, userId)).toBe('fanned_out');
    expect(await pipeline.advanceAfterExtraction(bundleId, userId)).toBe('already');
    const [bundleAfter] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, bundleId));
    expect(bundleAfter!.taxYear, 'a single document\'s year must not replace the bundle majority').toBe(2025);
    expect(bundleAfter!.status, 'the post-extraction proposal must not flip the status mid-pipeline').toBe('extracting');
    const proposed = await db.select().from(schema.bundleTaxpayers).where(eq(schema.bundleTaxpayers.bundleId, bundleId));
    expect(proposed).toHaveLength(1);
    expect(queued.mock.calls.filter((c) => c[0] === 'reconcile_bundle')).toHaveLength(1);

    const after = await db.select().from(schema.documents).where(eq(schema.documents.bundleId, bundleId));
    const outcomes = new Map(after.map((d) => [d.formType ?? `null:${d.id}`, d.extractionOutcome]));
    expect(outcomes.get('W-2')).toBe('extracted');
    expect(outcomes.get('1099-DA')).toBe('no_schema');
    expect([...outcomes.values()].filter((o) => o === 'skipped_supplemental')).toHaveLength(2);

    const w2 = after.find((d) => d.formType === 'W-2')!;
    const fields = await db.select().from(schema.extractedFields).where(eq(schema.extractedFields.documentId, w2.id));
    const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
    expect(byKey.get('box_1')).toMatchObject({ valueCents: 8_500_000, needsReview: false });
    expect(byKey.get('box_2')).toMatchObject({ valueCents: 999_900, needsReview: true, reviewReason: 'span_mismatch' });
    expect(byKey.get('box_3')).toMatchObject({ valueCents: null, needsReview: false });
    expect(byKey.get('box_7')).toMatchObject({ valueCents: null, valueText: null, needsReview: false });
    expect(byKey.get('box_8')).toMatchObject({ valueCents: null, needsReview: false });
    expect(byKey.get('box_13_retirement')).toMatchObject({ valueBool: false, needsReview: false });
    // A checked box with nothing cited is a real orphan.
    expect(byKey.get('box_13_statutory')).toMatchObject({ valueBool: true, needsReview: true, reviewReason: 'no_span' });
    expect(byKey.has('made_up_key')).toBe(false);
  });

  it('reconcile raises the no-schema failure, annotates the schema-year substitution, and blocks', async () => {
    const summary = await pipeline.reconcileBundle(bundleId);
    expect(summary.hardFailures).toBeGreaterThanOrEqual(1);

    const checks = await db.select().from(schema.checkResults).where(eq(schema.checkResults.bundleId, bundleId));
    const keys = checks.filter((c) => c.outcome === 'fail').map((c) => c.checkKey);
    expect(keys).toContain('no_registered_schema');
    expect(keys).toContain('schema_year_substituted');
    expect(keys, 'a blank page is supplemental, not a form with no spans').not.toContain('no_layout_spans');
    const orphans = checks.find((c) => c.checkKey === 'every_field_has_spans')!;
    expect(orphans.outcome).toBe('fail');
    expect((orphans.detail as { fields: string[] }).fields, 'only the checked box, never the unchecked ones').toEqual([
      'box_13_statutory',
    ]);

    const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, bundleId));
    expect(bundle!.status).toBe('blocked');
  });

  it('requeues a parked layout page at the layout stage and keeps the failure record', async () => {
    await db.insert(schema.routerJobs).values({
      bundleId,
      pageId: pageIds[3]!,
      taskClass: TASK_CLASS.LAYOUT,
      state: 'parked',
      lastErrorCode: 'provider_unavailable',
      lastErrorMessage: 'router down',
    });
    await db.insert(schema.routerJobs).values({
      bundleId,
      documentId: (await db.select().from(schema.documents).where(and(eq(schema.documents.bundleId, bundleId), eq(schema.documents.formType, 'W-2'))))[0]!.id,
      taskClass: TASK_CLASS.FIELD_EXTRACT,
      state: 'failed',
      lastErrorCode: 'invalid_response',
      lastErrorMessage: 'json_truncated',
    });
    queued.mockClear();

    const result = await pipeline.requeueRouterJobs(bundleId, userId);
    expect(result).toMatchObject({ requeued: 2, classify: false, pages: 1, documents: 1 });
    expect(queued.mock.calls.map((c) => c[0]).sort()).toEqual(['extract_document', 'layout_page']);

    const jobs = await db.select().from(schema.routerJobs).where(eq(schema.routerJobs.bundleId, bundleId));
    expect(jobs.every((j) => j.state === 'requeued')).toBe(true);
    expect(await pipeline.requeueRouterJobs(bundleId, userId)).toMatchObject({ requeued: 0 });
  });

  it('a reprocess from classify does not duplicate documents', async () => {
    const answers = [
      classification({ is_supplemental: true }),
      classification({ form_type: 'W-2', tax_year: 2025 }),
      classification({ is_supplemental: true, tax_year: null }),
      classification({ form_type: '1099-DA' }),
    ];
    mockedJson.mockImplementation(async () => ({ data: answers.shift(), model: 'm', requestId: 'r' }));
    await pipeline.classifyBundle(bundleId, userId);
    const docs = await db.select().from(schema.documents).where(eq(schema.documents.bundleId, bundleId));
    expect(docs).toHaveLength(4);
  });
});
