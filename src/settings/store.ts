/**
 * Reading and writing firm settings.
 *
 * Cached in process with a short TTL so a hot path like reconciliation is not doing a query
 * per check, and invalidated on write so an admin's change takes effect immediately rather
 * than "within a minute".
 *
 * Secrets are sealed with the same AES-256-GCM envelope as blob storage before they touch
 * the database, and `settingsForAdmin` never returns one — the UI shows whether a secret is
 * set, not what it is.
 */
import { eq } from 'drizzle-orm';
import { audit } from '../audit/log.ts';
import { db } from '../db/client.ts';
import { firmSettings } from '../db/schema.ts';
import { open, seal } from '../storage/index.ts';
import { SETTINGS, settingDef, type SettingDef } from './registry.ts';

const CACHE_TTL_MS = 30_000;
let cache: { at: number; values: Map<string, unknown> } | null = null;

function decode(def: SettingDef, raw: unknown): unknown {
  if (!def.secret) return raw;
  if (typeof raw !== 'string' || raw === '') return '';
  try {
    return open(Buffer.from(raw, 'base64')).toString('utf8');
  } catch {
    // A secret that will not decrypt means the blob key changed. Fail loud rather than
    // silently sending mail with an empty password.
    throw new Error(
      `setting '${def.key}' cannot be decrypted — STORAGE_ENCRYPTION_KEY may have changed. ` +
        'Re-enter it in Admin → Settings.',
    );
  }
}

async function load(): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;

  const rows = await db.select().from(firmSettings);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const values = new Map<string, unknown>();

  for (const def of SETTINGS) {
    const raw = stored.get(def.key);
    // Unset settings fall back to the environment, so an existing deployment keeps behaving
    // exactly as its .env said until someone changes it.
    values.set(def.key, raw === undefined ? def.default() : decode(def as SettingDef, raw));
  }

  cache = { at: Date.now(), values };
  return values;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

/** Typed read. Throws on an unknown key rather than returning undefined. */
export async function setting<T = unknown>(key: string): Promise<T> {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  const values = await load();
  return values.get(key) as T;
}

export async function settings(): Promise<Record<string, unknown>> {
  return Object.fromEntries(await load());
}

/**
 * Cross-setting validation.
 *
 * Individual schemas cannot express "page images must not outlive their sources" — that is
 * a §11 obligation about the relationship between two values, and it is enforced here as
 * well as in `config/env.ts` so neither path can violate it.
 */
function validateCombination(next: Map<string, unknown>): void {
  const raster = next.get('retention.raster_days') as number;
  const documents = next.get('retention.document_days') as number;
  if (raster > documents) {
    throw new Error(
      'Page image retention must not exceed source document retention — page images are ' +
        'derived PII and purge earlier than their sources (§11).',
    );
  }

  const allowed = next.get('auth.allowed_mfa_methods') as string[];
  if (allowed.includes('email') && !next.get('email.enabled')) {
    throw new Error('Email is a permitted second factor but email delivery is disabled.');
  }
  if (allowed.includes('sms') && !next.get('sms.enabled')) {
    throw new Error('SMS is a permitted second factor but SMS delivery is disabled.');
  }
  if (next.get('email.enabled') && !String(next.get('email.host') ?? '')) {
    throw new Error('Email is enabled but no SMTP host is configured.');
  }
  if (next.get('sms.enabled') && !String(next.get('sms.from_number') ?? '')) {
    throw new Error('SMS is enabled but no from number is configured.');
  }
}

export interface SettingUpdate {
  key: string;
  value: unknown;
}

/**
 * Apply a batch of changes atomically-ish and audit each one.
 *
 * Secret values are never written to the audit detail — the log records that a secret
 * changed, not what it changed to.
 */
export async function updateSettings(
  updates: readonly SettingUpdate[],
  actor: { id: string; ip?: string | null },
): Promise<void> {
  const current = new Map(await load());
  const parsed: { def: SettingDef; value: unknown }[] = [];

  for (const update of updates) {
    const def = settingDef(update.key);
    if (!def) throw new Error(`unknown setting: ${update.key}`);

    // An untouched secret arrives as the sentinel and must not overwrite the stored value.
    if (def.secret && update.value === UNCHANGED_SECRET) continue;

    const result = def.schema.safeParse(update.value);
    if (!result.success) {
      throw new Error(`${def.label}: ${result.error.issues[0]?.message ?? 'invalid value'}`);
    }
    parsed.push({ def, value: result.data });
    current.set(def.key, result.data);
  }

  validateCombination(current);

  for (const { def, value } of parsed) {
    const before = (await load()).get(def.key);
    const stored = def.secret
      ? seal(Buffer.from(String(value), 'utf8')).toString('base64')
      : value;

    await db
      .insert(firmSettings)
      .values({
        key: def.key,
        value: stored as never,
        isSecret: def.secret ?? false,
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: firmSettings.key,
        set: { value: stored as never, updatedBy: actor.id, updatedAt: new Date() },
      });

    await audit({
      action: 'admin.setting_change',
      userId: actor.id,
      ip: actor.ip ?? null,
      entityType: 'firm_setting',
      detail: def.secret
        ? { key: def.key, changed: true, secret: true }
        : { key: def.key, before, after: value },
    });
  }

  invalidateSettingsCache();
}

/** Placeholder the UI submits for a secret the admin did not retype. */
export const UNCHANGED_SECRET = '__unchanged__';

/** Admin-facing view. Secrets report only whether they are set. */
export async function settingsForAdmin(): Promise<
  { key: string; group: string; label: string; help: string; input: string; options?: readonly string[]; value: unknown; secret: boolean; isSet: boolean }[]
> {
  const values = await load();
  return SETTINGS.map((def) => {
    const value = values.get(def.key);
    const isSet = def.secret ? String(value ?? '') !== '' : true;
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      help: def.help,
      input: def.input,
      ...(def.options ? { options: def.options } : {}),
      value: def.secret ? (isSet ? UNCHANGED_SECRET : '') : value,
      secret: def.secret ?? false,
      isSet,
    };
  });
}
