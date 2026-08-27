/**
 * TIN handling (§7).
 *
 * The plaintext TIN exists in memory for exactly as long as it takes to derive a hash and
 * slice four digits. Nothing here returns it, and `src/extract/persist.ts` refuses to write
 * any field the registry marked `sensitive: 'tin'`.
 *
 * The join key is HMAC-SHA256 over the normalized digits, keyed by a per-deployment salt in
 * the app's secret store. HMAC rather than a bare hash: a plain SHA-256 of a nine-digit
 * space is trivially enumerable, salt or no salt.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { secrets } from '../config/env.ts';

export interface TinIdentity {
  tinHash: string;
  tinLast4: string;
}

/** Digits only. Handles `123-45-6789`, `123 45 6789`, `XXX-XX-6789` masks. */
export function normalizeTin(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

/** A masked TIN carries only the last four; it cannot produce a join key. */
export function isMasked(raw: string): boolean {
  return /[xX*]/.test(raw) && /\d{4}\s*$/.test(raw.trim());
}

export function last4(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function hashTin(plaintextTin: string): TinIdentity | null {
  const normalized = normalizeTin(plaintextTin);
  if (!normalized) return null;
  const tinHash = createHmac('sha256', secrets.tinHashSalt).update(normalized).digest('hex');
  return { tinHash, tinLast4: normalized.slice(-4) };
}

export function tinHashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** ITIN group ranges (the middle two digits). Anything else in the 9xx area is a misread. */
const ITIN_GROUPS: readonly [number, number][] = [
  [50, 65],
  [70, 88],
  [90, 92],
  [94, 99],
];

/**
 * Obviously-invalid TIN shapes. Used to avoid proposing a client from a misread, not to
 * validate anyone's identity.
 *
 * Accepts both SSNs and **ITINs**. ITINs occupy the 9xx area that SSN validation rejects
 * outright, so treating "starts with 9" as invalid would silently drop every
 * ITIN-holding spouse or dependent from a bundle — a joint return would resolve to one
 * taxpayer instead of two, with no error anywhere.
 */
export function isPlausibleTin(normalized: string): boolean {
  if (normalized.length !== 9) return false;
  const area = normalized.slice(0, 3);
  const group = Number(normalized.slice(3, 5));
  const serial = normalized.slice(5);

  if (group === 0) return false;
  if (serial === '0000') return false;

  if (area.startsWith('9')) {
    // ITIN territory: only the assigned group ranges are real.
    return ITIN_GROUPS.some(([lo, hi]) => group >= lo && group <= hi);
  }

  if (area === '000' || area === '666') return false;
  return true;
}

/** True when the number is an ITIN rather than an SSN. Display only. */
export function isItin(normalized: string): boolean {
  return normalized.startsWith('9') && isPlausibleTin(normalized);
}
