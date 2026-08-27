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

  STORAGE_DRIVER: z.enum(['local', 'b2']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('/data/blobs'),
  STORAGE_ENCRYPTION_KEY: base64Key32,
  B2_BUCKET: z.string().optional(),
  B2_ENDPOINT: z.string().optional(),
  B2_REGION: z.string().optional(),
  B2_KEY_ID: z.string().optional(),
  B2_APPLICATION_KEY: z.string().optional(),

  SIDECAR_CONCURRENCY: z.coerce.number().int().positive().default(2),

  RASTER_DPI_DEFAULT: z.coerce.number().int().positive().default(300),
  RASTER_DPI_DIGITAL: z.coerce.number().int().positive().default(200),
  RASTER_DPI_DEGRADED: z.coerce.number().int().positive().default(400),
  RASTER_MAX_EDGE_PX: z.coerce.number().int().positive().default(2200),
  RASTER_JPEG_QUALITY: z.coerce.number().int().min(1).max(100).default(82),

  EXTRACT_PASSES: z.coerce.number().int().min(1).default(2),
  EXTRACT_PASSES_ON_DISAGREEMENT: z.coerce.number().int().min(1).default(3),

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

  return e;
}

export const env = load();
export type Env = typeof env;

/** Raw key material, decoded once. Never log these. */
export const secrets = {
  tinHashSalt: Buffer.from(env.TIN_HASH_SALT, 'base64'),
  sessionSecret: Buffer.from(env.SESSION_SECRET, 'base64'),
  storageKey: Buffer.from(env.STORAGE_ENCRYPTION_KEY, 'base64'),
} as const;
