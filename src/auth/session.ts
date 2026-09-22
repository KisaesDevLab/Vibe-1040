/**
 * Session issue/verify (P0). Opaque random token in an httpOnly cookie; only its SHA-256
 * is stored, so a database read cannot mint a session.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';

export const SESSION_COOKIE = 'v1040_session';
const TTL_MS = 12 * 60 * 60 * 1000; // one working day

/**
 * Attributes for the staff session cookie, defined once.
 *
 * `Secure` tracks whether the browser really reached us over HTTPS (`SESSION_SECURE`) and
 * is deliberately not inferred from `NODE_ENV` — a production appliance reached on its
 * plain-HTTP LAN port is the normal case, not a misconfiguration. Set and clear must agree
 * on these attributes or the clear silently misses.
 */
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: env.SESSION_SECURE,
  path: '/',
};

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'partner' | 'staff';
  sessionId: string;
  mfaSatisfied: boolean;
  /** True when the session was born from single sign-on rather than a local password. */
  sso: boolean;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Issued pre-MFA: `mfaSatisfiedAt` stays null until the second-factor step succeeds. */
export async function issueSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TTL_MS),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return token;
}

/** What the identity provider asserted about an SSO sign-in. Stored on the session row. */
export interface OidcSessionIdentity {
  issuer: string;
  subject: string;
  sid?: string | null;
  /** Already sealed by the caller — this module never sees the raw ID token. */
  sealedIdToken?: string | null;
  amr: readonly string[];
}

/**
 * A session born from single sign-on, issued **already MFA-satisfied**.
 *
 * This is the only place besides the local second-factor verification that sets
 * `mfaSatisfiedAt`, and it does so in the same insert as the row itself, so there is no
 * window in which an SSO session exists unsatisfied. The caller (`src/lib/vibeAuth.ts`) is
 * responsible for having checked `amr` first and must not call this otherwise — §11, Q18.
 */
export async function issueSsoSession(
  userId: string,
  identity: OidcSessionIdentity,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      mfaSatisfiedAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      oidcIssuer: identity.issuer,
      oidcSubject: identity.subject,
      oidcSid: identity.sid ?? null,
      oidcIdToken: identity.sealedIdToken ?? null,
      oidcAmr: [...identity.amr],
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error('session insert returned no row');
  return { token, sessionId: row.id };
}

/**
 * Back-channel logout: end every live session matching the IdP's identity. `sid` is the
 * narrowest match and is preferred — but a session whose ID token carried no `sid` was stored
 * with `oidc_sid` NULL and can only be found by subject, so when the logout token names both,
 * those rows are matched by subject too. Missing one leaves a session alive for up to twelve
 * hours after the identity provider ended it. Falls back to subject, then to the user.
 */
export async function revokeSessionsByIdentity(match: {
  issuer: string;
  subject?: string | undefined;
  sid?: string | undefined;
  userId?: string | undefined;
}): Promise<number> {
  const live = and(isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()));
  const scope = match.sid
    ? and(
        eq(sessions.oidcIssuer, match.issuer),
        match.subject
          ? or(eq(sessions.oidcSid, match.sid), and(isNull(sessions.oidcSid), eq(sessions.oidcSubject, match.subject)))
          : eq(sessions.oidcSid, match.sid),
      )
    : match.subject
      ? and(eq(sessions.oidcIssuer, match.issuer), eq(sessions.oidcSubject, match.subject))
      : match.userId
        ? and(eq(sessions.oidcIssuer, match.issuer), eq(sessions.userId, match.userId))
        : null;
  if (!scope) return 0;
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(live, scope))
    .returning({ id: sessions.id });
  return rows.length;
}

/** The OIDC identity recorded on a session, for sign-out at the IdP. Null for a local one. */
export async function sessionOidcIdentity(
  sessionId: string,
): Promise<{ issuer: string; subject: string; sid: string | null; sealedIdToken: string | null; amr: string[] } | null> {
  const [row] = await db
    .select({
      issuer: sessions.oidcIssuer,
      subject: sessions.oidcSubject,
      sid: sessions.oidcSid,
      sealedIdToken: sessions.oidcIdToken,
      amr: sessions.oidcAmr,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row?.issuer || !row.subject) return null;
  return { issuer: row.issuer, subject: row.subject, sid: row.sid, sealedIdToken: row.sealedIdToken, amr: row.amr ?? [] };
}

export async function satisfyMfa(sessionId: string): Promise<void> {
  await db.update(sessions).set({ mfaSatisfiedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await db
    .select({
      sessionId: sessions.id,
      mfaSatisfiedAt: sessions.mfaSatisfiedAt,
      oidcIssuer: sessions.oidcIssuer,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.disabledAt) return null;

  return {
    id: row.userId,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    sessionId: row.sessionId,
    mfaSatisfied: row.mfaSatisfiedAt !== null,
    sso: row.oidcIssuer !== null,
  };
}
