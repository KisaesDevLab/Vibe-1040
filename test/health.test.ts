/**
 * `GET /health` must answer fast enough for the container's own healthcheck, with the optional
 * engine unreachable.
 *
 * ## The incident this is a regression test for
 *
 * On 2026-09-27 an appliance deploy failed with "App vibe-1040 did not become healthy within
 * 180s". Nothing was wrong with the app: it had started, migrated, and was serving. `/health`
 * awaited a live probe of the OpenTax sidecar, whose budget is 5000 ms, and the Docker
 * healthcheck's timeout is 5 s — the same number. With the sidecar unreachable (its compose
 * service is behind a profile and had not been started) the probe could never win: every
 * `/health` took *at least* 5000 ms and the healthcheck killed it at exactly 5000 ms. The
 * container never reported healthy, and the appliance gave up after 30 s + 5 × 30 s = 180 s.
 *
 * The route's comment claimed an unreachable engine was "never a reason for `ok: false`". That
 * was true of the JSON and false of the latency, and the latency is what the healthcheck reads.
 *
 * ## What is asserted, and why it is a budget rather than a mock
 *
 * The number below is read from the **Dockerfile**, not written here, so the test cannot drift
 * away from the thing it protects: change the healthcheck timeout and this test changes with it.
 * The margin is deliberate — passing at 4999 ms would be passing by luck.
 *
 * ## How the incident's condition is reproduced
 *
 * `engineHealth` is stubbed to take the full 5000 ms its real implementation budgets when the
 * sidecar does not answer. That is the whole incident: not that the probe *fails*, but that it
 * takes as long as the healthcheck allows. Everything else in the module is the real thing.
 *
 * **This stub is load-bearing and the first version of this file did not have it.** Without it
 * the assertions passed against the broken code, because the suite's global setup starts a
 * wrapper on `OPENTAX_URL` — so the live probe answered in milliseconds and the latency test
 * proved nothing. A test for a timeout has to have something that actually times out.
 */
import { readFileSync } from 'node:fs';
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
  blobs: { get: vi.fn(async () => Buffer.from('x')), put: vi.fn(), delete: vi.fn() },
}));

/** What the real probe costs when the sidecar does not answer — `client.ts`'s own budget. */
const UNREACHABLE_PROBE_MS = 5_000;

vi.mock('../src/draft/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/draft/client.ts')>('../src/draft/client.ts');
  return {
    ...actual,
    // Everything else stays real — including lastKnownEngineHealth, which is what is under test.
    engineHealth: async () => {
      await new Promise((resolve) => setTimeout(resolve, UNREACHABLE_PROBE_MS));
      return { ok: false, version: null, reason: 'timed out' };
    },
  };
});

const { db, pool } = await import('../src/db/client.ts');

let dbAvailable = false;
try {
  await db.execute(sql`select 1`);
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
if (!dbAvailable) console.warn('[health.test] test database unavailable — skipping');

/** The healthcheck's own timeout, read from the Dockerfile so the two cannot drift apart. */
function healthcheckTimeoutMs(): number {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const match = /HEALTHCHECK[^\n]*--timeout=(\d+)s/.exec(dockerfile);
  if (!match) throw new Error('could not read the healthcheck timeout out of the Dockerfile');
  return Number(match[1]) * 1000;
}

interface HealthBody {
  ok: boolean;
  service: string;
  router: string;
  draftReturn: {
    enabled: boolean;
    engine: { ok: boolean; version: string | null; reason?: string } | null;
  };
}

describe.skipIf(!dbAvailable)('GET /health', () => {
  let app: Awaited<ReturnType<typeof import('../src/server.ts')['buildServer']>>;

  beforeAll(async () => {
    const { buildServer } = await import('../src/server.ts');
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    await pool.end();
  });

  it('answers well inside the container healthcheck budget with the engine unreachable', async () => {
    const budget = healthcheckTimeoutMs();
    // Half the budget. A liveness path that spends most of its allowance is one bad day from
    // failing, and the old code spent all of it.
    const allowed = budget / 2;

    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/health' });
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(200);
    expect(
      elapsed,
      `/health took ${elapsed}ms; the container healthcheck allows ${budget}ms and kills it at ` +
        'exactly that, which is how an unreachable optional sidecar took an appliance down',
    ).toBeLessThan(allowed);
  });

  it('stays fast when called repeatedly, which is what a healthcheck does', async () => {
    const allowed = healthcheckTimeoutMs() / 2;
    for (let i = 0; i < 3; i += 1) {
      const started = Date.now();
      await app.inject({ method: 'GET', url: '/health' });
      const elapsed = Date.now() - started;
      expect(elapsed, `call ${i + 1} took ${elapsed}ms`).toBeLessThan(allowed);
    }
  });

  it('still reports the engine as unreachable rather than pretending it is fine', async () => {
    const { __setLastEngineProbe } = await import('../src/draft/client.ts');
    __setLastEngineProbe({ ok: false, version: null, reason: 'timed out' });

    const body = (await app.inject({ method: 'GET', url: '/health' })).json<HealthBody>();
    // Degraded is reported, not hidden — the point is that it does not *block*, not that it
    // goes quiet. An operator reading /health must still see that the engine is down.
    expect(body.draftReturn.engine).toMatchObject({ ok: false });
    expect(body.ok, 'an optional checking aid being down is not the appliance being unhealthy').toBe(true);
  });

  it('reports a cold cache honestly instead of waiting to find out', async () => {
    const { __setLastEngineProbe } = await import('../src/draft/client.ts');
    __setLastEngineProbe(null);

    const started = Date.now();
    const body = (await app.inject({ method: 'GET', url: '/health' })).json<HealthBody>();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(healthcheckTimeoutMs() / 2);
    if (body.draftReturn.enabled) {
      // Never invented as healthy; the first call says it does not know yet.
      expect(body.draftReturn.engine?.ok).toBe(false);
    }
  });
});
