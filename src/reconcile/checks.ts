/**
 * Arithmetic reconciliation (§6, P9).
 *
 * Hard failures block worksheet emission until a human dispositions them. Soft failures
 * annotate and proceed. The distinction is not advisory and the gate has no bypass — see
 * `gate.ts`.
 *
 * Every check is null-aware in the §5 sense: a blank box makes a check *not applicable*,
 * never a zero that happens to pass. `w2_ss_tax_rate` on a W-2 with an empty box 3 is
 * `not_applicable`, not `pass`.
 */
import { withinTolerance } from '../lib/money.ts';
import type { TaxTable } from './tax-tables.ts';

export type Severity = 'hard' | 'soft';
export type Outcome = 'pass' | 'fail' | 'not_applicable';

export interface CheckResult {
  checkKey: string;
  severity: Severity;
  outcome: Outcome;
  message: string;
  expectedCents?: number;
  actualCents?: number;
  toleranceCents?: number;
  detail?: Record<string, unknown>;
}

/** A resolved field value: model output with any human correction already layered on. */
export interface FieldValue {
  cents: number | null;
  text: string | null;
  bool: boolean | null;
  spanIds: string[];
  present: boolean;
}

export interface CheckContext {
  formType: string;
  taxYear: number;
  toleranceCents: number;
  table: TaxTable;
  fields: Map<string, FieldValue>;
  /** Sub-form documents, for container checks. */
  children?: { formType: string; fields: Map<string, FieldValue> }[];
  /** Only known when a DOB is available; drives the distribution-code plausibility check. */
  payeeAge?: number | null;
  /** Bundle majority year, for the mismatch check. */
  bundleTaxYear?: number | null;
}

const cents = (ctx: CheckContext, key: string): number | null => ctx.fields.get(key)?.cents ?? null;
const bool = (ctx: CheckContext, key: string): boolean | null => ctx.fields.get(key)?.bool ?? null;
const text = (ctx: CheckContext, key: string): string | null => ctx.fields.get(key)?.text ?? null;

const na = (checkKey: string, severity: Severity, why: string): CheckResult => ({
  checkKey,
  severity,
  outcome: 'not_applicable',
  message: why,
});

export type Check = (ctx: CheckContext) => CheckResult | CheckResult[] | null;

// ── W-2 hard checks ──────────────────────────────────────────────────────────

/** Box 4 must not exceed box 3 × 6.2% beyond rounding tolerance (§6). */
export const w2SsTaxRate: Check = (ctx) => {
  const wages = cents(ctx, 'box_3');
  const tax = cents(ctx, 'box_4');
  if (wages === null || tax === null) {
    return na('w2_ss_tax_rate', 'hard', 'Box 3 or box 4 is blank; rate check not applicable.');
  }
  // Tips are taxed for social security too, and appear in box 7 while also being inside
  // box 3. Withholding is computed on box 3, so box 3 alone is the right base.
  const expected = Math.round(wages * ctx.table.socialSecurityRate);
  const ok = tax <= expected + ctx.toleranceCents;
  return {
    checkKey: 'w2_ss_tax_rate',
    severity: 'hard',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Social security tax withheld is consistent with social security wages.'
      : `Box 4 (${tax}) exceeds box 3 × ${ctx.table.socialSecurityRate} (${expected}) beyond tolerance.`,
    expectedCents: expected,
    actualCents: tax,
    toleranceCents: ctx.toleranceCents,
  };
};

/** Box 3 must not exceed the tax-year social security wage base (§6). */
export const w2SsWageBase: Check = (ctx) => {
  const wages = cents(ctx, 'box_3');
  if (wages === null) return na('w2_ss_wage_base', 'hard', 'Box 3 is blank.');
  const base = ctx.table.socialSecurityWageBaseCents;
  const ok = wages <= base + ctx.toleranceCents;
  return {
    checkKey: 'w2_ss_wage_base',
    severity: 'hard',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Social security wages are within the wage base.'
      : `Box 3 (${wages}) exceeds the ${ctx.taxYear} social security wage base (${base}).`,
    expectedCents: base,
    actualCents: wages,
    toleranceCents: ctx.toleranceCents,
  };
};

/** Box 6 must reconcile to box 5 × 1.45% plus 0.9% on the excess over $200,000 (§6). */
export const w2MedicareTaxRate: Check = (ctx) => {
  const wages = cents(ctx, 'box_5');
  const tax = cents(ctx, 'box_6');
  if (wages === null || tax === null) {
    return na('w2_medicare_tax_rate', 'hard', 'Box 5 or box 6 is blank.');
  }
  const threshold = ctx.table.additionalMedicareThresholdCents;
  const excess = Math.max(0, wages - threshold);
  const expected =
    Math.round(wages * ctx.table.medicareRate) +
    Math.round(excess * ctx.table.additionalMedicareRate);
  const ok = withinTolerance(tax, expected, ctx.toleranceCents);
  return {
    checkKey: 'w2_medicare_tax_rate',
    severity: 'hard',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Medicare tax withheld reconciles to Medicare wages.'
      : `Box 6 (${tax}) does not reconcile to box 5 × ${ctx.table.medicareRate}` +
        (excess > 0 ? ` plus ${ctx.table.additionalMedicareRate} on the excess over ${threshold}` : '') +
        ` (expected ${expected}).`,
    expectedCents: expected,
    actualCents: tax,
    toleranceCents: ctx.toleranceCents,
    detail: { additionalMedicareWages: excess },
  };
};

// ── W-2 soft check ───────────────────────────────────────────────────────────

/**
 * Box 1 differing from boxes 3 and 5 is legitimate — 401(k), §125, group-term life, excess
 * deferrals — but worth surfacing (§6).
 */
export const w2Box1VsBox3Box5: Check = (ctx) => {
  const b1 = cents(ctx, 'box_1');
  const b3 = cents(ctx, 'box_3');
  const b5 = cents(ctx, 'box_5');
  if (b1 === null || (b3 === null && b5 === null)) {
    return na('w2_box1_vs_box3_box5', 'soft', 'Box 1 or both of boxes 3 and 5 are blank.');
  }
  const diffs: string[] = [];
  if (b3 !== null && !withinTolerance(b1, b3, ctx.toleranceCents)) diffs.push(`box 3 (${b3})`);
  if (b5 !== null && !withinTolerance(b1, b5, ctx.toleranceCents)) diffs.push(`box 5 (${b5})`);
  if (!diffs.length) {
    return { checkKey: 'w2_box1_vs_box3_box5', severity: 'soft', outcome: 'pass', message: 'Box 1 agrees with boxes 3 and 5.' };
  }
  return {
    checkKey: 'w2_box1_vs_box3_box5',
    severity: 'soft',
    outcome: 'fail',
    message:
      `Box 1 (${b1}) differs from ${diffs.join(' and ')}. Legitimate via 401(k), §125, ` +
      'group-term life, or excess deferrals — confirm against box 12.',
    actualCents: b1,
    detail: { box3: b3, box5: b5 },
  };
};

// ── 1099-R ───────────────────────────────────────────────────────────────────

export const rTaxableNotDetermined: Check = (ctx) => {
  const flag = bool(ctx, 'box_2b_not_determined');
  const taxable = cents(ctx, 'box_2a');
  if (flag !== true) return na('r_taxable_not_determined', 'soft', '"Taxable amount not determined" is not checked.');
  if (taxable !== null) {
    return {
      checkKey: 'r_taxable_not_determined',
      severity: 'soft',
      outcome: 'pass',
      message: '"Taxable amount not determined" is checked but box 2a carries a value.',
    };
  }
  return {
    checkKey: 'r_taxable_not_determined',
    severity: 'soft',
    outcome: 'fail',
    message:
      'Box 2a is blank with "taxable amount not determined" checked. The taxable portion is ' +
      'a preparer determination; this app does not compute it (§9).',
  };
};

export const rTaxableNotExceedingGross: Check = (ctx) => {
  const gross = cents(ctx, 'box_1');
  const taxable = cents(ctx, 'box_2a');
  if (gross === null || taxable === null) return na('r_taxable_not_exceeding_gross', 'hard', 'Box 1 or box 2a is blank.');
  const ok = taxable <= gross + ctx.toleranceCents;
  return {
    checkKey: 'r_taxable_not_exceeding_gross',
    severity: 'hard',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Taxable amount does not exceed the gross distribution.'
      : `Box 2a (${taxable}) exceeds box 1 (${gross}).`,
    expectedCents: gross,
    actualCents: taxable,
    toleranceCents: ctx.toleranceCents,
  };
};

/** Distribution code implausible against the payee's age, where a DOB is available (§6). */
export const rDistributionCodeVsAge: Check = (ctx) => {
  const code = text(ctx, 'box_7_code');
  const age = ctx.payeeAge;
  if (!code || age === null || age === undefined) {
    return na('r_distribution_code_vs_age', 'soft', 'No distribution code or no known date of birth.');
  }
  const codes = code.toUpperCase().replace(/[^A-Z0-9]/g, '').split('');
  const problems: string[] = [];
  if (codes.includes('1') && age >= 59.5) {
    problems.push(`code 1 (early distribution) with age ${age}`);
  }
  if (codes.includes('7') && age < 59.5) {
    problems.push(`code 7 (normal distribution) with age ${age}`);
  }
  if (codes.includes('4') && age >= 59.5) {
    problems.push(`code 4 (death) is unusual here`);
  }
  if (!problems.length) {
    return { checkKey: 'r_distribution_code_vs_age', severity: 'soft', outcome: 'pass', message: 'Distribution code is plausible for the payee age.' };
  }
  return {
    checkKey: 'r_distribution_code_vs_age',
    severity: 'soft',
    outcome: 'fail',
    message: `Distribution code is implausible: ${problems.join('; ')}.`,
    detail: { code, age },
  };
};

// ── 1099-DIV / SSA ───────────────────────────────────────────────────────────

export const divQualifiedNotExceedingOrdinary: Check = (ctx) => {
  const ordinary = cents(ctx, 'box_1a');
  const qualified = cents(ctx, 'box_1b');
  if (ordinary === null || qualified === null) {
    return na('div_qualified_not_exceeding_ordinary', 'hard', 'Box 1a or box 1b is blank.');
  }
  const ok = qualified <= ordinary + ctx.toleranceCents;
  return {
    checkKey: 'div_qualified_not_exceeding_ordinary',
    severity: 'hard',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Qualified dividends do not exceed total ordinary dividends.'
      : `Box 1b (${qualified}) exceeds box 1a (${ordinary}); qualified dividends are a subset.`,
    expectedCents: ordinary,
    actualCents: qualified,
    toleranceCents: ctx.toleranceCents,
  };
};

export const ssaBox5Foots: Check = (ctx) => {
  const paid = cents(ctx, 'box_3');
  const repaid = cents(ctx, 'box_4');
  const net = cents(ctx, 'box_5');
  if (paid === null || net === null) return na('ssa_box5_equals_box3_minus_box4', 'hard', 'Box 3 or box 5 is blank.');
  const expected = paid - (repaid ?? 0);
  const ok = withinTolerance(net, expected, ctx.toleranceCents);
  return {
    checkKey: 'ssa_box5_equals_box3_minus_box4',
    severity: 'hard',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Net benefits foot to benefits paid less benefits repaid.'
      : `Box 5 (${net}) does not equal box 3 (${paid}) less box 4 (${repaid ?? 0}).`,
    expectedCents: expected,
    actualCents: net,
    toleranceCents: ctx.toleranceCents,
  };
};

// ── footing checks ───────────────────────────────────────────────────────────

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

/** 1095-A monthly rows must sum to the annual totals row (§6, hard). */
export const a1095MonthlyFootsToAnnual: Check = (ctx) => {
  const columns = [
    { suffix: 'premium', annual: 'annual_premium', label: 'enrollment premium' },
    { suffix: 'slcsp', annual: 'annual_slcsp', label: 'SLCSP premium' },
    { suffix: 'aptc', annual: 'annual_aptc', label: 'advance payment of PTC' },
  ] as const;

  return columns.map((col): CheckResult => {
    const monthly = MONTHS.map((m) => cents(ctx, `monthly_${m}_${col.suffix}`));
    const annual = cents(ctx, col.annual);
    const present = monthly.filter((v): v is number => v !== null);

    if (annual === null || present.length === 0) {
      return na(
        `a1095_monthly_rows_foot_to_annual:${col.suffix}`,
        'hard',
        `Annual ${col.label} or all monthly rows are blank.`,
      );
    }
    const sum = present.reduce((a, b) => a + b, 0);
    const ok = withinTolerance(sum, annual, ctx.toleranceCents);
    return {
      checkKey: `a1095_monthly_rows_foot_to_annual:${col.suffix}`,
      severity: 'hard',
      outcome: ok ? 'pass' : 'fail',
      message: ok
        ? `Monthly ${col.label} rows foot to the annual total.`
        : `Monthly ${col.label} rows sum to ${sum} but the annual total is ${annual}.`,
      expectedCents: annual,
      actualCents: sum,
      toleranceCents: ctx.toleranceCents,
      detail: { blankMonths: MONTHS.filter((_, i) => monthly[i] === null) },
    };
  });
};

/** 1099-B section subtotals must foot to the package summary page (§6, hard). */
export const bSubtotalsFootToSummary: Check = (ctx) => {
  const rows = ctx.fields.get('box_1d_proceeds');
  const summary = cents(ctx, 'summary_total_proceeds');
  if (summary === null) {
    return na('b_section_subtotals_foot_to_summary', 'hard', 'No package summary proceeds total.');
  }
  // Repeating rows arrive as a pre-summed value on the document when the binder emitted
  // them individually; children carry the per-section subtotals.
  const subtotals = (ctx.children ?? [])
    .filter((c) => c.formType === '1099-B')
    .map((c) => c.fields.get('summary_total_proceeds')?.cents ?? null)
    .filter((v): v is number => v !== null);

  const base = subtotals.length ? subtotals.reduce((a, b) => a + b, 0) : (rows?.cents ?? null);
  if (base === null) {
    return na('b_section_subtotals_foot_to_summary', 'hard', 'No section subtotals to foot.');
  }
  const ok = withinTolerance(base, summary, ctx.toleranceCents);
  return {
    checkKey: 'b_section_subtotals_foot_to_summary',
    severity: 'hard',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Section subtotals foot to the package summary.'
      : `Section subtotals sum to ${base} but the package summary reports ${summary}.`,
    expectedCents: summary,
    actualCents: base,
    toleranceCents: ctx.toleranceCents,
  };
};

/** A consolidated 1099's sub-form totals must tie to its summary (§6, hard). */
export const consolidatedTiesToSummary: Check = (ctx) => {
  const pairs = [
    { summaryKey: 'summary_interest', childForm: '1099-INT', childKey: 'box_1', label: 'interest' },
    { summaryKey: 'summary_ordinary_dividends', childForm: '1099-DIV', childKey: 'box_1a', label: 'ordinary dividends' },
    { summaryKey: 'summary_qualified_dividends', childForm: '1099-DIV', childKey: 'box_1b', label: 'qualified dividends' },
    { summaryKey: 'summary_capital_gain_distributions', childForm: '1099-DIV', childKey: 'box_2a', label: 'capital gain distributions' },
    { summaryKey: 'summary_proceeds', childForm: '1099-B', childKey: 'summary_total_proceeds', label: 'gross proceeds' },
  ] as const;

  return pairs.map((p): CheckResult => {
    const summary = cents(ctx, p.summaryKey);
    const contributions = (ctx.children ?? [])
      .filter((c) => c.formType === p.childForm)
      .map((c) => c.fields.get(p.childKey)?.cents ?? null)
      .filter((v): v is number => v !== null);

    if (summary === null || contributions.length === 0) {
      return na(
        `consolidated_subforms_tie_to_summary:${p.label.replace(/\s+/g, '_')}`,
        'hard',
        `No summary ${p.label} or no sub-form values to tie.`,
      );
    }
    const sum = contributions.reduce((a, b) => a + b, 0);
    const ok = withinTolerance(sum, summary, ctx.toleranceCents);
    return {
      checkKey: `consolidated_subforms_tie_to_summary:${p.label.replace(/\s+/g, '_')}`,
      severity: 'hard',
      outcome: ok ? 'pass' : 'fail',
      message: ok
        ? `Sub-form ${p.label} tie to the package summary.`
        : `Sub-form ${p.label} sum to ${sum} but the package summary reports ${summary}.`,
      expectedCents: summary,
      actualCents: sum,
      toleranceCents: ctx.toleranceCents,
      detail: { subFormCount: contributions.length },
    };
  });
};

/** 1099-K monthly boxes should foot to box 1a. */
export const kMonthlyFootsToGross: Check = (ctx) => {
  const gross = cents(ctx, 'box_1a');
  const monthly = MONTHS.map((m) => cents(ctx, `box_5_${m}`)).filter((v): v is number => v !== null);
  if (gross === null || monthly.length === 0) {
    return na('k_monthly_rows_foot_to_gross', 'hard', 'Box 1a or all monthly boxes are blank.');
  }
  const sum = monthly.reduce((a, b) => a + b, 0);
  const ok = withinTolerance(sum, gross, ctx.toleranceCents);
  return {
    checkKey: 'k_monthly_rows_foot_to_gross',
    severity: 'hard',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Monthly amounts foot to the gross reported in box 1a.'
      : `Monthly boxes sum to ${sum} but box 1a reports ${gross}.`,
    expectedCents: gross,
    actualCents: sum,
    toleranceCents: ctx.toleranceCents,
  };
};

// ── cross-cutting checks ─────────────────────────────────────────────────────

/**
 * Any field the binder could not tie to pixels is a hard failure (§6). This is the check
 * that makes the provenance guarantee enforceable rather than aspirational.
 */
export const everyFieldHasSpans: Check = (ctx) => {
  const orphans = [...ctx.fields.entries()]
    .filter(([, v]) => v.present && v.spanIds.length === 0)
    .map(([k]) => k);
  if (!orphans.length) {
    return { checkKey: 'every_field_has_spans', severity: 'hard', outcome: 'pass', message: 'Every populated field traces to at least one layout span.' };
  }
  return {
    checkKey: 'every_field_has_spans',
    severity: 'hard',
    outcome: 'fail',
    message: `${orphans.length} field(s) carry a value with no layout span: ${orphans.join(', ')}.`,
    detail: { fields: orphans },
  };
};

/** Document tax year differs from the bundle majority (§6, soft). */
export const taxYearMatchesBundle: Check = (ctx) => {
  if (ctx.bundleTaxYear === null || ctx.bundleTaxYear === undefined) {
    return na('tax_year_matches_bundle', 'soft', 'No bundle majority tax year yet.');
  }
  const ok = ctx.taxYear === ctx.bundleTaxYear;
  return {
    checkKey: 'tax_year_matches_bundle',
    severity: 'soft',
    outcome: ok ? 'pass' : 'fail',
    message: ok
      ? 'Document tax year matches the bundle.'
      : `Document is tax year ${ctx.taxYear} but the bundle majority is ${ctx.bundleTaxYear}. ` +
        'A prior-year document in the pile is a real preparer error worth catching (§7).',
    detail: { documentYear: ctx.taxYear, bundleYear: ctx.bundleTaxYear },
  };
};

// ── registry ─────────────────────────────────────────────────────────────────

/**
 * Check key → implementation. Form schemas name the checks that apply to them; these two
 * cross-cutting checks run on every document regardless.
 */
export const CHECKS: Record<string, Check> = {
  w2_ss_tax_rate: w2SsTaxRate,
  w2_ss_wage_base: w2SsWageBase,
  w2_medicare_tax_rate: w2MedicareTaxRate,
  w2_box1_vs_box3_box5: w2Box1VsBox3Box5,
  r_taxable_not_determined: rTaxableNotDetermined,
  r_taxable_not_exceeding_gross: rTaxableNotExceedingGross,
  r_distribution_code_vs_age: rDistributionCodeVsAge,
  div_qualified_not_exceeding_ordinary: divQualifiedNotExceedingOrdinary,
  ssa_box5_equals_box3_minus_box4: ssaBox5Foots,
  a1095_monthly_rows_foot_to_annual: a1095MonthlyFootsToAnnual,
  b_section_subtotals_foot_to_summary: bSubtotalsFootToSummary,
  consolidated_subforms_tie_to_summary: consolidatedTiesToSummary,
  k_monthly_rows_foot_to_gross: kMonthlyFootsToGross,
};

export const ALWAYS_RUN: Check[] = [everyFieldHasSpans, taxYearMatchesBundle];

/** Run the checks a form declares, plus the cross-cutting ones. */
export function runChecks(ctx: CheckContext, declared: readonly string[]): CheckResult[] {
  const results: CheckResult[] = [];
  const run = (check: Check): void => {
    const out = check(ctx);
    if (!out) return;
    if (Array.isArray(out)) results.push(...out);
    else results.push(out);
  };

  for (const key of declared) {
    const check = CHECKS[key];
    if (!check) {
      // A schema naming a check that does not exist is a registration bug, and silently
      // skipping it would quietly weaken the gate.
      throw new Error(`form ${ctx.formType} declares unknown check '${key}'`);
    }
    run(check);
  }
  for (const check of ALWAYS_RUN) run(check);
  return results;
}
