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

export type SettingGroup = 'reconciliation' | 'retention' | 'extraction' | 'rasterization' | 'email' | 'sms' | 'authentication' | 'licensing' | 'engine';

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
  /**
   * This value is only read at startup, so changing it here does nothing until the API and
   * worker restart.
   *
   * Carried as data rather than left to the `help` prose because the UI has to *render* it —
   * a switch that moves, saves, and changes nothing until someone restarts a container is the
   * same defect as the dead filing-status control, and it took a browser to find that one.
   * Anything marked here saves with a pending badge instead of reading as live.
   */
  restartRequired?: boolean;
  /**
   * Flipping this to a more permissive value needs a typed acknowledgement, whose text this
   * is. The point is not friction for its own sake: it is that the audit row then records an
   * admin who was told what changes and did it anyway, which is the property that made the
   * environment key worth defending in the first place.
   */
  acknowledge?: string;
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
      'Binding passes per document. Every bound value is verified against the spans it cites ' +
      'regardless of this setting; extra passes run at a non-zero temperature (and against ' +
      'EXTRACT_SECOND_PASS_MODEL when set) so that disagreement is a real second reading. ' +
      'Each pass costs one inference per document.',
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
  def({
    key: 'extract.second_pass_temperature',
    group: 'extraction',
    label: 'Second-pass temperature',
    help:
      'Sampling temperature for binding passes after the first. The first pass always runs at ' +
      '0. A later pass is only informative when it is a different reading, so keep this above 0.',
    schema: z.number().min(0).max(2),
    default: () => env.EXTRACT_SECOND_PASS_TEMPERATURE,
    input: 'number',
  }),
  def({
    key: 'extract.second_pass_model',
    group: 'extraction',
    label: 'Second-pass model (advisory)',
    help:
      'Model name to ask the router for on passes after the first, e.g. digitalocean/glm-5.3. ' +
      'Advisory only: router policy decides what serves, and the model must be in the ' +
      'policy\'s allowed list. Blank uses the policy default.',
    schema: z.string().max(120),
    default: () => env.EXTRACT_SECOND_PASS_MODEL ?? '',
    input: 'text',
  }),
  def({
    key: 'pipeline.worker_concurrency',
    group: 'extraction',
    label: 'Pipeline concurrency',
    help:
      'Jobs the worker runs at once — each one is an in-flight router call. Layout on a ' +
      'rate-limited provider takes a minute or two per scanned page, so more concurrency ' +
      'finishes a scanned packet sooner but draws more 429s. Watch the router ledger.',
    schema: z.number().int().min(1).max(32),
    default: () => env.WORKER_CONCURRENCY,
    input: 'number',
    note: 'The worker picks up a change within about a minute; jobs already running finish first.',
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

  // ── engine and pipeline ────────────────────────────────────────────────────
  //
  // These were environment-only and shown read-only until 2026-09-25, on the reasoning that
  // what the app computes about a taxpayer "is not a click". Kurt's call to make them
  // clickable; the reasoning is answered rather than dropped — each one that matters carries
  // an acknowledgement, so the audit row names an admin who was told what changes.
  //
  // What did **not** move is in `readOnlyEnvironment()` below, with a per-key reason.
  def({
    key: 'draft.return_enabled',
    group: 'engine',
    label: 'Draft return (OpenTax)',
    help:
      'Whether the bundle view offers a draft 1040 computed on this appliance from the amounts ' +
      'read off these documents (§14). Adds no inference and no egress — the engine is ' +
      'deterministic, holds no credential and makes no network call. It changes what the app ' +
      'computes about a taxpayer, so every change here is audited.',
    schema: z.boolean(),
    default: () => env.DRAFT_RETURN_ENABLED,
    input: 'boolean',
    acknowledge:
      'Turning this on makes the app compute a draft return for a taxpayer. ' +
      'QUESTIONS.md Q21 — whether the WISP’s §7216 wording covers that — is still open, and ' +
      'docs/wisp-amendment.md §4.1 is unapproved. This is recorded against your account.',
    note:
      'Takes effect immediately. A draft is still refused for any bundle with an ' +
      'undispositioned hard failure — this switch does not open that gate (§6).',
  }),
  def({
    key: 'engine.opentax_version',
    group: 'engine',
    label: 'Expected OpenTax version',
    help:
      'The engine release the node map was written against. What the sidecar actually reports ' +
      'is checked against this, and a disagreement warns loudly — a mapping must not drift ' +
      'under the engine. Editing this silences that warning rather than changing any binary: ' +
      'the version that runs is pinned and checksum-verified when the image is built.',
    schema: z.string().min(1).max(64),
    default: () => env.OPENTAX_VERSION,
    input: 'text',
    acknowledge:
      'This does not upgrade anything. It changes which version the app expects, so a real ' +
      'drift between the node map and the running engine would stop being reported.',
  }),
  def({
    key: 'router.expected_sensitivity',
    group: 'engine',
    label: 'Expected task-class sensitivity',
    help:
      'The tier this deployment expects its task classes to be at. Startup compares what the ' +
      'router reports against this and warns on a mismatch. Changing it here changes what the ' +
      'app expects — widening what the router actually permits is a firm-admin action in the ' +
      'router’s own admin UI, and nothing on this page can do it.',
    schema: z.enum(['local_only', 'cloud_deidentified', 'cloud_identified']),
    default: () => env.ROUTER_EXPECTED_SENSITIVITY,
    input: 'select',
    options: ['local_only', 'cloud_deidentified', 'cloud_identified'],
  }),
  def({
    key: 'extraction.attach_page_image',
    group: 'engine',
    label: 'Send the page image to the field binder',
    help:
      'Gives the binder the page image alongside the spans, which reads a dense grid better. ' +
      'It also registers v1040_field_extract as a vision class, so router policy must bind a ' +
      'vision-capable model or every extraction fails — and it means page images, which carry ' +
      'SSNs and EINs unscrubbed (§3), egress on the extraction call as well as on classify.',
    schema: z.boolean(),
    default: () => env.EXTRACT_ATTACH_PAGE_IMAGE,
    input: 'boolean',
    restartRequired: true,
    acknowledge:
      'This sends taxpayer page images on the extraction call too. The router’s scrubber ' +
      'rewrites text and passes images through verbatim, so those pixels leave the appliance ' +
      'as they are. Check the router policy binds a vision model before restarting.',
  }),
  def({
    key: 'extraction.ocr_fallback_enabled',
    group: 'engine',
    label: 'Transcribe pages with no text layer',
    help:
      'Runs v1040_ocr_transcribe over a page the sidecar found no text on, so a scan becomes ' +
      'readable. It supplies no geometry: a value read out of a transcription has no span to ' +
      'point at, so §6’s blocking rule applies in full. This makes a scanned page readable, ' +
      'not provable.',
    schema: z.boolean(),
    default: () => env.OCR_FALLBACK_ENABLED,
    input: 'boolean',
    restartRequired: true,
    note:
      'The class is registered at startup, and whether it binds a local OCR server or a cloud ' +
      'vision model is the firm’s decision in router policy — the startup log says which way ' +
      'it resolved.',
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
 * **Most of what used to be here is now editable** in Admin → Settings (the `engine` group
 * above), decided 2026-09-25: "it changes what the app computes about a taxpayer" was a reason
 * to *audit* a change, not a reason to make an operator edit `.env` and restart a container.
 *
 * What is left is here for one of two reasons, and they are different in kind:
 *
 *  - **It would destroy or leak the firm's own data.** Not a policy view — rotating the TIN
 *    salt orphans every taxpayer record, and one of these cannot be a setting at all because
 *    the settings table's own secrets are encrypted with it.
 *  - **It is the one compliance control §11 names**, and it is asserted at startup and fails
 *    closed, so a page served by a process that already started cannot honestly offer it.
 *
 * Each `why` says which, in words a person can act on. If one of these should move too, it
 * needs a decision-log entry and a migration path — not a change to this list.
 */
export function readOnlyEnvironment(): { key: string; value: string; why: string }[] {
  return [
    {
      key: 'ROUTER_REQUIRE_US_REGION',
      value: String(env.ROUTER_REQUIRE_US_REGION),
      why:
        'Whether the app refuses to start unless the router reports US-region pinning — the ' +
        'only control keeping taxpayer page images inside US inference (§11), because the ' +
        'classes that send them are cloud_deidentified and the router’s scrubber does not ' +
        'scrub images. It is asserted at startup and fails closed, so a running process ' +
        'offering to relax it would be offering something it cannot honour until the next ' +
        'restart anyway. Change it in the environment, deliberately. Note this deployment ' +
        'already runs it false by recorded decision (Q13) where policy binds DigitalOcean.',
    },
    {
      key: 'VIBE_AI_ROUTER_URL',
      value: env.VIBE_AI_ROUTER_URL,
      why:
        'Where every page image is sent for inference. As an editable field this is a one-box ' +
        'exfiltration channel: anyone holding an admin session could point it at a host they ' +
        'control and receive every taxpayer document, unscrubbed, with nothing in the app ' +
        'looking wrong. It stays at provisioning for that reason alone.',
    },
    {
      key: 'STORAGE_DRIVER',
      value: env.STORAGE_DRIVER,
      why:
        'Blob backend. Switching it after documents exist does not migrate them — it points ' +
        'the app at an empty store while every existing document still reads as present in ' +
        'the database. Needs a migration, not a toggle.',
    },
    {
      key: 'TIN_HASH_SALT',
      value: '(set — never displayed)',
      why:
        'Salt for the client join key (§7). Rotating it does not re-key anything: every ' +
        'existing taxpayer record keeps its old hash and nothing matches it again, so the ' +
        'firm silently acquires a second copy of every client. A rotation is a data migration.',
    },
    {
      key: 'STORAGE_ENCRYPTION_KEY',
      value: '(set — never displayed)',
      why:
        'Encrypts every stored document and page image — and also every secret in this ' +
        'settings table, which is why it cannot be a setting: storing it here would encrypt ' +
        'it with itself. Changing it makes every existing blob undecryptable. It is the ' +
        'highest-value secret in the deployment and a web form is the wrong place for it.',
    },
  ];
}
