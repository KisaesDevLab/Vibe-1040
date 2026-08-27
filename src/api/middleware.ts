/**
 * Request-level auth and audit (P0, §11).
 *
 * `requireUser` enforces MFA, not just authentication: a session that has not satisfied
 * TOTP is rejected. GLBA Safeguards requires MFA on staff accounts, and an app that issues
 * a usable session before the second factor has not met it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { audit, type AuditAction } from '../audit/log.ts';
import { SESSION_COOKIE, resolveSession, type SessionUser } from '../auth/session.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function attachUser(req: FastifyRequest): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  const user = await resolveSession(token);
  if (user) req.user = user;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
  if (!req.user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  if (!req.user.mfaSatisfied) {
    await reply.code(403).send({ error: 'mfa_required', message: 'Complete the second factor to continue.' });
    return null;
  }
  return req.user;
}

export async function requireRole(
  req: FastifyRequest,
  reply: FastifyReply,
  roles: readonly SessionUser['role'][],
): Promise<SessionUser | null> {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (!roles.includes(user.role)) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return user;
}

/**
 * Audit a taxpayer-data access. Every route in `routes.ts` that reads or writes taxpayer
 * data calls this — P14's audit pass checks that claim route by route.
 */
export async function auditAccess(
  req: FastifyRequest,
  action: AuditAction,
  entity: {
    entityType?: string | undefined;
    entityId?: string | undefined;
    bundleId?: string | undefined;
    detail?: Record<string, unknown> | undefined;
  } = {},
): Promise<void> {
  await audit({
    action,
    userId: req.user?.id ?? null,
    ip: req.ip,
    ...entity,
  });
}
