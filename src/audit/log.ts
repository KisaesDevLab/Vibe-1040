/**
 * Access logging (§11, GLBA Safeguards).
 *
 * Every route that touches taxpayer data writes a row. P14 audits that claim route by
 * route, so the helper is deliberately cheap to call and hard to forget: `withAudit` wraps
 * a handler so the row is written even when the handler throws.
 *
 * Detail payloads carry field keys, ids, and before/after *values* for corrections. They
 * must never carry a plaintext TIN — `scrubDetail` drops anything that looks like one.
 */
import { db } from '../db/client.ts';
import { auditLog } from '../db/schema.ts';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.mfa_enrolled'
  | 'auth.logout'
  | 'bundle.upload'
  | 'bundle.view'
  | 'bundle.download_source'
  | 'bundle.identity_confirmed'
  | 'bundle.delete'
  | 'document.view'
  | 'page.raster_view'
  | 'field.correct'
  | 'check.disposition'
  | 'worksheet.generate'
  | 'worksheet.download'
  | 'retention.purge'
  | 'admin.user_create'
  | 'admin.user_update'
  | 'admin.user_disable'
  | 'admin.user_mfa_reset'
  | 'admin.user_password_set'
  | 'admin.setting_change'
  | 'admin.test_email'
  | 'admin.test_sms'
  | 'admin.audit_view'
  | 'admin.retention_run'
  | 'auth.phone_verified'
  | 'auth.password_reset_requested'
  | 'auth.password_reset_failed'
  | 'auth.password_reset_completed'
  | 'auth.password_changed'
  | 'auth.password_change_failed';

export interface AuditEntry {
  action: AuditAction;
  userId?: string | null | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  bundleId?: string | undefined;
  ip?: string | null | undefined;
  detail?: Record<string, unknown> | undefined;
}

/**
 * A 9-digit run is the shape we refuse to persist, keyword or not.
 *
 * Separators matter: forms print TINs with dashes, spaces, or neither, and a regex that
 * only knew about dashes would have written `123 45 6789` straight into the audit log.
 */
const TIN_SHAPED = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string' && TIN_SHAPED.test(value)) return '[REDACTED:TIN_SHAPED]';
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubValue(v)]));
  }
  return value;
}

export function scrubDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(detail) as Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    action: entry.action,
    userId: entry.userId ?? null,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    bundleId: entry.bundleId ?? null,
    ip: entry.ip ?? null,
    detail: scrubDetail(entry.detail ?? {}),
  });
}

/**
 * Run `fn` and audit the outcome either way. A failed access attempt is exactly the thing
 * an access log exists to record, so a throw still writes a row before rethrowing.
 */
export async function withAudit<T>(entry: AuditEntry, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    await audit(entry);
    return result;
  } catch (err) {
    await audit({
      ...entry,
      detail: { ...(entry.detail ?? {}), failed: true, error: (err as Error).message },
    });
    throw err;
  }
}
