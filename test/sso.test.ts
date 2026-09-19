/**
 * Single sign-on through Vibe Auth (P16) — the first HTTP-level tests in this repo.
 *
 * The real server (`buildServer()` + `inject()`), the real `@kisaesdevlab/vibe-auth` engine,
 * the real database, and a fake identity provider that signs real tokens. Nothing about the
 * OIDC exchange is mocked, because the claim under test is about what this app does with a
 * token it has genuinely validated.
 *
 * The claim that matters most is §11 / QUESTIONS.md Q18: MFA is mandatory and single sign-on
 * does not change that. An SSO session is issued already satisfied, so these tests exist
 * chiefly to prove it is issued **only** on `amr` proof of a second factor, and that none of
 * the three ways of turning that off actually turns it off.
 *
 * The engine is a module singleton configured from the environment at import, so each
 * configuration under test gets its own module graph (`boot()`).
 *
 * Needs the test Postgres migrated to 0011; skips itself, loudly, when it is not there.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeIdp, type FakeUser } from './helpers/fake-idp.ts';

// Importing the routes pulls in the queues, which would open a Redis connection.
vi.mock('../src/queue/queues.ts', () => ({
  pipelineQueue: { add: vi.fn(async () => undefined), getJobs: vi.fn(async () => []) },
  rasterQueue: { add: vi.fn(async () => undefined) },
  rasterEvents: { on: vi.fn() },
  connection: {},
  QUEUE_NAMES: { RASTER: 'v1040.raster', PIPELINE: 'v1040.pipeline' },
  closeQueues: vi.fn(async () => undefined),
}));

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const DOMAIN = `sso-${RUN}.example.test`;
const CLIENT_ID = 'vibe-vibe-1040-test';
const CLIENT_SECRET = 'test-client-secret';
const PUBLIC_URL = 'http://app.test';
const MFA = ['pwd', 'otp'];

const admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 2 });
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await admin.query(sql, params)).rows as T[];

let dbAvailable = false;
try {
  const [row] = await q<{ version: string }>('select version from schema_migrations order by version desc limit 1');
  dbAvailable = (row?.version ?? '') >= '0011';
} catch {
  dbAvailable = false;
}
if (!dbAvailable) {
  console.warn('[sso.test] test database unavailable or not migrated to 0011 — skipping');
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** A fresh module graph — and so a fresh engine — under the given environment. */
async function boot(idp: FakeIdp, over: Record<string, string> = {}, opts: { start?: boolean } = {}) {
  vi.resetModules();
  const environment: Record<string, string> = {
    VIBE_AUTH_MODE: 'both',
    VIBE_OIDC_ISSUER: idp.issuer,
    VIBE_OIDC_CLIENT_ID: CLIENT_ID,
    VIBE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    VIBE_OIDC_PUBLIC_URL: PUBLIC_URL,
    LOG_LEVEL: 'fatal',
    ...over,
  };
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);

  const { buildServer } = await import('../src/server.ts');
  const { vibeAuth, vibeAuthSession } = await import('../src/lib/vibeAuth.ts');
  const users = await import('../src/lib/vibeAuthUsers.ts');
  const credentials = await import('../src/auth/credentials.ts');
  const sessions = await import('../src/auth/session.ts');
  const { pool } = await import('../src/db/client.ts');

  if (opts.start !== false) await vibeAuth.start();
  const app = await buildServer();

  return {
    app,
    vibeAuth,
    vibeAuthSession,
    users,
    credentials,
    sessions,
    async close() {
      vibeAuth.stop();
      await app.close();
      await pool.end();
      vi.unstubAllEnvs();
    },
  };
}

/** The whole redirect dance, as a browser would do it: start → IdP → callback. */
async function ssoSignIn(b: Booted) {
  const start = await b.app.inject({ method: 'GET', url: '/auth/oidc/start?return_to=/' });
  expect(start.statusCode, start.body).toBe(302);
  const atIdp = await fetch(String(start.headers['location']), { redirect: 'manual' });
  expect(atIdp.status).toBe(302);
  const callback = new URL(atIdp.headers.get('location')!);
  expect(callback.origin).toBe(PUBLIC_URL);
  const res = await b.app.inject({ method: 'GET', url: callback.pathname + callback.search });
  const cookie = res.cookies.find((c) => c.name === 'v1040_session');
  return { res, cookie, cookies: cookie ? { v1040_session: cookie.value } : undefined };
}

async function localUser(b: Booted, o: { email: string; role: 'admin' | 'partner' | 'staff'; password?: string }) {
  const [row] = await q<{ id: string }>(
    `insert into users (email, display_name, role, password_hash) values ($1, $2, $3, $4) returning id`,
    [o.email, o.email, o.role, await b.credentials.hashPassword(o.password ?? 'correct horse battery')],
  );
  return row!.id;
}

/** A local session, optionally past its second factor, without walking the TOTP flow. */
async function localSession(b: Booted, userId: string, satisfied: boolean) {
  const token = await b.sessions.issueSession(userId, {});
  if (satisfied) {
    const resolved = await b.sessions.resolveSession(token);
    await b.sessions.satisfyMfa(resolved!.sessionId);
  }
  return { v1040_session: token };
}

const liveSessions = async (email: string) =>
  q<{ id: string; mfa_satisfied_at: Date | null; oidc_amr: string[] | null; oidc_id_token: string | null }>(
    `select s.id, s.mfa_satisfied_at, s.oidc_amr, s.oidc_id_token from sessions s
       join users u on u.id = s.user_id where u.email = $1 and s.revoked_at is null`,
    [email],
  );

const auditRows = async (action: string, where: string, params: unknown[]) =>
  q<{ detail: Record<string, unknown>; user_id: string | null }>(
    `select detail, user_id from audit_log where action = $1 and ${where} order by at desc`,
    [action, ...params],
  );

const person = (name: string, over: Partial<FakeUser> = {}): FakeUser => ({
  sub: `sub-${name}-${RUN}`,
  email: `${name}@${DOMAIN}`,
  email_verified: true,
  name: `Test ${name}`,
  groups: ['vibe-staff'],
  roles: ['vibe-staff'],
  amr: MFA,
  ...over,
});

describe.skipIf(!dbAvailable)('single sign-on (P16)', () => {
  let idp: FakeIdp;

  beforeAll(async () => {
    idp = await new FakeIdp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: person('nobody') }).start();
    await q(`delete from auth_settings`);
  });

  afterAll(async () => {
    const mine = `select id from users where email like $1`;
    const like = [`%@${DOMAIN}`];
    await q(`delete from audit_log where user_id in (${mine}) or detail->>'issuer' = $2`, [...like, idp.issuer]);
    await q(`delete from audit_log where detail->>'email' like $1`, like);
    await q(`delete from sessions where user_id in (${mine})`, like);
    await q(`delete from auth_identities where user_id in (select id::text from users where email like $1)`, like);
    await q(`delete from users where email like $1`, like);
    await q(`delete from users where email = $1`, [`bg-${RUN}@appliance.local`]).catch(() => undefined);
    await q(`delete from auth_settings`);
    await idp.stop();
    await admin.end();
  });

  describe('mode "both"', () => {
    let b: Booted;
    beforeAll(async () => {
      b = await boot(idp);
    });
    afterAll(async () => b.close());

    it('reports single sign-on as available alongside the local form', async () => {
      const res = await b.app.inject({ method: 'GET', url: '/auth/status' });
      expect(res.statusCode).toBe(200);
      const status = res.json<{ mode: string; oidc: { enabled: boolean; reachable: boolean } }>();
      expect(status.mode).toBe('both');
      expect(status.oidc).toMatchObject({ enabled: true, reachable: true });
    });

    it('signs in a new user with amr proof: satisfied session, mapped role, amr on the audit row', async () => {
      const pat = person('pat', { groups: ['vibe-partner', 'unrelated'], roles: ['vibe-partner'] });
      idp.user = pat;

      const { res, cookies } = await ssoSignIn(b);
      expect(res.statusCode, res.body).toBe(302);
      expect(res.headers['location']).toBe('/');
      expect(cookies).toBeDefined();

      // The point of the phase: straight into the app, no second-factor prompt.
      const me = await b.app.inject({ method: 'GET', url: '/api/me', cookies: cookies! });
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json()).toMatchObject({ email: pat.email, role: 'partner', sso: true });

      const [session] = await liveSessions(pat.email!);
      expect(session?.mfa_satisfied_at).not.toBeNull();
      expect(session?.oidc_amr).toEqual(MFA);
      // Sealed at rest: a JWT starts `eyJ`, the blob envelope does not.
      expect(session?.oidc_id_token).toBeTruthy();
      expect(session?.oidc_id_token?.startsWith('eyJ')).toBe(false);

      const [success] = await auditRows('vibe.auth.login.success', `detail->>'sub' = $2`, [pat.sub]);
      expect(success?.detail['amr']).toEqual(MFA);
      expect(success?.user_id).toBeTruthy();
      expect(await auditRows('vibe.auth.user.provisioned', `detail->>'sub' = $2`, [pat.sub])).toHaveLength(1);

      // Just-in-time: a password hash nobody holds the preimage of, and no local factor.
      const [row] = await q<{ password_hash: string; totp_secret: string | null; mfa_enrolled_at: Date | null }>(
        `select password_hash, totp_secret, mfa_enrolled_at from users where email = $1`,
        [pat.email],
      );
      expect(row?.password_hash.startsWith('scrypt$')).toBe(true);
      expect(row?.totp_secret).toBeNull();
      expect(row?.mfa_enrolled_at).toBeNull();
    });

    it('sets the session cookie with the same attributes as a local sign-in', async () => {
      idp.user = person('cookie');
      const { cookie } = await ssoSignIn(b);
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    });

    it('REFUSES a token whose amr shows a password alone — no session, no cookie, failure audited', async () => {
      const sam = person('sam', { amr: ['pwd'] });
      idp.user = sam;

      const { res, cookie } = await ssoSignIn(b);
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('text/html');
      expect(cookie).toBeUndefined();

      expect(await liveSessions(sam.email!)).toHaveLength(0);
      const [failure] = await auditRows('vibe.auth.login.failure', `detail->>'sub' = $2`, [sam.sub]);
      expect(failure?.detail).toMatchObject({ reason: 'mfa_required', amr: ['pwd'] });
      expect(await auditRows('vibe.auth.login.success', `detail->>'sub' = $2`, [sam.sub])).toHaveLength(0);
    });

    it('refuses a token with no amr claim at all', async () => {
      const noamr = person('noamr', { amr: [] });
      idp.user = noamr;
      const { res, cookie } = await ssoSignIn(b);
      expect(res.statusCode).toBe(401);
      expect(cookie).toBeUndefined();
      expect(await liveSessions(noamr.email!)).toHaveLength(0);
    });

    it('the session adapter refuses on its own, and corrects the record when it does', async () => {
      // Layer 3 in src/lib/vibeAuth.ts: reached only if the engine's own check is ever
      // bypassed or reordered. Called directly, because nothing else can get here.
      const email = `adapter@${DOMAIN}`;
      const userId = await localUser(b, { email, role: 'staff' });
      const setCookie = vi.fn();
      const identity = { issuer: idp.issuer, subject: `sub-adapter-${RUN}`, amr: ['pwd'] };

      await expect(
        b.vibeAuthSession.create(
          { ip: '203.0.113.9', headers: {}, cookies: {} } as never,
          { setCookie } as never,
          { id: userId, email, role: 'staff', active: true },
          identity,
        ),
      ).rejects.toThrow(/second factor/);

      expect(setCookie).not.toHaveBeenCalled();
      expect(await liveSessions(email)).toHaveLength(0);
      const [failure] = await auditRows('vibe.auth.login.failure', `detail->>'sub' = $2`, [identity.subject]);
      expect(failure?.detail).toMatchObject({ reason: 'mfa_required' });
      expect(failure?.user_id).toBe(userId);
    });

    it('links an existing local account by verified email, case-insensitively, and syncs its role', async () => {
      const email = `lee@${DOMAIN}`;
      const userId = await localUser(b, { email, role: 'staff' });
      idp.user = person('lee', { email: `Lee@${DOMAIN.toUpperCase()}`, groups: ['vibe-admin'], roles: ['vibe-admin'] });

      const { res, cookies } = await ssoSignIn(b);
      expect(res.statusCode, res.body).toBe(302);
      const me = await b.app.inject({ method: 'GET', url: '/api/me', cookies: cookies! });
      expect(me.json()).toMatchObject({ id: userId, role: 'admin' });

      expect(await q(`select 1 from users where lower(email) = $1`, [email])).toHaveLength(1);
      expect(await auditRows('vibe.auth.user.linked', `user_id = $2`, [userId])).toHaveLength(1);
      expect(await auditRows('vibe.auth.role.changed', `user_id = $2`, [userId])).toHaveLength(1);
    });

    it('never links or provisions on an unverified email', async () => {
      const email = `vic@${DOMAIN}`;
      await localUser(b, { email, role: 'admin' });
      idp.user = person('vic', { email_verified: false });

      const { res, cookie } = await ssoSignIn(b);
      expect(res.statusCode).toBe(401);
      expect(cookie).toBeUndefined();
      expect(await liveSessions(email)).toHaveLength(0);
    });

    it('refuses a disabled account', async () => {
      const email = `dana@${DOMAIN}`;
      const userId = await localUser(b, { email, role: 'staff' });
      await q(`update users set disabled_at = now() where id = $1`, [userId]);
      idp.user = person('dana');

      const { res, cookie } = await ssoSignIn(b);
      expect(res.statusCode).toBe(401);
      expect(cookie).toBeUndefined();
    });

    it('ends the session on a back-channel logout, and a fresh sign-in works afterwards', async () => {
      const kim = person('kim');
      idp.user = kim;
      const first = await ssoSignIn(b);
      expect((await b.app.inject({ method: 'GET', url: '/api/me', cookies: first.cookies! })).statusCode).toBe(200);

      const logout = await b.app.inject({
        method: 'POST',
        url: '/auth/oidc/backchannel',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `logout_token=${encodeURIComponent(await idp.logoutToken({ sub: kim.sub, sid: `sid-${kim.sub}` }))}`,
      });
      expect(logout.statusCode, logout.body).toBeLessThan(300);

      expect((await b.app.inject({ method: 'GET', url: '/api/me', cookies: first.cookies! })).statusCode).toBe(401);
      expect(await liveSessions(kim.email!)).toHaveLength(0);

      const second = await ssoSignIn(b);
      expect((await b.app.inject({ method: 'GET', url: '/api/me', cookies: second.cookies! })).statusCode).toBe(200);
    });

    it('rejects a back-channel logout token it did not get from the identity provider', async () => {
      const res = await b.app.inject({
        method: 'POST',
        url: '/auth/oidc/backchannel',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'logout_token=not.a.token',
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('signs out an SSO session through /auth/oidc/logout and clears the cookie', async () => {
      idp.user = person('ola');
      const { cookies } = await ssoSignIn(b);
      const out = await b.app.inject({ method: 'GET', url: '/auth/oidc/logout?local=1', cookies: cookies! });
      expect(out.statusCode).toBe(302);
      expect(out.headers['location']).toBe('/');
      expect(out.cookies.find((c) => c.name === 'v1040_session')?.value).toBe('');
      expect((await b.app.inject({ method: 'GET', url: '/api/me', cookies: cookies! })).statusCode).toBe(401);
    });

    it('guards the authentication settings: nobody, a pre-MFA session, staff, then an admin', async () => {
      const staffId = await localUser(b, { email: `staff@${DOMAIN}`, role: 'staff' });
      const adminId = await localUser(b, { email: `boss@${DOMAIN}`, role: 'admin' });
      const get = (cookies?: Record<string, string>) =>
        b.app.inject({ method: 'GET', url: '/auth/settings', ...(cookies ? { cookies } : {}) });

      // The package answers every refusal here with 403, signed in or not.
      expect((await get()).statusCode).toBe(403);
      expect((await get(await localSession(b, staffId, true))).statusCode).toBe(403);
      // The one that matters: an ADMIN whose cookie is valid but has proven only a password.
      // To the package that session is nobody — same account, 403 before the second factor
      // and 200 after it.
      expect((await get(await localSession(b, adminId, false))).statusCode).toBe(403);
      expect((await get(await localSession(b, adminId, true))).statusCode).toBe(200);
    });

    it('will not let an admin turn the second-factor requirement off', async () => {
      const adminId = await localUser(b, { email: `boss2@${DOMAIN}`, role: 'admin' });
      const cookies = await localSession(b, adminId, true);
      const res = await b.app.inject({
        method: 'PUT',
        url: '/auth/settings',
        cookies,
        payload: { requireMfaAmr: false, mfaAck: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'mfa_locked' });
      expect(await q(`select 1 from audit_log where action = 'vibe.auth.mfa.enforcement.disabled'`)).toHaveLength(0);
    });

    it('404s an unknown /auth path as JSON rather than serving the SPA shell', async () => {
      const res = await b.app.inject({ method: 'GET', url: '/auth/oidc/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('signs a local user in regardless of the case they type their address in', async () => {
      const email = `casey@${DOMAIN}`;
      await localUser(b, { email, role: 'staff', password: 'a long enough password' });
      const res = await b.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `Casey@${DOMAIN.toUpperCase()}`, password: 'a long enough password' },
      });
      expect(res.statusCode, res.body).toBe(200);
      // Local sign-in is unchanged: still pre-MFA, still asks for the second factor.
      expect(res.json()).toMatchObject({ mfaRequired: true });
    });
  });

  describe('a stored setting that says the second factor is not required', () => {
    let b: Booted;
    beforeAll(async () => {
      // Written straight to the table, as a hand edit or an older package version would
      // leave it. A stored value beats the environment inside the engine.
      await q(
        `insert into auth_settings (key, value) values ('vibe_auth', $1::jsonb)
           on conflict (key) do update set value = excluded.value`,
        [JSON.stringify({ requireMfaAmr: false, mfaAckBy: 'someone', mfaAckAt: new Date().toISOString() })],
      );
      b = await boot(idp);
    });
    afterAll(async () => {
      await b.close();
      await q(`delete from auth_settings`);
    });

    it('is ignored: a password-only token is still refused', async () => {
      const rae = person('rae', { amr: ['pwd'] });
      idp.user = rae;
      const { res, cookie } = await ssoSignIn(b);
      expect(res.statusCode).toBe(401);
      expect(cookie).toBeUndefined();
      expect(await liveSessions(rae.email!)).toHaveLength(0);
      const [failure] = await auditRows('vibe.auth.login.failure', `detail->>'sub' = $2`, [rae.sub]);
      expect(failure?.detail).toMatchObject({ reason: 'mfa_required' });
    });

    it('and a token with amr proof still signs in', async () => {
      idp.user = person('uma');
      const { res, cookies } = await ssoSignIn(b);
      expect(res.statusCode, res.body).toBe(302);
      expect((await b.app.inject({ method: 'GET', url: '/api/me', cookies: cookies! })).statusCode).toBe(200);
    });
  });

  describe('mode "oidc_only"', () => {
    const BG_USER = `bg-${RUN}`;
    const BG_PASSWORD = 'break glass in case of fire';
    const env = { VIBE_AUTH_MODE: 'oidc_only', VIBE_BREAKGLASS_USERNAME: BG_USER };

    it('refuses to start without a break-glass account', async () => {
      const b = await boot(idp, env, { start: false });
      try {
        await expect(b.vibeAuth.start()).rejects.toThrow(/break-glass/i);
      } finally {
        await b.close();
      }
    });

    describe('with a break-glass account', () => {
      let b: Booted;
      beforeAll(async () => {
        b = await boot(idp, env, { start: false });
        await b.users.vibeAuthUsers.createLocalUser({
          username: BG_USER,
          email: 'ignored@example.test',
          name: 'Break glass',
          role: 'admin',
          password: BG_PASSWORD,
        });
        await b.vibeAuth.start();
      });
      afterAll(async () => b.close());

      it('turns an ordinary local sign-in away before looking at the password', async () => {
        const email = `nia@${DOMAIN}`;
        await localUser(b, { email, role: 'admin', password: 'a long enough password' });
        const res = await b.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email, password: 'a long enough password' },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: 'sso_required' });
        expect(res.cookies.find((c) => c.name === 'v1040_session')).toBeUndefined();
      });

      it('lets break-glass in by username — and STILL asks it for a second factor', async () => {
        const res = await b.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: BG_USER, password: BG_PASSWORD },
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ mfaRequired: true, method: 'totp', needsTotpEnrolment: true });

        // The cookie it got is pre-MFA. It opens nothing until an authenticator is enrolled.
        const cookie = res.cookies.find((c) => c.name === 'v1040_session')!;
        const me = await b.app.inject({ method: 'GET', url: '/api/me', cookies: { v1040_session: cookie.value } });
        expect(me.statusCode).toBe(403);
        expect(me.json()).toMatchObject({ error: 'mfa_required' });

        const [bg] = await q<{ id: string }>(`select id from users where email = $1`, [`${BG_USER}@appliance.local`]);
        expect(await auditRows('vibe.auth.breakglass.used', `user_id = $2`, [bg!.id])).toHaveLength(1);
        await q(`delete from audit_log where user_id = $1`, [bg!.id]);
        await q(`delete from sessions where user_id = $1`, [bg!.id]);
      });

      it('single sign-on itself still works', async () => {
        idp.user = person('zed');
        const { res, cookies } = await ssoSignIn(b);
        expect(res.statusCode, res.body).toBe(302);
        expect((await b.app.inject({ method: 'GET', url: '/api/me', cookies: cookies! })).statusCode).toBe(200);
      });
    });
  });
});
