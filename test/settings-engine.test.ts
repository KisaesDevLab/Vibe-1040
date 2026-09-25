/**
 * The engine-and-pipeline settings that used to be environment-only, over real HTTP.
 *
 * These five moved out of `readOnlyEnvironment()` on 2026-09-25 — "it changes what the app
 * computes about a taxpayer" became a reason to *audit* a change rather than a reason to make an
 * operator edit `.env` and restart a container. What is asserted here is the part that makes that
 * defensible rather than merely convenient:
 *
 *  - the acknowledgement is enforced by the **server**, so a `curl` cannot skip what the dialog
 *    asks; it is the audit row that matters, not the dialog;
 *  - only the permissive direction asks, because friction on switching a guard back off is how a
 *    dangerous state ends up left in place;
 *  - the audit row records that an admin was told and proceeded;
 *  - the draft-return gate actually follows the setting, not the environment;
 *  - and the five keys that did **not** move are still refused, including the one that cannot be
 *    a setting at all because this table's own secrets are encrypted with it.
 *
 * Needs the test Postgres migrated to 0013; skips itself, loudly, when it is not there.
 */
import { randomBytes, createHash } from 'node:crypto';
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
vi.mock('../src/storage/index.ts', async () => {
  // Real seal/open, because a settings secret round trip is part of what is under test.
  const actual = await vi.importActual<typeof import('../src/storage/index.ts')>('../src/storage/index.ts');
  return { ...actual, blobs: { get: vi.fn(async () => Buffer.from('jpeg')), put: vi.fn(), delete: vi.fn() } };
});

const { db, pool } = await import('../src/db/client.ts');
const schema = await import('../src/db/schema.ts');
const { eq, desc } = await import('drizzle-orm');

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
  console.warn('[settings-engine.test] test database unavailable or not migrated to 0013 — skipping');
}

interface SettingsBody {
  settings: {
    key: string;
    group: string;
    value: unknown;
    restartRequired: boolean;
    acknowledge: string | null;
    note?: string;
  }[];
  environment: { key: string; value: string; why: string }[];
}

describe.skipIf(!dbAvailable)('the engine and pipeline settings', () => {
  let app: Awaited<ReturnType<typeof import('../src/server.ts')['buildServer']>>;
  let userId: string;
  let cookies: Record<string, string>;

  const get = (url: string) => app.inject({ method: 'GET', url, cookies });
  const patch = (updates: unknown[]) =>
    app.inject({ method: 'PATCH', url: '/api/admin/settings', cookies, payload: { updates } });

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `settings-${Date.now()}@example.test`,
        displayName: 'Settings Test',
        role: 'admin',
        passwordHash: 'x',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;

    const token = randomBytes(32).toString('base64url');
    await db.insert(schema.sessions).values({
      userId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3_600_000),
      mfaSatisfiedAt: new Date(),
    });
    cookies = { v1040_session: token };

    const { buildServer } = await import('../src/server.ts');
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    // Leave no engine settings behind: the rest of the suite assumes the environment defaults.
    for (const key of [
      'draft.return_enabled',
      'engine.opentax_version',
      'extraction.attach_page_image',
      'extraction.ocr_fallback_enabled',
      'router.expected_sensitivity',
    ]) {
      await db.delete(schema.firmSettings).where(eq(schema.firmSettings.key, key));
    }
    const { invalidateSettingsCache } = await import('../src/settings/store.ts');
    invalidateSettingsCache();
    if (userId) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    await pool.end();
  });

  /**
   * Put the switch in a known state first.
   *
   * The first run of this file asserted a 409 and got a 200, because this container's `.env` sets
   * `DRAFT_RETURN_ENABLED=true` — so the seeded default was already on, "turning it on" was not a
   * change, and nothing needed acknowledging. The test was reading the ambient environment rather
   * than establishing anything. Switching it off explicitly costs one request and makes every
   * assertion below independent of whatever `.env` says.
   */
  it('starts from a known state, whatever the environment seeded', async () => {
    const res = await patch([{ key: 'draft.return_enabled', value: false }]);
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsBody>().settings.find((s) => s.key === 'draft.return_enabled')!.value).toBe(false);
  });

  it('serves the five as editable settings, with their semantics as data', async () => {
    const res = await get('/api/admin/settings');
    expect(res.statusCode).toBe(200);
    const body = res.json<SettingsBody>();
    const engine = body.settings.filter((s) => s.group === 'engine');

    expect(engine.map((s) => s.key).sort()).toEqual([
      'draft.return_enabled',
      'engine.opentax_version',
      'extraction.attach_page_image',
      'extraction.ocr_fallback_enabled',
      'router.expected_sensitivity',
    ]);

    // The two that only bite at boot say so in data, not in prose the UI has to parse.
    const restart = engine.filter((s) => s.restartRequired).map((s) => s.key);
    expect(restart.sort()).toEqual(['extraction.attach_page_image', 'extraction.ocr_fallback_enabled']);

    // And the draft return does not: it is read per request.
    expect(engine.find((s) => s.key === 'draft.return_enabled')!.restartRequired).toBe(false);
  });

  it('refuses to switch the draft return on without an acknowledgement', async () => {
    const res = await patch([{ key: 'draft.return_enabled', value: true }]);
    expect(res.statusCode, 'the server, not the dialog, is the control').toBe(409);
    const body = res.json<{ error: string; key: string; acknowledge: string }>();
    expect(body.error).toBe('acknowledgement_required');
    expect(body.key).toBe('draft.return_enabled');
    // The text comes back so a client can show what it is asking about.
    expect(body.acknowledge).toMatch(/Q21/);

    // Nothing stored. A refused change must not half-apply.
    const after = (await get('/api/admin/settings')).json<SettingsBody>();
    expect(after.settings.find((s) => s.key === 'draft.return_enabled')!.value).toBe(false);
  });

  it('accepts it with one, and the audit row says the admin was told', async () => {
    const res = await patch([{ key: 'draft.return_enabled', value: true, acknowledged: true }]);
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsBody>().settings.find((s) => s.key === 'draft.return_enabled')!.value).toBe(true);

    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId))
      .orderBy(desc(schema.auditLog.at))
      .limit(1);
    expect(row!.action).toBe('admin.setting_change');
    const detail = row!.detail as { key: string; before: unknown; after: unknown; acknowledged?: boolean };
    expect(detail.key).toBe('draft.return_enabled');
    expect(detail.before).toBe(false);
    expect(detail.after).toBe(true);
    expect(detail.acknowledged, 'the point of the acknowledgement is that the log records it').toBe(true);
  });

  it('lets the draft return be switched back off with no ceremony', async () => {
    // Friction on the safe direction is how a dangerous state gets left in place.
    const res = await patch([{ key: 'draft.return_enabled', value: false }]);
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsBody>().settings.find((s) => s.key === 'draft.return_enabled')!.value).toBe(false);
  });

  it('is what the draft-return gate actually reads', async () => {
    const { generateDraftReturn, DraftReturnDisabledError } = await import('../src/draft/generate.ts');
    const { invalidateSettingsCache } = await import('../src/settings/store.ts');

    // Off: refused, and by the setting rather than by the environment — which in this test
    // process says the opposite of whatever the row says on the next assertion.
    await patch([{ key: 'draft.return_enabled', value: false }]);
    invalidateSettingsCache();
    await expect(generateDraftReturn('00000000-0000-4000-8000-000000000000', userId)).rejects.toBeInstanceOf(
      DraftReturnDisabledError,
    );

    // On: it gets past the switch and fails later, on the bundle rather than the flag.
    await patch([{ key: 'draft.return_enabled', value: true, acknowledged: true }]);
    invalidateSettingsCache();
    await expect(
      generateDraftReturn('00000000-0000-4000-8000-000000000000', userId),
    ).rejects.not.toBeInstanceOf(DraftReturnDisabledError);

    await patch([{ key: 'draft.return_enabled', value: false }]);
    invalidateSettingsCache();
  });

  it('still refuses the five that did not move, each with a reason a person can act on', async () => {
    const body = (await get('/api/admin/settings')).json<SettingsBody>();
    expect(body.environment.map((e) => e.key).sort()).toEqual([
      'ROUTER_REQUIRE_US_REGION',
      'STORAGE_DRIVER',
      'STORAGE_ENCRYPTION_KEY',
      'TIN_HASH_SALT',
      'VIBE_AI_ROUTER_URL',
    ]);

    // Not settings, so the write path does not know them at all.
    for (const key of ['TIN_HASH_SALT', 'STORAGE_ENCRYPTION_KEY', 'ROUTER_REQUIRE_US_REGION', 'VIBE_AI_ROUTER_URL']) {
      const res = await patch([{ key, value: 'anything' }]);
      expect(res.statusCode, `${key} must not be writable through the settings route`).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(/unknown setting/);
    }

    // The blob key's reason is the one that is a hard impossibility rather than a policy view,
    // so it is worth asserting that the page actually says so.
    const blobKey = body.environment.find((e) => e.key === 'STORAGE_ENCRYPTION_KEY')!;
    expect(blobKey.why).toMatch(/encrypt it with itself/);
    expect(blobKey.value, 'never send the key itself to a browser').toBe('(set — never displayed)');
  });

  it('never returns the value of a secret it does hold', async () => {
    const body = (await get('/api/admin/settings')).json<SettingsBody>();
    for (const e of body.environment) {
      expect(e.value).not.toMatch(/^[0-9a-f]{32,}$/i);
    }
  });
});
