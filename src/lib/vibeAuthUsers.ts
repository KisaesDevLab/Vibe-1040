/**
 * Vibe Auth user adapter and audit sink (P16).
 *
 * `@kisaesdevlab/vibe-auth` owns the OIDC protocol; this file is the part of single sign-on
 * that knows what a Vibe 1040 staff account is. It is also loaded on its own by the
 * break-glass CLI (`src/vibeAuthAdapter.ts`), so it must not import the HTTP server.
 *
 * Two kinds of account are created here and they are deliberately different:
 *
 * - A **just-in-time** user, created the first time someone signs in through the identity
 *   provider. It gets a password hash nobody knows the preimage of, and no local factor. It
 *   never needs one: its sessions arrive MFA-satisfied on the IdP's `amr` proof or do not
 *   arrive at all (QUESTIONS.md Q18). If the firm later runs in `both` mode and that person
 *   resets their password and signs in locally, the ordinary first-sign-in enrolment runs.
 * - The **break-glass** user, a real local admin with a real password. It is *not* exempt
 *   from the second factor. It enrols an authenticator through the same first-sign-in flow
 *   as the seeded admin — TOTP needs no SMTP, SMS or IdP, which is the outage it exists for.
 */
import { randomBytes } from 'node:crypto';
import type {
  AuditEvent,
  AuditSink,
  CreateLocalUserInput,
  CreateUserInput,
  UserAdapter,
  VibeUser,
} from '@kisaesdevlab/vibe-auth';
import { and, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { audit, type AuditAction } from '../audit/log.ts';
import { hashPassword } from '../auth/credentials.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';

export const PRODUCT_ROLES = ['admin', 'partner', 'staff'] as const;
export type ProductRole = (typeof PRODUCT_ROLES)[number];
export const ADMIN_ROLE: ProductRole = 'admin';

/**
 * This app signs people in by email and has no username column, so the break-glass account
 * is addressed by an email derived from Vibe Auth's username. `.local` rather than Vibe
 * Auth's suggested `@localhost`: the login route validates with zod's `.email()`, which
 * rejects a domain with no dot, and `appliance.local` is what the seeded admin already uses.
 */
export const BREAKGLASS_USERNAME = (process.env['VIBE_BREAKGLASS_USERNAME'] ?? '').trim() || 'vibe-breakglass';
export const BREAKGLASS_EMAIL = `${BREAKGLASS_USERNAME.toLowerCase()}@appliance.local`;

/** What someone may type into the sign-in form, resolved to the email the account lives under. */
export function resolveLoginEmail(identifier: string): string {
  const id = identifier.trim().toLowerCase();
  return id === BREAKGLASS_USERNAME.toLowerCase() ? BREAKGLASS_EMAIL : id;
}

/** The identifier Vibe Auth's local-login policy should judge: the username for break-glass. */
export function policyIdentifier(email: string): string {
  return email === BREAKGLASS_EMAIL ? BREAKGLASS_USERNAME : email;
}

/**
 * Case-insensitive match on the address. Not every stored row is lowercase — the seed wrote
 * SEED_ADMIN_EMAIL as typed until P16 — so comparing a lowercased input to the raw column
 * would silently miss those accounts. `email` must already be lowercased.
 */
export function emailMatches(email: string): SQL {
  return sql`lower(${users.email}) = ${email}`;
}

/**
 * An account that exists only because someone signed in through the identity provider: it
 * has an SSO link and has never enrolled a local second factor.
 *
 * Such an account must not be able to bootstrap a local sign-in by itself. Its second factor
 * lives at the IdP; locally it has none, and first-sign-in enrolment would hand one to
 * whoever holds the password. With self-service reset, "whoever holds the password" means
 * "whoever can read the mailbox" — one factor, defeating §11 for every just-in-time user,
 * permanently, since none of them ever enrols here. So reset is refused for these accounts
 * (`src/auth/password-reset.ts`). An admin can still give one a local password from
 * Admin → Users, which is the same trust an admin already exercises creating any account.
 */
export async function isSsoOnlyAccount(user: {
  id: string;
  totpConfirmedAt: Date | null;
  mfaEnrolledAt: Date | null;
}): Promise<boolean> {
  if (user.totpConfirmedAt !== null || user.mfaEnrolledAt !== null) return false;
  const linked = await db.execute(sql`select 1 from auth_identities where user_id = ${user.id} limit 1`);
  return linked.rows.length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isProductRole(role: string): role is ProductRole {
  return (PRODUCT_ROLES as readonly string[]).includes(role);
}

function requireProductRole(role: string): ProductRole {
  if (!isProductRole(role)) throw new Error(`vibe-auth handed back a role this app does not have: ${role}`);
  return role;
}

type UserRow = typeof users.$inferSelect;

function toVibeUser(row: UserRow): VibeUser {
  const isBreakglass = row.email === BREAKGLASS_EMAIL;
  return {
    id: row.id,
    email: row.email,
    name: row.displayName,
    role: row.role,
    active: row.disabledAt === null,
    ...(isBreakglass ? { local: true, username: BREAKGLASS_USERNAME } : {}),
  };
}

/** A hash of 48 random bytes that are then discarded. Nothing can sign in with it. */
async function unusablePasswordHash(): Promise<string> {
  return hashPassword(randomBytes(48).toString('base64url'));
}

export const vibeAuthUsers: UserAdapter = {
  async findById(id) {
    // The package passes back whatever it stored; a non-uuid would make Postgres throw.
    if (!UUID.test(id)) return null;
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toVibeUser(row) : null;
  },

  async findByEmail(email) {
    const [row] = await db.select().from(users).where(emailMatches(email.trim().toLowerCase())).limit(1);
    return row ? toVibeUser(row) : null;
  },

  async findByUsername(username) {
    return this.findByEmail(resolveLoginEmail(username));
  },

  async create(input: CreateUserInput) {
    const email = input.email.trim().toLowerCase();
    const [row] = await db
      .insert(users)
      .values({
        email,
        displayName: input.name?.trim() || email,
        role: requireProductRole(input.role),
        passwordHash: await unusablePasswordHash(),
        // The column is NOT NULL with this default; stated so the intent is on the page. No
        // secret and no enrolment timestamp — see the header.
        mfaMethod: 'totp',
      })
      .returning();
    if (!row) throw new Error('user insert returned no row');
    return toVibeUser(row);
  },

  async setRole(userId, role) {
    const next = requireProductRole(role);

    // Roles re-sync from the identity provider on every sign-in, including the first one of
    // an existing local account linked by email. If that account is the firm's only working
    // admin and its IdP groups map lower, syncing would leave nobody able to open
    // Admin → Users or Admin → Authentication to undo it — the lockout the admin route's
    // own `self_lockout` rule exists to prevent. Keep the role and say so. Break-glass does
    // not count as "another admin": it is an emergency account, not someone at a desk.
    if (next !== ADMIN_ROLE) {
      const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
      if (target?.role === ADMIN_ROLE) {
        const others = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, ADMIN_ROLE), isNull(users.disabledAt), ne(users.id, userId), ne(users.email, BREAKGLASS_EMAIL)))
          .limit(1);
        if (others.length === 0) {
          console.warn(
            `[vibe-auth] refused to sync role ${next} onto user ${userId}: it is the last active admin. ` +
              'Add the user to vibe-admin at the identity provider, or make another admin first.',
          );
          await audit({
            action: 'vibe.auth.role.changed',
            userId,
            detail: { refused: true, from: ADMIN_ROLE, to: next, why: 'last_active_admin', note: 'role kept; supersedes the adjacent role.changed row' },
          }).catch(() => undefined);
          return;
        }
      }
    }

    await db.update(users).set({ role: next, updatedAt: new Date() }).where(eq(users.id, userId));
  },

  async createLocalUser(input: CreateLocalUserInput) {
    const [row] = await db
      .insert(users)
      .values({
        // The package supplies an email from the CLI adapter's `breakglassEmail`; derive it
        // from the username regardless so the two cannot drift apart.
        email: resolveLoginEmail(input.username),
        displayName: input.name,
        role: requireProductRole(input.role),
        passwordHash: await hashPassword(input.password),
        mfaMethod: 'totp',
      })
      .returning();
    if (!row) throw new Error('user insert returned no row');
    return toVibeUser(row);
  },

  async setLocalPassword(userId, password) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
      .where(eq(users.id, userId));
  },

  async setActive(userId, active) {
    await db
      .update(users)
      .set({ disabledAt: active ? null : new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));
  },
};

/**
 * Vibe Auth's events, written through this app's own audit writer so they land in the same
 * table, behind the same TIN scrubber, as every other access record (§11).
 *
 * `audit_log.user_id` is a uuid with a foreign key, so an id is only promoted to the column
 * when it has that shape; everything the event carried stays in `detail` either way. Failures
 * are swallowed by design — the package's contract is that auditing never breaks a sign-in —
 * but they are logged, because a silent hole in an access log is its own finding.
 */
export const vibeAuthAudit: AuditSink = {
  async emit(event: AuditEvent) {
    const { type, at, ...rest } = event;
    const subject = rest['user_id'] ?? rest['actor'];
    const ip = rest['ip'];
    try {
      await audit({
        action: type satisfies AuditAction,
        userId: typeof subject === 'string' && UUID.test(subject) ? subject : null,
        ip: typeof ip === 'string' ? ip : null,
        detail: { ...rest, at },
      });
    } catch (err) {
      console.error(`[vibe-auth] audit write failed for ${type}: ${(err as Error).message}`);
    }
  },
};
