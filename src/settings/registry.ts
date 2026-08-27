/**
 * Firm settings (§13: firm-specific configuration lives in config, not code).
 *
 * The split is deliberate and load-bearing:
 *
 *  - **Firm policy** — tolerance, retention windows, pass counts, notification channels —
 *    lives in the database, is editable by an admin without shell access, is audited on
 *    every change, and takes effect without a restart.
 *  - **Infrastructure and key material** — database URLs, the TIN salt, the blob key, the
 *    router token — stays in the environment. A web form is the wrong place for a
 *    decryption key, and an admin account compromise must not yield one.
 *  - **Compliance guardrails** — `ROUTER_REQUIRE_US_REGION`, `ROUTER_EXPECTED_SENSITIVITY` —
 *    stay in the environment too, and are shown read-only in the UI. They are the controls
 *    that keep taxpayer data inside US inference (§11); making them a toggle would make
 *    turning off the guarantee as easy as clicking a switch.
 *
 * Every setting seeds from the matching environment variable on first read, so an existing
 * deployment keeps behaving exactly as its `.env` said until someone changes it.
 */
import { z } from 'zod';
import { env } from '../config/env.ts';

export type SettingGroup = 'reconciliation' | 'retention' | 'extraction' | 'rasterization' | 'email' | 'sms' | 'authentication' | 'licensing';

export interface SettingDef<T = unknown> {
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
  schema: z.ZodType<T>;
  default: () => T;
  /** Sealed before storage and never returned to the UI in plaintext. */
  secret?: boolean;
  /** Renders as a password/number/checkbox/select in the admin UI. */
  input: 'text' | 'password' | 'number' | 'boolean' | 'select';
  options?: readonly string[];
  /** Restarting is not required, but some values only bite on the next job. */
  note?: string;
}

const def = <T>(d: SettingDef<T>): SettingDef<T> => d;

export const SETTINGS = [
  // ── reconciliation ─────────────────────────────────────────────────────────
  def({
    key: 'reconcile.tolerance_cents',
    group: 'reconciliation',
    label: 'Rounding tolerance (cents)',
    help:
      'Per-document tolerance when checking arithmetic. $1.00 = 100. Widening this makes ' +
      'the arithmetic gate weaker — do not raise it to make a stubborn bundle pass (§6).',
    schema: z.number().int().nonnegative().max(10_000),
    default: () => env.RECONCILE_TOLERANCE_CENTS,
    input: 'number',
  }),

  // ── retention ──────────────────────────────────────────────────────────────
  def({
    key: 'retention.raster_days',
    group: 'retention',
    label: 'Page image retention (days)',
    help:
      'Rasterized page images are derived PII and purge on their own clock, earlier than ' +
      'the documents they came from (§11). Must not exceed document retention.',
    schema: z.number().int().positive().max(3_650),
    default: () => env.RETENTION_RASTER_DAYS,
    input: 'number',
  }),
  def({
    key: 'retention.document_days',
    group: 'retention',
    label: 'Source document retention (days)',
    help: 'Typical workpaper retention is seven years (2555 days). Confirm against firm policy.',
    schema: z.number().int().positive().max(36_500),
    default: () => env.RETENTION_DOCUMENT_DAYS,
    input: 'number',
  }),
  def({
    key: 'retention.dry_run',
    group: 'retention',
    label: 'Dry run',
    help: 'Log what would be purged without deleting anything. Useful before the first real run.',
    schema: z.boolean(),
    default: () => env.RETENTION_DRY_RUN,
    input: 'boolean',
  }),

  // ── extraction ─────────────────────────────────────────────────────────────
  def({
    key: 'extract.passes',
    group: 'extraction',
    label: 'Extraction passes',
    help:
      'Multi-pass agreement is the ONLY confidence signal available — the router surfaces ' +
      'no per-field confidence. Setting this to 1 removes the only misread detection the ' +
      'system has. Each pass costs one inference per document.',
    schema: z.number().int().min(1).max(5),
    default: () => env.EXTRACT_PASSES,
    input: 'number',
  }),
  def({
    key: 'extract.passes_on_disagreement',
    group: 'extraction',
    label: 'Passes on disagreement',
    help: 'Escalate to this many passes when the first passes disagree. Majority wins.',
    schema: z.number().int().min(1).max(7),
    default: () => env.EXTRACT_PASSES_ON_DISAGREEMENT,
    input: 'number',
  }),

  // ── rasterization ──────────────────────────────────────────────────────────
  def({
    key: 'raster.dpi_default',
    group: 'rasterization',
    label: 'Default DPI',
    help: 'Baseline render resolution for pages without a usable text layer.',
    schema: z.number().int().min(72).max(600),
    default: () => env.RASTER_DPI_DEFAULT,
    input: 'number',
  }),
  def({
    key: 'raster.dpi_digital',
    group: 'rasterization',
    label: 'Digital PDF DPI',
    help: 'Lower resolution is sufficient for clean, native PDFs.',
    schema: z.number().int().min(72).max(600),
    default: () => env.RASTER_DPI_DIGITAL,
    input: 'number',
  }),
  def({
    key: 'raster.dpi_degraded',
    group: 'rasterization',
    label: 'Degraded scan DPI',
    help: 'Higher resolution for scans with a garbled or missing text layer.',
    schema: z.number().int().min(72).max(900),
    default: () => env.RASTER_DPI_DEGRADED,
    input: 'number',
  }),
  def({
    key: 'raster.max_edge_px',
    group: 'rasterization',
    label: 'Maximum edge (pixels)',
    help:
      'Pages are downscaled to this before encoding. Raising it inflates every request body ' +
      'sent to the router without necessarily helping accuracy.',
    schema: z.number().int().min(600).max(6_000),
    default: () => env.RASTER_MAX_EDGE_PX,
    input: 'number',
  }),
  def({
    key: 'raster.jpeg_quality',
    group: 'rasterization',
    label: 'JPEG quality',
    help: 'Grayscale JPEG quality, 1–100. Below about 70, small print starts to suffer.',
    schema: z.number().int().min(1).max(100),
    default: () => env.RASTER_JPEG_QUALITY,
    input: 'number',
  }),

  // ── email ──────────────────────────────────────────────────────────────────
  def({
    key: 'email.enabled',
    group: 'email',
    label: 'Enable email',
    help: 'Required for email second factors and for password reset links.',
    schema: z.boolean(),
    default: () => false,
    input: 'boolean',
  }),
  def({
    key: 'email.host',
    group: 'email',
    label: 'SMTP host',
    help: 'Hostname of the firm mail relay.',
    schema: z.string().max(255),
    default: () => '',
    input: 'text',
  }),
  def({
    key: 'email.port',
    group: 'email',
    label: 'SMTP port',
    help: '587 for STARTTLS, 465 for implicit TLS, 25 for an internal relay.',
    schema: z.number().int().min(1).max(65_535),
    default: () => 587,
    input: 'number',
  }),
  def({
    key: 'email.secure',
    group: 'email',
    label: 'Implicit TLS',
    help: 'On for port 465. Off for 587, which upgrades via STARTTLS.',
    schema: z.boolean(),
    default: () => false,
    input: 'boolean',
  }),
  def({
    key: 'email.username',
    group: 'email',
    label: 'SMTP username',
    help: 'Leave blank for an unauthenticated internal relay.',
    schema: z.string().max(255),
    default: () => '',
    input: 'text',
  }),
  def({
    key: 'email.password',
    group: 'email',
    label: 'SMTP password',
    help: 'Sealed with the blob encryption key before storage. Never displayed once saved.',
    schema: z.string().max(1_024),
    default: () => '',
    secret: true,
    input: 'password',
  }),
  def({
    key: 'email.from',
    group: 'email',
    label: 'From address',
    help: 'Must be a mailbox the relay will accept, e.g. no-reply@yourfirm.com.',
    schema: z.string().max(320),
    default: () => '',
    input: 'text',
  }),

  // ── sms ────────────────────────────────────────────────────────────────────
  def({
    key: 'sms.enabled',
    group: 'sms',
    label: 'Enable SMS',
    help:
      'Required for SMS second factors. Note that SMS is the weakest second factor on ' +
      'offer — it is vulnerable to SIM swap and carrier interception in a way TOTP is not.',
    schema: z.boolean(),
    default: () => false,
    input: 'boolean',
  }),
  def({
    key: 'sms.provider',
    group: 'sms',
    label: 'Provider',
    help: 'Twilio, or any gateway exposing a Twilio-compatible REST endpoint.',
    schema: z.enum(['twilio', 'generic']),
    default: () => 'twilio' as const,
    input: 'select',
    options: ['twilio', 'generic'],
  }),
  def({
    key: 'sms.base_url',
    group: 'sms',
    label: 'API base URL',
    help: 'Leave blank for Twilio. Set for a self-hosted or alternative gateway.',
    schema: z.string().max(255),
    default: () => '',
    input: 'text',
  }),
  def({
    key: 'sms.account_sid',
    group: 'sms',
    label: 'Account SID',
    help: 'Twilio Account SID, or the account identifier your gateway expects.',
    schema: z.string().max(255),
    default: () => '',
    input: 'text',
  }),
  def({
    key: 'sms.auth_token',
    group: 'sms',
    label: 'Auth token',
    help: 'Sealed with the blob encryption key before storage. Never displayed once saved.',
    schema: z.string().max(1_024),
    default: () => '',
    secret: true,
    input: 'password',
  }),
  def({
    key: 'sms.from_number',
    group: 'sms',
    label: 'From number',
    help: 'E.164 format, e.g. +14175550100.',
    schema: z.string().max(32),
    default: () => '',
    input: 'text',
  }),

  // ── authentication ─────────────────────────────────────────────────────────
  def({
    key: 'auth.allowed_mfa_methods',
    group: 'authentication',
    label: 'Permitted second factors',
    help:
      'MFA itself is mandatory and cannot be disabled (§11). This controls only WHICH ' +
      'factors staff may enrol. Removing a method does not un-enrol anyone already using it.',
    schema: z.array(z.enum(['totp', 'email', 'sms'])).min(1),
    default: () => ['totp'] as ('totp' | 'email' | 'sms')[],
    input: 'select',
    options: ['totp', 'email', 'sms'],
  }),
  def({
    key: 'auth.otp_ttl_seconds',
    group: 'authentication',
    label: 'One-time code lifetime (seconds)',
    help: 'How long an emailed or texted code stays valid. Shorter is safer.',
    schema: z.number().int().min(60).max(1_800),
    default: () => 600,
    input: 'number',
  }),
  def({
    key: 'auth.otp_max_attempts',
    group: 'authentication',
    label: 'Maximum code attempts',
    help: 'Wrong guesses before a code is burned and a new one must be requested.',
    schema: z.number().int().min(1).max(10),
    default: () => 5,
    input: 'number',
  }),
  def({
    key: 'auth.password_reset_ttl_seconds',
    group: 'authentication',
    label: 'Password reset lifetime (seconds)',
    help: 'How long a reset link or code remains usable. Single use regardless.',
    schema: z.number().int().min(300).max(86_400),
    default: () => 3_600,
    input: 'number',
  }),

  // ── licensing ──────────────────────────────────────────────────────────────
  def({
    key: 'license.required',
    group: 'licensing',
    label: 'Require license activation',
    help: 'Off for internal use. Turned on when the appliance is licensed to a firm (§13).',
    schema: z.boolean(),
    default: () => env.LICENSE_REQUIRED,
    input: 'boolean',
  }),
] as const satisfies readonly SettingDef[];

export type SettingKey = (typeof SETTINGS)[number]['key'];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s as SettingDef]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

/**
 * Environment values shown read-only in the admin UI.
 *
 * These are here so an admin can *see* the deployment's posture without being handed a
 * switch that turns the compliance guarantee off.
 */
export function readOnlyEnvironment(): { key: string; value: string; why: string }[] {
  return [
    {
      key: 'ROUTER_REQUIRE_US_REGION',
      value: String(env.ROUTER_REQUIRE_US_REGION),
      why:
        'Whether the app refuses to start unless the router reports US-region pinning. This ' +
        'is the control keeping taxpayer page images inside US inference (§11), so it is ' +
        'deliberately not a UI toggle. Change it in the environment and restart.',
    },
    {
      key: 'ROUTER_EXPECTED_SENSITIVITY',
      value: env.ROUTER_EXPECTED_SENSITIVITY,
      why: 'The task-class tier this deployment expects. Widening happens in the router admin UI, not here.',
    },
    {
      key: 'VIBE_AI_ROUTER_URL',
      value: env.VIBE_AI_ROUTER_URL,
      why: 'Internal network address of the router. Set at provisioning.',
    },
    {
      key: 'STORAGE_DRIVER',
      value: env.STORAGE_DRIVER,
      why: 'Blob backend. Changing it after documents exist would orphan them.',
    },
    {
      key: 'TIN_HASH_SALT',
      value: '(set — never displayed)',
      why: 'Salt for the client join key. Rotating it orphans every taxpayer record.',
    },
    {
      key: 'STORAGE_ENCRYPTION_KEY',
      value: '(set — never displayed)',
      why: 'Encrypts every stored document and page image. The highest-value secret here.',
    },
  ];
}
