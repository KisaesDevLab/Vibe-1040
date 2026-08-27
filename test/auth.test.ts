import { authenticator } from 'otplib';
import { describe, expect, it } from 'vitest';
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
