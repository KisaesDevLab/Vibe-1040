import { describe, expect, it } from 'vitest';
import { normalizePhone, redact } from '../src/notify/channels.ts';
import { passwordProblem } from '../src/auth/password-reset.ts';
import { SETTINGS, settingDef } from '../src/settings/registry.ts';

describe('phone normalization', () => {
  it('accepts E.164 and leaves it alone', () => {
    expect(normalizePhone('+14175550100')).toBe('+14175550100');
    expect(normalizePhone('  +14175550100 ')).toBe('+14175550100');
  });

  it('assumes North America for a bare 10-digit number', () => {
    expect(normalizePhone('417-555-0100')).toBe('+14175550100');
    expect(normalizePhone('(417) 555-0100')).toBe('+14175550100');
    expect(normalizePhone('4175550100')).toBe('+14175550100');
    expect(normalizePhone('1 417 555 0100')).toBe('+14175550100');
  });

  it('rejects anything it cannot be sure about', () => {
    expect(normalizePhone('555-0100')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    // A leading + with too few digits is a typo, not a short country code.
    expect(normalizePhone('+1234')).toBeNull();
  });
});

describe('redaction', () => {
  it('never returns a full address or number', () => {
    expect(redact('email', 'preparer@example.test')).toBe('p***@example.test');
    expect(redact('sms', '+14175550100')).toBe('***-***-0100');
  });

  it('degrades safely on malformed input rather than echoing it', () => {
    expect(redact('email', 'not-an-email')).toBe('***');
  });
});

describe('password policy', () => {
  it('requires length over composition tricks', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/);
    expect(passwordProblem('correct-horse-battery-staple')).toBeNull();
    // No composition rules: a long simple passphrase is fine, which is the point.
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).toBeNull();
  });

  it('rejects surrounding whitespace, which is almost always a paste accident', () => {
    expect(passwordProblem(' a-long-enough-password ')).toMatch(/whitespace/);
  });

  it('has an upper bound so a huge input cannot become a hashing DoS', () => {
    expect(passwordProblem('x'.repeat(500))).toMatch(/at most/);
  });
});

describe('settings registry', () => {
  it('marks every credential as a secret so it is sealed and never returned', () => {
    for (const key of ['email.password', 'sms.auth_token']) {
      expect(settingDef(key)?.secret, `${key} must be secret`).toBe(true);
    }
  });

  it('keeps compliance guardrails and key material OUT of the editable set (§11)', () => {
    const editable = new Set(SETTINGS.map((s) => s.key));
    for (const forbidden of [
      'ROUTER_REQUIRE_US_REGION',
      'ROUTER_EXPECTED_SENSITIVITY',
      'TIN_HASH_SALT',
      'STORAGE_ENCRYPTION_KEY',
      'SESSION_SECRET',
      'VIBE_AI_TOKEN',
      'DATABASE_URL',
    ]) {
      expect(editable.has(forbidden), `${forbidden} must not be editable in the UI`).toBe(false);
    }
  });

  it('cannot express "turn MFA off" — only which factors are permitted', () => {
    const authKeys = SETTINGS.filter((s) => s.group === 'authentication').map((s) => s.key);
    expect(authKeys).toContain('auth.allowed_mfa_methods');
    expect(authKeys.some((k) => /require|enable|disable/.test(k) && /mfa/.test(k))).toBe(false);

    const methods = settingDef('auth.allowed_mfa_methods')!;
    // At least one factor must always remain permitted.
    expect(methods.schema.safeParse([]).success).toBe(false);
    expect(methods.schema.safeParse(['totp']).success).toBe(true);
  });

  it('bounds every numeric setting so a typo cannot disable a control', () => {
    // A tolerance of a million dollars would make the arithmetic gate meaningless.
    expect(settingDef('reconcile.tolerance_cents')!.schema.safeParse(100_000_000).success).toBe(false);
    // Zero extraction passes would remove the only confidence signal that exists.
    expect(settingDef('extract.passes')!.schema.safeParse(0).success).toBe(false);
  });
});
