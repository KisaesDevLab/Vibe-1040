import { describe, expect, it } from 'vitest';
import { formatCents, parseMoney, sumNonNull, withinTolerance } from '../src/lib/money.ts';

/**
 * §5 — blank is not zero. These are the assertions that keep the tool's main value intact;
 * if any of them start passing for the wrong reason, the worksheet stops being able to say
 * "this box was empty" as distinct from "this box said zero".
 */
describe('parseMoney — blank versus zero', () => {
  it('treats an empty box as blank, not zero', () => {
    expect(parseMoney(null)).toEqual({ kind: 'blank' });
    expect(parseMoney(undefined)).toEqual({ kind: 'blank' });
    expect(parseMoney('')).toEqual({ kind: 'blank' });
    expect(parseMoney('   ')).toEqual({ kind: 'blank' });
  });

  it('treats a printed zero as an amount of zero', () => {
    expect(parseMoney('0')).toEqual({ kind: 'amount', cents: 0 });
    expect(parseMoney('0.00')).toEqual({ kind: 'amount', cents: 0 });
    expect(parseMoney('$0.00')).toEqual({ kind: 'amount', cents: 0 });
  });

  it('reads the IRS "-0-" convention as a printed zero', () => {
    expect(parseMoney('-0-')).toEqual({ kind: 'amount', cents: 0 });
    expect(parseMoney('- 0 -')).toEqual({ kind: 'amount', cents: 0 });
  });

  it('parses ordinary formatting', () => {
    expect(parseMoney('1,234.56')).toEqual({ kind: 'amount', cents: 123456 });
    expect(parseMoney('$1,234.56')).toEqual({ kind: 'amount', cents: 123456 });
    expect(parseMoney('87654')).toEqual({ kind: 'amount', cents: 8765400 });
  });

  it('parses parenthesised and signed negatives', () => {
    expect(parseMoney('(1,234.56)')).toEqual({ kind: 'amount', cents: -123456 });
    expect(parseMoney('-500.00')).toEqual({ kind: 'amount', cents: -50000 });
  });

  it('reports garbage as unparseable rather than blank or zero', () => {
    expect(parseMoney('see statement')).toEqual({ kind: 'unparseable' });
    expect(parseMoney('N/A')).toEqual({ kind: 'unparseable' });
  });
});

describe('sumNonNull', () => {
  it('sums only present values and counts the blanks separately', () => {
    expect(sumNonNull([1000, null, 2500, null])).toEqual({
      total: 3500,
      contributorCount: 4,
      nullCount: 2,
    });
  });

  it('returns a null total when every contributor is blank — not zero', () => {
    expect(sumNonNull([null, null])).toEqual({ total: null, contributorCount: 2, nullCount: 2 });
  });

  it('distinguishes a printed zero from all-blank', () => {
    expect(sumNonNull([0]).total).toBe(0);
    expect(sumNonNull([null]).total).toBeNull();
  });
});

describe('formatting and tolerance', () => {
  it('formats cents with the negative convention used on the worksheet', () => {
    expect(formatCents(123456)).toBe('1,234.56');
    expect(formatCents(-50000)).toBe('(500.00)');
    expect(formatCents(null)).toBe('');
  });

  it('honours the configured rounding tolerance', () => {
    expect(withinTolerance(10000, 10099, 100)).toBe(true);
    expect(withinTolerance(10000, 10101, 100)).toBe(false);
  });
});
