/**
 * Staff credentials (P0). MFA is mandatory (§11 GLBA Safeguards) — a session is not usable
 * until the TOTP step is satisfied, enforced in `requireUser`.
 *
 * scrypt via node:crypto rather than argon2, to keep the runtime image free of native
 * build deps. Parameters are the Node defaults raised to N=2^15.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { authenticator } from 'otplib';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * N=32768, r=8 needs roughly 128 × N × r = 33.5 MB, which is over Node's default 32 MB
 * `maxmem` cap — scrypt throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS rather than allocating.
 * The cap has to be raised explicitly for these parameters to work at all.
 */
const PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const MAXMEM = 64 * 1024 * 1024;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ── TOTP ─────────────────────────────────────────────────────────────────────

authenticator.options = { window: 1 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpUri(secret: string, email: string): string {
  return authenticator.keyuri(email, 'Vibe 1040', secret);
}

export function verifyTotp(secret: string, token: string): boolean {
  try {
    return authenticator.verify({ token: token.replace(/\s/g, ''), secret });
  } catch {
    return false;
  }
}
