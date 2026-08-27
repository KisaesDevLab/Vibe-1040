import { describe, expect, it } from 'vitest';
import { runChecks, type CheckContext, type FieldValue } from '../src/reconcile/checks.ts';
import type { TaxTable } from '../src/reconcile/tax-tables.ts';

/** P9 exit criteria, expressed as tests. */

const TABLE_2025: TaxTable = {
  taxYear: 2025,
  socialSecurityWageBaseCents: 17_610_000,
  socialSecurityRate: 0.062,
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  additionalMedicareThresholdCents: 20_000_000,
  notes: [],
};

const field = (v: Partial<FieldValue> = {}): FieldValue => ({
  cents: null,
  text: null,
  bool: null,
  spanIds: ['span-1'],
  present: true,
  ...v,
});

function ctx(fields: Record<string, FieldValue>, overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    formType: 'W-2',
    taxYear: 2025,
    toleranceCents: 100,
    table: TABLE_2025,
    fields: new Map(Object.entries(fields)),
    ...overrides,
  };
}

const find = (results: ReturnType<typeof runChecks>, key: string) =>
  results.find((r) => r.checkKey.startsWith(key));

describe('W-2 hard checks', () => {
  it('blocks when box 4 exceeds box 3 × 6.2%', () => {
    const results = runChecks(
      ctx({
        box_3: field({ cents: 10_000_000 }), // $100,000
        box_4: field({ cents: 700_000 }), // $7,000 — should be $6,200
      }),
      ['w2_ss_tax_rate'],
    );
    const check = find(results, 'w2_ss_tax_rate')!;
    expect(check.severity).toBe('hard');
    expect(check.outcome).toBe('fail');
    expect(check.expectedCents).toBe(620_000);
  });

  it('passes correct social security withholding', () => {
    const results = runChecks(
      ctx({ box_3: field({ cents: 10_000_000 }), box_4: field({ cents: 620_000 }) }),
      ['w2_ss_tax_rate'],
    );
    expect(find(results, 'w2_ss_tax_rate')!.outcome).toBe('pass');
  });

  it('is not applicable when box 3 is blank — a blank box never silently passes', () => {
    const results = runChecks(
      ctx({ box_3: field({ present: false }), box_4: field({ cents: 620_000 }) }),
      ['w2_ss_tax_rate'],
    );
    expect(find(results, 'w2_ss_tax_rate')!.outcome).toBe('not_applicable');
  });

  it('blocks when box 3 exceeds the tax-year wage base', () => {
    const results = runChecks(ctx({ box_3: field({ cents: 20_000_000 }) }), ['w2_ss_wage_base']);
    expect(find(results, 'w2_ss_wage_base')!.outcome).toBe('fail');
  });

  it('reconciles Medicare including the additional 0.9% over $200,000', () => {
    // $250,000 wages → 1.45% of 250k = 3,625 plus 0.9% of 50k = 450 → 4,075
    const results = runChecks(
      ctx({ box_5: field({ cents: 25_000_000 }), box_6: field({ cents: 407_500 }) }),
      ['w2_medicare_tax_rate'],
    );
    expect(find(results, 'w2_medicare_tax_rate')!.outcome).toBe('pass');
  });

  it('blocks Medicare withholding that does not reconcile', () => {
    const results = runChecks(
      ctx({ box_5: field({ cents: 25_000_000 }), box_6: field({ cents: 362_500 }) }),
      ['w2_medicare_tax_rate'],
    );
    expect(find(results, 'w2_medicare_tax_rate')!.outcome).toBe('fail');
  });
});

describe('W-2 soft check', () => {
  it('annotates a legitimate 401(k)-driven box 1 vs box 3 difference and proceeds', () => {
    const results = runChecks(
      ctx({
        box_1: field({ cents: 9_000_000 }), // deferrals reduce box 1
        box_3: field({ cents: 10_000_000 }),
        box_5: field({ cents: 10_000_000 }),
      }),
      ['w2_box1_vs_box3_box5'],
    );
    const check = find(results, 'w2_box1_vs_box3_box5')!;
    expect(check.severity).toBe('soft');
    expect(check.outcome).toBe('fail');
    expect(check.message).toContain('401(k)');
  });
});

describe('provenance', () => {
  it('hard-fails any populated field with no layout span (§4)', () => {
    const results = runChecks(
      ctx({
        box_1: field({ cents: 5_000_000, spanIds: [] }),
        box_2: field({ cents: 100_000, spanIds: ['span-2'] }),
      }),
      [],
    );
    const check = find(results, 'every_field_has_spans')!;
    expect(check.severity).toBe('hard');
    expect(check.outcome).toBe('fail');
    expect(check.message).toContain('box_1');
    expect(check.message).not.toContain('box_2');
  });

  it('ignores blank fields with no spans — a blank box has nothing to point at', () => {
    const results = runChecks(ctx({ box_1: field({ present: false, spanIds: [] }) }), []);
    expect(find(results, 'every_field_has_spans')!.outcome).toBe('pass');
  });
});

describe('1095-A footing', () => {
  const monthly = (premium: number) =>
    Object.fromEntries(
      ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].map(
        (m) => [`monthly_${m}_premium`, field({ cents: premium })],
      ),
    );

  it('passes when monthly rows foot to the annual total', () => {
    const results = runChecks(
      ctx({ ...monthly(50_000), annual_premium: field({ cents: 600_000 }) }, { formType: '1095-A' }),
      ['a1095_monthly_rows_foot_to_annual'],
    );
    expect(find(results, 'a1095_monthly_rows_foot_to_annual:premium')!.outcome).toBe('pass');
  });

  it('blocks when they do not', () => {
    const results = runChecks(
      ctx({ ...monthly(50_000), annual_premium: field({ cents: 550_000 }) }, { formType: '1095-A' }),
      ['a1095_monthly_rows_foot_to_annual'],
    );
    const check = find(results, 'a1095_monthly_rows_foot_to_annual:premium')!;
    expect(check.severity).toBe('hard');
    expect(check.outcome).toBe('fail');
  });
});

describe('consolidated 1099', () => {
  it('blocks when sub-form totals do not tie to the package summary', () => {
    const results = runChecks(
      ctx(
        { summary_interest: field({ cents: 100_000 }) },
        {
          formType: '1099-CONSOLIDATED',
          children: [
            { formType: '1099-INT', fields: new Map([['box_1', field({ cents: 40_000 })]]) },
            { formType: '1099-INT', fields: new Map([['box_1', field({ cents: 35_000 })]]) },
          ],
        },
      ),
      ['consolidated_subforms_tie_to_summary'],
    );
    const check = find(results, 'consolidated_subforms_tie_to_summary:interest')!;
    expect(check.outcome).toBe('fail');
    expect(check.actualCents).toBe(75_000);
    expect(check.expectedCents).toBe(100_000);
  });
});

describe('tax year', () => {
  it('flags a planted prior-year document against the bundle majority', () => {
    const results = runChecks(ctx({}, { taxYear: 2024, bundleTaxYear: 2025 }), []);
    const check = find(results, 'tax_year_matches_bundle')!;
    expect(check.severity).toBe('soft');
    expect(check.outcome).toBe('fail');
  });
});

describe('registry integrity', () => {
  it('refuses to run a check a schema names but that does not exist', () => {
    expect(() => runChecks(ctx({}), ['not_a_real_check'])).toThrow(/unknown check/);
  });
});

describe('excess social security withheld across employers (added 2026-08-26)', () => {
  const w2 = (employer: string, box4: number | null) => ({
    documentId: `doc-${employer}`,
    employer,
    box3: 15_000_000,
    box4,
  });

  const bundleCtx = (
    groups: { taxpayerId: string | null; taxpayerLabel: string; w2s: ReturnType<typeof w2>[] }[],
  ) => ({ taxYear: 2025, toleranceCents: 100, table: TABLE_2025, w2sByTaxpayer: groups });

  // 176,100 x 6.2% = 10,918.20 maximum for 2025.
  const MAX = 1_091_820;

  it('flags an overage across two employers as a Schedule 3 credit', async () => {
    const { excessSocialSecurityWithheld } = await import('../src/reconcile/checks.ts');
    const [result] = excessSocialSecurityWithheld(
      bundleCtx([
        {
          taxpayerId: 'tp-1',
          taxpayerLabel: 'Taxpayer …6789',
          w2s: [w2('ACME', 700_000), w2('OZARK', 600_000)],
        },
      ]),
    );
    expect(result!.severity).toBe('soft');
    expect(result!.outcome).toBe('fail');
    expect(result!.actualCents).toBe(1_300_000);
    expect(result!.expectedCents).toBe(MAX);
    expect(result!.detail?.['excessCents']).toBe(1_300_000 - MAX);
    expect(result!.message).toMatch(/Schedule 3 credit/);
    // It is explicitly not a W-2 error — that distinction is the point.
    expect(result!.message).toMatch(/not an error on any individual W-2/);
  });

  it('passes when the combined total is within the annual maximum', async () => {
    const { excessSocialSecurityWithheld } = await import('../src/reconcile/checks.ts');
    const [result] = excessSocialSecurityWithheld(
      bundleCtx([
        {
          taxpayerId: 'tp-1',
          taxpayerLabel: 'Taxpayer …6789',
          w2s: [w2('ACME', 500_000), w2('OZARK', 400_000)],
        },
      ]),
    );
    expect(result!.outcome).toBe('pass');
  });

  it('does not fire for a single employer — that would be a per-W-2 error instead', async () => {
    const { excessSocialSecurityWithheld } = await import('../src/reconcile/checks.ts');
    const results = excessSocialSecurityWithheld(
      bundleCtx([
        { taxpayerId: 'tp-1', taxpayerLabel: 'Taxpayer …6789', w2s: [w2('ACME', 2_000_000)] },
      ]),
    );
    expect(results).toHaveLength(0);
  });

  it('applies the limit per taxpayer — each spouse has their own wage base', async () => {
    const { excessSocialSecurityWithheld } = await import('../src/reconcile/checks.ts');
    const results = excessSocialSecurityWithheld(
      bundleCtx([
        {
          taxpayerId: 'tp-1',
          taxpayerLabel: 'Robert',
          w2s: [w2('ACME', 600_000), w2('BOREAL', 600_000)],
        },
        {
          taxpayerId: 'tp-2',
          taxpayerLabel: 'Maria',
          w2s: [w2('OZARK', 400_000), w2('CEDAR', 400_000)],
        },
      ]),
    );
    expect(results).toHaveLength(2);
    // Combined across the couple would be 2,000,000 — well over — but per person only
    // Robert exceeds. Summing across spouses would invent a credit that does not exist.
    expect(results.find((r) => r.message.startsWith('Robert'))!.outcome).toBe('fail');
    expect(results.find((r) => r.message.startsWith('Maria'))!.outcome).toBe('pass');
  });

  it('ignores blank box 4 values rather than treating them as zero (§5)', async () => {
    const { excessSocialSecurityWithheld } = await import('../src/reconcile/checks.ts');
    const results = excessSocialSecurityWithheld(
      bundleCtx([
        {
          taxpayerId: 'tp-1',
          taxpayerLabel: 'Taxpayer …6789',
          w2s: [w2('ACME', 900_000), w2('OZARK', null)],
        },
      ]),
    );
    // Only one usable figure, so there is nothing to compare across employers.
    expect(results).toHaveLength(0);
  });
});
