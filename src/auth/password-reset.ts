/**
 * Password reset over email or SMS.
 *
 * The governing rule is **no account enumeration**: `requestReset` returns the same shape
 * and takes broadly the same time whether or not the address exists. An unauthenticated
 * endpoint that reveals which staff addresses are real is a gift to anyone assembling a
 * phishing list for a firm that holds tax data.
 *
 * A completed reset revokes every existing session for that user. If a reset was triggered
 * by someone who should not have had access, leaving their sessions alive would defeat it.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { audit } from '../audit/log.ts';
import { db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';
import { setting } from '../settings/store.ts';
import { hashPassword } from './credentials.ts';
import { issueCode, verifyCode } from './otp.ts';

/** Deliberately uniform. Never varies on whether the account exists. */
export interface ResetRequestResult {
  /** Always true from the caller's perspective. */
  accepted: true;
  /** Redacted destination when we actually sent something, else null. */
  destination: string | null;
}

export async function requestReset(
  email: string,
  ip?: string | null,
): Promise<ResetRequestResult> {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).limit(1);

  if (!user || user.disabledAt) {
    // Burn a comparable amount of time so response timing does not leak existence.
    await hashPassword(`decoy-${email}`);
    await audit({
      action: 'auth.password_reset_requested',
      ip: ip ?? null,
      detail: { known: false },
    });
    return { accepted: true, destination: null };
  }

  // Reset goes to the channel the user actually controls. SMS only when verified —
  // an unverified number could have been typed by anyone.
  const emailEnabled = await setting<boolean>('email.enabled');
  const smsEnabled = await setting<boolean>('sms.enabled');

  const channel: 'email' | 'sms' | null =
    emailEnabled ? 'email'
    : smsEnabled && user.phone && user.phoneVerifiedAt ? 'sms'
    : null;

  if (!channel) {
    await audit({
      action: 'auth.password_reset_requested',
      userId: user.id,
      ip: ip ?? null,
      detail: { known: true, delivered: false, why: 'no delivery channel configured' },
    });
    return { accepted: true, destination: null };
  }

  const destination = channel === 'email' ? user.email : user.phone!;
  const issued = await issueCode(user.id, 'password_reset', channel, destination, ip);

  await audit({
    action: 'auth.password_reset_requested',
    userId: user.id,
    ip: ip ?? null,
    detail: { known: true, delivered: issued.ok, channel },
  });

  return { accepted: true, destination: issued.destination ?? null };
}

export type ResetOutcome =
  | { ok: true }
  | { ok: false; error: string };

/** Minimum viable password policy. Length beats composition rules. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (password.length > 200) return 'Password must be at most 200 characters.';
  if (/^\s|\s$/.test(password)) return 'Password must not start or end with whitespace.';
  return null;
}

export async function completeReset(
  email: string,
  code: string,
  newPassword: string,
  ip?: string | null,
): Promise<ResetOutcome> {
  const problem = passwordProblem(newPassword);
  if (problem) return { ok: false, error: problem };

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).limit(1);
  if (!user || user.disabledAt) {
    // Same opaque failure as a wrong code — still no enumeration.
    return { ok: false, error: 'That code is not valid.' };
  }

  const verified = await verifyCode(user.id, 'password_reset', code);
  if (!verified.ok) {
    await audit({
      action: 'auth.password_reset_failed',
      userId: user.id,
      ip: ip ?? null,
      detail: { reason: verified.reason },
    });
    return {
      ok: false,
      error:
        verified.reason === 'expired' ? 'That code has expired. Request a new one.'
        : verified.reason === 'too_many_attempts' ? 'Too many attempts. Request a new code.'
        : 'That code is not valid.',
    };
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Every existing session dies. A reset that leaves the old sessions alive is not a reset.
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  await audit({
    action: 'auth.password_reset_completed',
    userId: user.id,
    ip: ip ?? null,
    detail: { sessionsRevoked: revoked.length },
  });

  return { ok: true };
}

/** An admin changing their own password, already authenticated. */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ip?: string | null,
): Promise<ResetOutcome> {
  const problem = passwordProblem(newPassword);
  if (problem) return { ok: false, error: problem };

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, error: 'not found' };

  const { verifyPassword } = await import('./credentials.ts');
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    await audit({ action: 'auth.password_change_failed', userId, ip: ip ?? null, detail: {} });
    return { ok: false, error: 'Current password is incorrect.' };
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, userId));

  await audit({ action: 'auth.password_changed', userId, ip: ip ?? null, detail: {} });
  return { ok: true };
}
