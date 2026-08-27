/**
 * Money handling. Integer cents everywhere; float dollars never touch the pipeline.
 *
 * The parser's contract is §5: it distinguishes "the box was blank" (null) from "the form
 * printed a zero" (0). Anything that cannot be read as a number is `undefined`, which is a
 * third state meaning "unparseable" — callers must not fold that into null.
 */

export type ParsedMoney = { kind: 'blank' } | { kind: 'amount'; cents: number } | { kind: 'unparseable' };

/**
 * Parse a money string as printed on a tax form.
 *
 * Handles: `1,234.56`, `$1,234.56`, `(1,234.56)` negative, `1234`, `-0-` (a printed zero
 * convention on IRS forms), bare `0`, and an empty box.
 */
export function parseMoney(raw: string | null | undefined): ParsedMoney {
  if (raw === null || raw === undefined) return { kind: 'blank' };
  const s = raw.trim();
  if (s === '') return { kind: 'blank' };

  // IRS forms print an explicit zero as -0-. That is a printed zero, not a blank.
  if (/^-\s*0\s*-$/.test(s)) return { kind: 'amount', cents: 0 };

  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  const digits = s.replace(/[()$,\s-]/g, '');
  if (digits === '' || !/^\d*\.?\d*$/.test(digits)) return { kind: 'unparseable' };

  const value = Number(digits);
  if (!Number.isFinite(value)) return { kind: 'unparseable' };

  const cents = Math.round(value * 100);
  return { kind: 'amount', cents: negative ? -cents : cents };
}

export function formatCents(cents: number | null): string {
  if (cents === null) return '';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `(${s})` : s;
}

/** Dollars as a number, for XLSX cells that should be numeric rather than text. */
export function centsToDollars(cents: number | null): number | null {
  return cents === null ? null : cents / 100;
}

/** True when |a - b| is inside tolerance. Tolerance is per-document and configurable (§6). */
export function withinTolerance(a: number, b: number, toleranceCents: number): boolean {
  return Math.abs(a - b) <= toleranceCents;
}

/**
 * Sum that respects §5: nulls are counted, never coerced to zero. A line total is the sum
 * of what was actually present, reported alongside how many contributors were blank.
 */
export function sumNonNull(values: readonly (number | null)[]): {
  total: number | null;
  contributorCount: number;
  nullCount: number;
} {
  let total = 0;
  let present = 0;
  let nulls = 0;
  for (const v of values) {
    if (v === null) nulls += 1;
    else {
      total += v;
      present += 1;
    }
  }
  return {
    total: present === 0 ? null : total,
    contributorCount: values.length,
    nullCount: nulls,
  };
}
