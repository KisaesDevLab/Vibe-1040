import { authenticator } from 'otplib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateTotpSecret,
  hashPassword,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '../src/auth/credentials.ts';

/**
 * These exist because a real bug shipped past the first test pass: scrypt at N=32768, r=8
 * needs ~33.5 MB, over Node's default 32 MB `maxmem` cap, so `hashPassword` threw
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS the first time anything actually called it. Nothing in
 * the suite had, so nothing caught it until seeding a user against a live database.
 */
describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2$3')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });

  it('records its own parameters so they can be raised later without invalidating hashes', async () => {
    const stored = await hashPassword('x');
    const [scheme, n, r, p] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(32_768);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });
});

describe('TOTP', () => {
  it('accepts a current code and rejects a wrong one', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, authenticator.generate(secret))).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(false);
  });

  it('tolerates spaces, since authenticator apps display codes grouped', () => {
    const secret = generateTotpSecret();
    const code = authenticator.generate(secret);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
  });

  it('does not throw on garbage input', () => {
    expect(verifyTotp(generateTotpSecret(), 'not-a-code')).toBe(false);
    expect(verifyTotp('not-a-secret', '123456')).toBe(false);
  });

  it('builds an enrolment URI an authenticator app can read', () => {
    const uri = totpUri(generateTotpSecret(), 'staff@firm.test');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('Vibe%201040');
    expect(uri).toContain('secret=');
  });
});

/**
 * These exist because of a real sign-in failure on a Vibe Appliance in LAN mode.
 *
 * The `Secure` flag used to be hardwired to `NODE_ENV === 'production'`, which the
 * appliance always sets. LAN mode serves this app over plain HTTP on its emergency port,
 * so the browser accepted the `Set-Cookie` and then refused to send it back: the password
 * was accepted, the second-factor request 401'd, and the UI bounced to the login screen
 * forever with no error anywhere. The transport, not the build mode, decides this flag.
 */
describe('session cookie attributes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Re-parse the config module under a patched environment. */
  async function reload(overrides: Record<string, string>) {
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
    vi.resetModules();
    return (await import('../src/config/env.ts')).env;
  }

  it('marks the cookie Secure in production when nothing says otherwise', async () => {
    const env = await reload({ NODE_ENV: 'production' });
    expect(env.SESSION_SECURE).toBe(true);
  });

  it('does not mark it Secure outside production', async () => {
    const env = await reload({ NODE_ENV: 'development' });
    expect(env.SESSION_SECURE).toBe(false);
  });

  it('lets a plain-HTTP deployment turn Secure off in production — the LAN-mode bug', async () => {
    const env = await reload({ NODE_ENV: 'production', SESSION_SECURE: 'false' });
    expect(env.SESSION_SECURE).toBe(false);
  });

  it('lets a proxied deployment turn Secure on outside production', async () => {
    const env = await reload({ NODE_ENV: 'development', SESSION_SECURE: 'true' });
    expect(env.SESSION_SECURE).toBe(true);
  });

  it('refuses a malformed value rather than guessing which way to fail', async () => {
    await expect(reload({ SESSION_SECURE: 'yes' })).rejects.toThrow(/SESSION_SECURE/);
  });

  it('sets httpOnly, SameSite=Strict and a root path, and mirrors the flag', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECURE', 'false');
    vi.resetModules();
    const { sessionCookieOptions } = await import('../src/auth/session.ts');
    expect(sessionCookieOptions).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: false,
    });
  });
});
