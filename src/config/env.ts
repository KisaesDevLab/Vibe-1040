/**
 * Configuration surface (P0). Everything firm-specific lives here, not in code (§13).
 *
 * Parsed once at import. A malformed environment fails at boot rather than at the first
 * request that happens to touch the bad value.
 */
import { z } from 'zod';

/** 32 raw bytes, base64-encoded. Used for keys and salts. */
const base64Key32 = z
  .string()
  .min(1)
  .refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'must be 32 bytes, base64-encoded');

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8240),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  VIBE_AI_ROUTER_URL: z.string().url(),
  VIBE_AI_TOKEN: z.string().min(1),
  ROUTER_REQUIRE_US_REGION: bool.default('true'),
  ROUTER_EXPECTED_SENSITIVITY: z
    .enum(['local_only', 'cloud_deidentified', 'cloud_allowed'])
    .default('cloud_deidentified'),

  TIN_HASH_SALT: base64Key32,
  SESSION_SECRET: base64Key32,

  /**
   * Does the operator's browser actually reach this app over HTTPS? Drives the `Secure`
   * flag on the staff session cookie, and nothing else.
   *
   * This has to be told the truth rather than inferred. Marking the cookie `Secure` on a
   * plain-HTTP origin makes the browser accept the `Set-Cookie` and then never send it
   * back, so the password is accepted and every authenticated request 401s immediately
   * afterwards — a sign-in loop with no error message anywhere. The appliance serves this
   * app on a plain-HTTP emergency port in LAN mode, and because the app is `rootServedOnly`
   * and cannot be path-mounted, in Tailscale mode too. It renders its own per-mode decision
   * into this variable, the same one it feeds Vibe Connect, Vibe Recap, the transaction
   * converter, and the router.
   *
   * Do NOT derive this from the request instead. `tailscale serve` terminates TLS and
   * forwards to Caddy over plain HTTP, so `X-Forwarded-Proto` reports `http` on an origin
   * the browser correctly considers secure, and the flag would silently drop where it is
   * actually warranted.
   *
   * Unset falls back to the historical behaviour, `NODE_ENV === 'production'`. Setting it
   * false is a recorded weakening, not a shortcut: the cookie's only protection is then the
   * office LAN or the WireGuard tunnel, and §11's encryption-in-transit obligation is met
   * by the network rather than by the app. Name it in the WISP amendment.
   */
  SESSION_SECURE: bool.optional(),

  STORAGE_DRIVER: z.enum(['local', 'b2']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('/data/blobs'),
  STORAGE_ENCRYPTION_KEY: base64Key32,
  B2_BUCKET: z.string().optional(),
  B2_ENDPOINT: z.string().optional(),
  B2_REGION: z.string().optional(),
  B2_KEY_ID: z.string().optional(),
  B2_APPLICATION_KEY: z.string().optional(),

  SIDECAR_CONCURRENCY: z.coerce.number().int().positive().default(2),

  /**
   * Optional OCR fallback for pages with no text layer.
   *
   * Off by default, and deliberately so. It registers a fourth task class, and the firm then
   * chooses in the router console what serves it: a local OCR server, so no page image leaves
   * the appliance, or a cloud vision model for accuracy. This app holds no opinion on which —
   * see SENSITIVITY_CHECKED in router/task-classes.ts.
   *
   * What it does NOT do is supply geometry. Nothing the `local_ocr` kind can serve returns
   * bounding boxes, so §6's rule that a field with no span blocks the worksheet applies to
   * anything derived from a transcription, exactly as it does today.
   */
  OCR_FALLBACK_ENABLED: bool.default('false'),

  RASTER_DPI_DEFAULT: z.coerce.number().int().positive().default(300),
  RASTER_DPI_DIGITAL: z.coerce.number().int().positive().default(200),
  RASTER_DPI_DEGRADED: z.coerce.number().int().positive().default(400),
  RASTER_MAX_EDGE_PX: z.coerce.number().int().positive().default(2200),
  RASTER_JPEG_QUALITY: z.coerce.number().int().min(1).max(100).default(82),

  /**
   * Binding passes per document. One by default: the confidence signal is verification of
   * every bound value against the spans it cites (`span_mismatch`), not repetition. A second
   * pass is only informative when it is a *different* reading, which is why passes after
   * the first run at EXTRACT_SECOND_PASS_TEMPERATURE and, optionally, ask policy for
   * EXTRACT_SECOND_PASS_MODEL. Two passes of the same prompt at temperature 0 agree whether
   * or not they are right.
   */
  EXTRACT_PASSES: z.coerce.number().int().min(1).default(1),
  EXTRACT_PASSES_ON_DISAGREEMENT: z.coerce.number().int().min(1).default(3),
  EXTRACT_SECOND_PASS_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
  /** Advisory model for passes after the first; policy still decides. Firm config, never code. */
  EXTRACT_SECOND_PASS_MODEL: z.string().min(1).optional(),
  /**
   * Send the page image(s) to the binder alongside the positioned span list. Registers
   * `v1040_field_extract` as a vision class, so the policy must bind a vision-capable model
   * (the DigitalOcean runbook binding is text-only; switch the policy before enabling).
   */
  EXTRACT_ATTACH_PAGE_IMAGE: bool.default('false'),

  RECONCILE_TOLERANCE_CENTS: z.coerce.number().int().nonnegative().default(100),

  RETENTION_RASTER_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_DOCUMENT_DAYS: z.coerce.number().int().positive().default(2555),
  RETENTION_DRY_RUN: bool.default('false'),

  LICENSE_REQUIRED: bool.default('false'),
  LICENSE_SERVER_URL: z.string().url().default('https://licensing.kisaes.com'),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const e = parsed.data;

  if (e.STORAGE_DRIVER === 'b2') {
    const missing = (['B2_BUCKET', 'B2_ENDPOINT', 'B2_KEY_ID', 'B2_APPLICATION_KEY'] as const).filter(
      (k) => !e[k],
    );
    if (missing.length) {
      throw new Error(`STORAGE_DRIVER=b2 requires: ${missing.join(', ')}`);
    }
  }

  // Retention ordering is a §11 obligation, not a preference: rasterized page images are
  // derived PII and must not outlive the documents they came from.
  if (e.RETENTION_RASTER_DAYS > e.RETENTION_DOCUMENT_DAYS) {
    throw new Error(
      'RETENTION_RASTER_DAYS must not exceed RETENTION_DOCUMENT_DAYS — ' +
        'page images are derived PII and purge earlier than their sources (§11).',
    );
  }

  return {
    ...e,
    // Unset means "behave the way this app did before the flag existed".
    SESSION_SECURE: e.SESSION_SECURE ?? e.NODE_ENV === 'production',
  };
}

export const env = load();
export type Env = typeof env;

/** Raw key material, decoded once. Never log these. */
export const secrets = {
  tinHashSalt: Buffer.from(env.TIN_HASH_SALT, 'base64'),
  sessionSecret: Buffer.from(env.SESSION_SECRET, 'base64'),
  storageKey: Buffer.from(env.STORAGE_ENCRYPTION_KEY, 'base64'),
} as const;
