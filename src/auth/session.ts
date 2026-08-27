/**
 * Session issue/verify (P0). Opaque random token in an httpOnly cookie; only its SHA-256
 * is stored, so a database read cannot mint a session.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';

export const SESSION_COOKIE = 'v1040_session';
const TTL_MS = 12 * 60 * 60 * 1000; // one working day

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'partner' | 'staff';
  sessionId: string;
  mfaSatisfied: boolean;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Issued pre-MFA: `mfaSatisfiedAt` stays null until the TOTP step succeeds. */
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
  };
}
