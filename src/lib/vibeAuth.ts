/**
 * Single sign-on through Vibe Auth (P16).
 *
 * `@kisaesdevlab/vibe-auth` speaks OIDC to the firm's identity provider and serves
 * `/auth/*`. It owns no session and sets no cookie: when a sign-in succeeds it calls the
 * `SessionAdapter` below, and what comes out is the same `sessions` row and the same
 * `v1040_session` cookie a local sign-in produces. Nothing downstream can tell the two apart
 * except by `sessions.oidc_issuer`.
 *
 * ── The second factor (§11, QUESTIONS.md Q18) ───────────────────────────────────────────
 * MFA is mandatory and cannot be switched off. An SSO session is issued already satisfied,
 * which is only defensible if the identity provider demonstrably performed a second factor.
 * That is enforced in three places, each covering a way the one before it could be bypassed:
 *
 *   1. `VIBE_OIDC_REQUIRE_MFA_AMR` is forced on in the environment handed to the engine, so
 *      the engine refuses a token whose `amr` shows no second factor — with a proper failure
 *      audit and an error page. This is the path a real refusal takes.
 *   2. The package lets a firm admin turn that requirement off from its settings page, and a
 *      stored value beats the environment. So the settings store is wrapped to read and write
 *      the requirement as on regardless, and the settings route refuses the request outright.
 *   3. The session adapter checks `amr` again before writing a row. This one should be
 *      unreachable; it exists so that a future package version that reorders its checks fails
 *      closed instead of open. When it fires the engine has already logged a success, so it
 *      writes its own failure row to set the record straight.
 */
import formbody from '@fastify/formbody';
import {
  amrSatisfiesMfa,
  createPgStores,
  createVibeAuth,
  vibeAuthFastify,
  type SecretWrap,
  type SessionAdapter,
  type SessionIdentity,
  type SettingsStore,
  type VibeAuth,
  type VibeUser,
} from '@kisaesdevlab/vibe-auth';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit/log.ts';
import {
  SESSION_COOKIE,
  issueSsoSession,
  resolveSession,
  revokeSession,
  revokeSessionsByIdentity,
  sessionCookieOptions,
  sessionOidcIdentity,
} from '../auth/session.ts';
import { db, pool } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { open, seal } from '../storage/index.ts';
import { ADMIN_ROLE, PRODUCT_ROLES, vibeAuthAudit, vibeAuthUsers } from './vibeAuthUsers.ts';

/**
 * The package is framework-neutral and types its adapter arguments as Express objects. Under
 * `vibeAuthFastify` what actually arrives is the Fastify request and reply, so every adapter
 * method re-types them here, once, rather than casting at each use.
 */
const asRequest = (req: unknown): FastifyRequest => req as FastifyRequest;
const asReply = (res: unknown): FastifyReply => res as FastifyReply;

/** Same AES-256-GCM envelope and key as the blob store and the secret firm settings (§11). */
const secretWrap: SecretWrap = {
  wrap: async (plaintext) => seal(Buffer.from(plaintext, 'utf8')).toString('base64'),
  unwrap: async (wrapped) => open(Buffer.from(wrapped, 'base64')).toString('utf8'),
};

async function currentSession(req: unknown) {
  const session = await resolveSession(asRequest(req).cookies[SESSION_COOKIE]);
  // A pre-MFA local session holds a valid cookie but has proven one factor. It must not be
  // able to read or change authentication settings, so to the package it is nobody.
  return session?.mfaSatisfied ? session : null;
}

/** Exported for the test that proves (3) in the header holds on its own. */
export const vibeAuthSession: SessionAdapter = {
  async create(req, res, user: VibeUser, identity: SessionIdentity) {
    const request = asRequest(req);
    const amr = identity.amr ?? [];

    if (!amrSatisfiesMfa(amr)) {
      await audit({
        action: 'vibe.auth.login.failure',
        userId: user.id,
        ip: request.ip,
        detail: {
          method: 'oidc',
          reason: 'mfa_required',
          issuer: identity.issuer,
          sub: identity.subject,
          amr,
          note: 'refused by the session adapter after the engine accepted it; supersedes the preceding login.success',
        },
      });
      throw new Error('refusing an SSO session without proof of a second factor (amr)');
    }

    const { token } = await issueSsoSession(
      user.id,
      {
        issuer: identity.issuer,
        subject: identity.subject,
        sid: identity.sid ?? null,
        sealedIdToken: identity.idToken ? await secretWrap.wrap(identity.idToken) : null,
        amr,
      },
      { ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
    );
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    void asReply(res).setCookie(SESSION_COOKIE, token, sessionCookieOptions);
  },

  async destroy(req, res) {
    // Any session, satisfied or not: signing out of a half-finished sign-in is legitimate.
    const current = await resolveSession(asRequest(req).cookies[SESSION_COOKIE]);
    if (current) await revokeSession(current.sessionId);
    void asReply(res).clearCookie(SESSION_COOKIE, sessionCookieOptions);
  },

  async currentUserId(req) {
    return (await currentSession(req))?.id ?? null;
  },

  async currentIdentity(req) {
    const current = await currentSession(req);
    if (!current?.sso) return null;
    const stored = await sessionOidcIdentity(current.sessionId);
    if (!stored) return null;
    let idToken: string | undefined;
    try {
      idToken = stored.sealedIdToken ? await secretWrap.unwrap(stored.sealedIdToken) : undefined;
    } catch {
      // A rotated STORAGE_ENCRYPTION_KEY. Sign-out still works; the IdP just gets no hint.
      idToken = undefined;
    }
    return {
      issuer: stored.issuer,
      subject: stored.subject,
      amr: stored.amr,
      ...(stored.sid ? { sid: stored.sid } : {}),
      ...(idToken ? { idToken } : {}),
    };
  },

  async destroyByIdentity(identity) {
    return revokeSessionsByIdentity(identity);
  },
};

/** See (2) in the header. */
function pinMfaRequirement(inner: SettingsStore): SettingsStore {
  return {
    async get() {
      const stored = await inner.get();
      return stored ? { ...stored, requireMfaAmr: true } : stored;
    },
    async set(next) {
      const { mfaAckBy: _by, mfaAckAt: _at, ...rest } = next;
      await inner.set({ ...rest, requireMfaAmr: true });
    },
  };
}

const stores = createPgStores({
  query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows as Array<Record<string, unknown>>,
});

export const vibeAuth: VibeAuth = createVibeAuth({
  product: {
    slug: 'vibe-1040',
    name: 'Vibe 1040',
    // Most privileged first: the package breaks a tie between mapped groups by this order.
    roles: { roles: [...PRODUCT_ROLES], adminRole: ADMIN_ROLE },
  },
  users: vibeAuthUsers,
  session: vibeAuthSession,
  identities: stores.identities,
  settings: pinMfaRequirement(stores.settings),
  // Inert for this app — sessions are server-side and back-channel logout revokes the rows —
  // but the package calls it when present and the table exists, so the record is complete.
  revocations: stores.revocations,
  secretWrap,
  audit: vibeAuthAudit,
  // See (1) in the header. Everything else the package reads comes from the real environment.
  env: { ...process.env, VIBE_OIDC_REQUIRE_MFA_AMR: 'true' },
  // The appliance serves this app at the root of its own origin (rootServedOnly), and Caddy
  // strips any prefix before it reaches us. Redirect URIs come from VIBE_OIDC_PUBLIC_URL.
  basePath: '',
  loginPath: '/',
  breakglassLoginPath: '/login/local',
  defaultReturnTo: '/',
  trustProxy: true,
  syncRoles: true,
});

/**
 * Mounts `/auth/*`. Call after the cookie plugin and before the app's own routes.
 *
 * `@fastify/formbody` is for the back-channel logout POST, which the IdP sends urlencoded.
 */
export async function registerVibeAuth(app: FastifyInstance): Promise<void> {
  await app.register(formbody);

  // See (2) in the header. Refused before the engine sees it, so the engine never writes a
  // `vibe.auth.mfa.enforcement.disabled` row for something that did not happen.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'PUT' || req.url.split('?')[0] !== '/auth/settings') return;
    const body = req.body as { requireMfaAmr?: unknown } | null | undefined;
    if (body && typeof body === 'object' && 'requireMfaAmr' in body && body.requireMfaAmr !== true) {
      return reply.code(409).send({
        error: 'mfa_locked',
        message:
          'Vibe 1040 requires proof of a second factor on every single sign-on session. ' +
          'This cannot be turned off for this product.',
      });
    }
  });

  await app.register(vibeAuthFastify, { auth: vibeAuth });
}
