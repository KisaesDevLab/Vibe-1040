/**
 * Admin surface (Settings, Users, Audit, Retention) and the email/SMS auth flows.
 *
 * Everything here is admin-gated except the unauthenticated password-reset endpoints, which
 * are deliberately uniform in their responses so they cannot be used to enumerate staff
 * accounts.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit/log.ts';
import { hashPassword, generateTotpSecret, totpUri, verifyTotp } from '../auth/credentials.ts';
import { factorDestination, issueCode, verifyCode } from '../auth/otp.ts';
import { changeOwnPassword, completeReset, passwordProblem, requestReset } from '../auth/password-reset.ts';
import { satisfyMfa } from '../auth/session.ts';
import { db } from '../db/client.ts';
import { auditLog, notificationLog, users } from '../db/schema.ts';
import { normalizePhone, verifyEmail } from '../notify/channels.ts';
import { retentionForecast, runRetention } from '../retention/purge.ts';
import { readOnlyEnvironment } from '../settings/registry.ts';
import { settingsForAdmin, updateSettings } from '../settings/store.ts';
import { auditAccess, requireRole, requireUser } from './middleware.ts';

export function registerAdminRoutes(app: FastifyInstance): void {
  // ── settings ───────────────────────────────────────────────────────────────
  app.get('/api/admin/settings', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin']);
    if (!user) return;
    return { settings: await settingsForAdmin(), environment: readOnlyEnvironment() };
  });

  app.patch('/api/admin/settings', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin']);
    if (!user) return;
    const body = z
      .object({ updates: z.array(z.object({ key: z.string(), value: z.unknown() }).transform((u) => ({ key: u.key, value: u.value }))) })
      .parse(req.body);

    try {
      await updateSettings(body.updates, { id: user.id, ip: req.ip });
      return { ok: true, settings: await settingsForAdmin() };
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_settings', message: (err as Error).message });
    }
  });

  /** Prove the mail relay works before staff depend on it at a login prompt. */
  app.post('/api/admin/settings/test-email', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin']);
    if (!user) return;
    const body = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});

    const verified = await verifyEmail();
    if (!verified.ok) return reply.code(400).send({ ok: false, error: verified.error });

    const { sendEmail } = await import('../notify/channels.ts');
    const result = await sendEmail(
      body.to ?? user.email,
      'Vibe 1040 test message',
      'This is a test from Vibe 1040. If you received it, email delivery is configured correctly.',
    );
    await audit({ action: 'admin.test_email', userId: user.id, ip: req.ip, detail: { ok: result.ok } });
    return result.ok ? { ok: true } : reply.code(400).send({ ok: false, error: result.error });
  });

  app.post('/api/admin/settings/test-sms', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin']);
    if (!user) return;
    const body = z.object({ to: z.string() }).parse(req.body);

    const { sendSms } = await import('../notify/channels.ts');
    const result = await sendSms(body.to, 'Vibe 1040 test message. SMS delivery is configured correctly.');
    await audit({ action: 'admin.test_sms', userId: user.id, ip: req.ip, detail: { ok: result.ok } });
    return result.ok ? { ok: true } : reply.code(400).send({ ok: false, error: result.error });
  });

  // ── users ──────────────────────────────────────────────────────────────────
  app.get('/api/admin/users', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin']);
    if (!user) return;
    return db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        mfaMethod: users.mfaMethod,
        mfaEnrolled: sql<boolean>`(${users.totpConfirmedAt} is not null or ${users.mfaEnrolledAt} is not null)`,
        phone: users.phone,
        phoneVerified: sql<boolean>`${users.phoneVerifiedAt} is not null`,
        disabledAt: users.disabledAt,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.email);
  });

  app.post('/api/admin/users', async (req, reply) => {
    const admin = await requireRole(req, reply, ['admin']);
    if (!admin) return;
    const body = z
      .object({
        email: z.string().email(),
        displayName: z.string().min(1).max(120),
        role: z.enum(['admin', 'partner', 'staff']),
        password: z.string(),
        mfaMethod: z.enum(['totp', 'email', 'sms']).default('totp'),
        phone: z.string().optional(),
      })
      .parse(req.body);

    const problem = passwordProblem(body.password);
    if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });

    const phone = body.phone ? normalizePhone(body.phone) : null;
    if (body.phone && !phone) {
      return reply.code(400).send({ error: 'invalid_phone', message: 'Use E.164, e.g. +14175550100.' });
    }
    if (body.mfaMethod === 'sms' && !phone) {
      return reply.code(400).send({ error: 'invalid_phone', message: 'SMS second factor needs a phone number.' });
    }

    try {
      const [created] = await db
        .insert(users)
        .values({
          email: body.email.toLowerCase().trim(),
          displayName: body.displayName,
          role: body.role,
          passwordHash: await hashPassword(body.password),
          mfaMethod: body.mfaMethod,
          phone,
        })
        .returning({ id: users.id });

      await audit({
        action: 'admin.user_create',
        userId: admin.id,
        ip: req.ip,
        entityType: 'user',
        entityId: created!.id,
        detail: { email: body.email, role: body.role, mfaMethod: body.mfaMethod },
      });
      return reply.code(201).send({ id: created!.id });
    } catch (err) {
      if (String((err as Error).message).includes('unique')) {
        return reply.code(409).send({ error: 'duplicate', message: 'That email already exists.' });
      }
      throw err;
    }
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const admin = await requireRole(req, reply, ['admin']);
    if (!admin) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        displayName: z.string().min(1).max(120).optional(),
        role: z.enum(['admin', 'partner', 'staff']).optional(),
        mfaMethod: z.enum(['totp', 'email', 'sms']).optional(),
        phone: z.string().nullable().optional(),
        disabled: z.boolean().optional(),
      })
      .parse(req.body);

    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) return reply.code(404).send({ error: 'not found' });

    // An admin who disables or demotes themselves can lock the firm out of its own
    // appliance. Refuse rather than be helpful.
    if (target.id === admin.id && (body.disabled === true || (body.role && body.role !== 'admin'))) {
      return reply.code(400).send({
        error: 'self_lockout',
        message: 'You cannot disable or demote your own admin account. Ask another admin.',
      });
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.displayName !== undefined) patch['displayName'] = body.displayName;
    if (body.role !== undefined) patch['role'] = body.role;
    if (body.disabled !== undefined) patch['disabledAt'] = body.disabled ? new Date() : null;

    if (body.phone !== undefined) {
      const phone = body.phone ? normalizePhone(body.phone) : null;
      if (body.phone && !phone) {
        return reply.code(400).send({ error: 'invalid_phone', message: 'Use E.164, e.g. +14175550100.' });
      }
      patch['phone'] = phone;
      // Changing the number invalidates its verification — otherwise an admin could point a
      // verified factor at any number they liked.
      patch['phoneVerifiedAt'] = null;
    }

    if (body.mfaMethod !== undefined) {
      patch['mfaMethod'] = body.mfaMethod;
      // Switching factor means re-enrolling. MFA stays mandatory; only the method changes.
      patch['mfaEnrolledAt'] = null;
      if (body.mfaMethod !== 'totp') {
        patch['totpSecret'] = null;
        patch['totpConfirmedAt'] = null;
      }
    }

    await db.update(users).set(patch).where(eq(users.id, id));
    await audit({
      action: body.disabled === true ? 'admin.user_disable' : 'admin.user_update',
      userId: admin.id,
      ip: req.ip,
      entityType: 'user',
      entityId: id,
      detail: { changes: Object.keys(body) },
    });
    return { ok: true };
  });

  /** Clear a lost authenticator so the user can enrol again at next sign-in. */
  app.post('/api/admin/users/:id/reset-mfa', async (req, reply) => {
    const admin = await requireRole(req, reply, ['admin']);
    if (!admin) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    await db
      .update(users)
      .set({ totpSecret: null, totpConfirmedAt: null, mfaEnrolledAt: null, updatedAt: new Date() })
      .where(eq(users.id, id));

    await audit({
      action: 'admin.user_mfa_reset',
      userId: admin.id,
      ip: req.ip,
      entityType: 'user',
      entityId: id,
      detail: {},
    });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/set-password', async (req, reply) => {
    const admin = await requireRole(req, reply, ['admin']);
    if (!admin) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ password: z.string() }).parse(req.body);

    const problem = passwordProblem(body.password);
    if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.password), updatedAt: new Date() })
      .where(eq(users.id, id));

    await audit({
      action: 'admin.user_password_set',
      userId: admin.id,
      ip: req.ip,
      entityType: 'user',
      entityId: id,
      detail: {},
    });
    return { ok: true };
  });

  // ── audit ──────────────────────────────────────────────────────────────────
  app.get('/api/admin/audit', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin', 'partner']);
    if (!user) return;
    const q = z
      .object({
        action: z.string().optional(),
        userId: z.string().uuid().optional(),
        bundleId: z.string().uuid().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const conditions = [
      q.action ? ilike(auditLog.action, `${q.action}%`) : undefined,
      q.userId ? eq(auditLog.userId, q.userId) : undefined,
      q.bundleId ? eq(auditLog.bundleId, q.bundleId) : undefined,
      q.from ? gte(auditLog.at, new Date(q.from)) : undefined,
      q.to ? lte(auditLog.at, new Date(q.to)) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        bundleId: auditLog.bundleId,
        ip: auditLog.ip,
        detail: auditLog.detail,
        actorEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(where)
      .orderBy(desc(auditLog.at))
      .limit(q.limit)
      .offset(q.offset);

    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(where);

    // Reading the access log is itself an access worth logging.
    await auditAccess(req, 'admin.audit_view', { detail: { filters: q } });

    return { rows, total: count?.n ?? 0 };
  });

  app.get('/api/admin/audit/actions', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin', 'partner']);
    if (!user) return;
    const rows = await db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .orderBy(auditLog.action);
    return rows.map((r) => r.action);
  });

  app.get('/api/admin/notifications', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin']);
    if (!user) return;
    return db.select().from(notificationLog).orderBy(desc(notificationLog.at)).limit(100);
  });

  // ── retention ──────────────────────────────────────────────────────────────
  app.get('/api/admin/retention', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin', 'partner']);
    if (!user) return;
    return retentionForecast();
  });

  app.post('/api/admin/retention/run', async (req, reply) => {
    const user = await requireRole(req, reply, ['admin']);
    if (!user) return;
    const summary = await runRetention();
    await audit({ action: 'admin.retention_run', userId: user.id, ip: req.ip, detail: { ...summary } });
    return summary;
  });

  // ── second factor: email and SMS ───────────────────────────────────────────

  /** Send a code to whichever factor the signed-in-but-unverified user is enrolled on. */
  app.post('/api/auth/mfa/send', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });

    const factor = await factorDestination(req.user.id);
    if (factor.channel === 'totp') {
      return reply.code(400).send({ error: 'totp', message: 'Use your authenticator app.' });
    }
    if (!factor.usable || !factor.destination) {
      return reply.code(400).send({ error: 'unusable_factor', message: factor.why ?? 'factor unavailable' });
    }

    const result = await issueCode(req.user.id, 'mfa', factor.channel, factor.destination, req.ip);
    if (!result.ok) return reply.code(502).send({ error: 'delivery_failed', message: result.error });
    return { ok: true, destination: result.destination, channel: factor.channel };
  });

  /** Verify an emailed or texted code. TOTP keeps its own endpoint. */
  app.post('/api/auth/mfa/verify-code', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
    const body = z.object({ code: z.string().min(4).max(12) }).parse(req.body);

    const outcome = await verifyCode(req.user.id, 'mfa', body.code);
    if (!outcome.ok) {
      await auditAccess(req, 'auth.login_failed', { detail: { stage: 'mfa_code', reason: outcome.reason } });
      return reply.code(401).send({
        error: outcome.reason,
        message:
          outcome.reason === 'expired' ? 'That code expired. Request a new one.'
          : outcome.reason === 'too_many_attempts' ? 'Too many attempts. Request a new code.'
          : outcome.reason === 'no_challenge' ? 'Request a code first.'
          : 'That code is not correct.',
      });
    }

    await db
      .update(users)
      .set({ mfaEnrolledAt: new Date(), lastLoginAt: new Date() })
      .where(eq(users.id, req.user.id));
    await satisfyMfa(req.user.sessionId);
    await auditAccess(req, 'auth.login', { detail: { method: 'code' } });
    return { ok: true };
  });

  /** Verify a phone number before it can carry a second factor. */
  app.post('/api/auth/phone/send', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!row?.phone) return reply.code(400).send({ error: 'no_phone', message: 'No phone number on file.' });

    const result = await issueCode(user.id, 'phone_verify', 'sms', row.phone, req.ip);
    if (!result.ok) return reply.code(502).send({ error: 'delivery_failed', message: result.error });
    return { ok: true, destination: result.destination };
  });

  app.post('/api/auth/phone/verify', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ code: z.string() }).parse(req.body);

    const outcome = await verifyCode(user.id, 'phone_verify', body.code);
    if (!outcome.ok) return reply.code(401).send({ error: outcome.reason });

    await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, user.id));
    await auditAccess(req, 'auth.phone_verified');
    return { ok: true };
  });

  // ── password reset (unauthenticated, deliberately uniform) ─────────────────
  app.post('/api/auth/forgot', async (req, reply) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    await requestReset(body.email, req.ip);
    /**
     * Always 200, always byte-identical.
     *
     * An earlier version returned the redacted destination, which was an enumeration
     * oracle in everything but name: a real address came back with "p***@example.test"
     * and an unknown one with null. Anyone could sort a list of guessed staff addresses
     * into real and not-real. The redacted destination is now shown only on the *next*
     * screen, after a code has been entered, where the user has already proved they
     * received it.
     */
    return reply.code(200).send({
      accepted: true,
      message:
        'If that address belongs to an account, a reset code has been sent to it. ' +
        'Check your email or messages for a six-digit code.',
    });
  });

  app.post('/api/auth/reset', async (req, reply) => {
    const body = z
      .object({ email: z.string().email(), code: z.string(), password: z.string() })
      .parse(req.body);
    const result = await completeReset(body.email, body.code, body.password, req.ip);
    if (!result.ok) return reply.code(400).send({ error: 'reset_failed', message: result.error });
    return { ok: true };
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(req.body);
    const result = await changeOwnPassword(user.id, body.currentPassword, body.newPassword, req.ip);
    if (!result.ok) return reply.code(400).send({ error: 'change_failed', message: result.error });
    return { ok: true };
  });

  /** What the current user needs to do to satisfy their second factor. */
  app.get('/api/auth/factor', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
    const factor = await factorDestination(req.user.id);
    const [row] = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
    return {
      method: row?.mfaMethod ?? 'totp',
      usable: factor.usable,
      why: factor.why ?? null,
      enrolled: row?.totpConfirmedAt !== null || row?.mfaEnrolledAt !== null,
      needsTotpEnrolment: row?.mfaMethod === 'totp' && row?.totpConfirmedAt === null,
    };
  });

  /** TOTP enrolment, unchanged in behaviour but re-exposed for the new factor picker. */
  app.post('/api/auth/totp/enroll', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
    const [row] = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
    if (!row) return reply.code(401).send({ error: 'authentication required' });
    if (row.totpConfirmedAt) return reply.code(409).send({ error: 'already enrolled' });

    const secret = generateTotpSecret();
    await db.update(users).set({ totpSecret: secret, updatedAt: new Date() }).where(eq(users.id, row.id));
    return { secret, uri: totpUri(secret, row.email) };
  });

  app.post('/api/auth/totp/verify', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
    const body = z.object({ token: z.string() }).parse(req.body);
    const [row] = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
    if (!row?.totpSecret) return reply.code(400).send({ error: 'not enrolled' });

    if (!verifyTotp(row.totpSecret, body.token)) {
      await auditAccess(req, 'auth.login_failed', { detail: { stage: 'totp' } });
      return reply.code(401).send({ error: 'invalid code' });
    }

    if (!row.totpConfirmedAt) {
      await db.update(users).set({ totpConfirmedAt: new Date() }).where(eq(users.id, row.id));
      await auditAccess(req, 'auth.mfa_enrolled');
    }
    await db.update(users).set({ mfaEnrolledAt: new Date(), lastLoginAt: new Date() }).where(eq(users.id, row.id));
    await satisfyMfa(req.user.sessionId);
    await auditAccess(req, 'auth.login', { detail: { method: 'totp' } });
    return { ok: true };
  });
}
