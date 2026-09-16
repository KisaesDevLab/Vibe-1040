import { describe, expect, it } from 'vitest';
import {
  noLayoutSpansResult,
  noRegisteredSchemaResult,
  runChecks,
  schemaYearSubstitutedResult,
  type CheckContext,
  type FieldValue,
} from '../src/reconcile/checks.ts';
import type { TaxTable } from '../src/reconcile/tax-tables.ts';

const TABLE_2025: TaxTable = {
  taxYear: 2025,
  socialSecurityWageBaseCents: 17_610_000,
  socialSecurityRate: 0.062,
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  additionalMedicareThresholdCents: 20_000_000,
  notes: [],
};

const field = (v: Partial<FieldValue>): FieldValue => ({
  cents: null,
  text: null,
  bool: null,
  spanIds: ['s'],
  present: v.cents !== undefined || v.text !== undefined || v.bool !== undefined,
  ...v,
});

const ctx = (
  fields: Record<string, FieldValue>,
  overrides: Partial<CheckContext> = {},
): CheckContext => ({
  formType: '1099-CONSOLIDATED',
  taxYear: 2025,
  toleranceCents: 100,
  table: TABLE_2025,
  fields: new Map(Object.entries(fields)),
  bundleTaxYear: 2025,
  ...overrides,
});

const find = (results: ReturnType<typeof runChecks>, key: string) => results.find((r) => r.checkKey === key);

/**
 * Each Form 8949 section of a 1099-B is its own document, carrying the subtotal printed at
 * its foot; the package summary reports one gross-proceeds figure (§6).
 */
describe('1099-B section subtotals foot to the package summary', () => {
  const section = (code: string, proceeds: number | null) => ({
    formType: '1099-B',
    fields: new Map<string, FieldValue>([
      ['section_code', field({ text: code })],
      ['section_total_proceeds', field(proceeds === null ? {} : { cents: proceeds })],
    ]),
  });

  it('passes when the sections sum to the summary within tolerance', () => {
    const results = runChecks(
      ctx({ summary_proceeds: field({ cents: 4_694_500 }) }, { children: [section('A', 2_454_500), section('B', 2_240_000)] }),
      ['b_section_subtotals_foot_to_summary'],
    );
    const check = find(results, 'b_section_subtotals_foot_to_summary')!;
    expect(check.outcome).toBe('pass');
    expect(check.severity).toBe('hard');
  });

  it('blocks when they do not, naming the sections', () => {
    const results = runChecks(
      ctx({ summary_proceeds: field({ cents: 4_694_500 }) }, { children: [section('A', 2_454_500), section('D', 1_000_000)] }),
      ['b_section_subtotals_foot_to_summary'],
    );
    const check = find(results, 'b_section_subtotals_foot_to_summary')!;
    expect(check.outcome).toBe('fail');
    expect(check.actualCents).toBe(3_454_500);
    expect(check.expectedCents).toBe(4_694_500);
    expect(check.detail).toMatchObject({ sections: [{ section: 'A' }, { section: 'D' }] });
  });

  it('is not applicable with no summary or no section subtotals, never a silent pass', () => {
    const noSummary = runChecks(ctx({}, { children: [section('A', 1)] }), ['b_section_subtotals_foot_to_summary']);
    expect(find(noSummary, 'b_section_subtotals_foot_to_summary')!.outcome).toBe('not_applicable');
    const noSubtotals = runChecks(
      ctx({ summary_proceeds: field({ cents: 1 }) }, { children: [section('A', null)] }),
      ['b_section_subtotals_foot_to_summary'],
    );
    expect(find(noSubtotals, 'b_section_subtotals_foot_to_summary')!.outcome).toBe('not_applicable');
  });

  it('no longer double-reports proceeds through the generic sub-form tie', () => {
    const results = runChecks(
      ctx({ summary_proceeds: field({ cents: 1 }) }, { children: [section('A', 2)] }),
      ['consolidated_subforms_tie_to_summary'],
    );
    expect(results.some((r) => r.checkKey.startsWith('consolidated_subforms_tie_to_summary:gross'))).toBe(false);
  });
});

/**
 * Document-state failures are recomputed at reconcile from the document row, so they
 * survive the check-result reset that used to delete them.
 */
describe('document-state results', () => {
  it('a form type with no schema in any year is a hard failure that names the type', () => {
    const r = noRegisteredSchemaResult('1099-DA', 2025);
    expect(r).toMatchObject({ checkKey: 'no_registered_schema', severity: 'hard', outcome: 'fail' });
    expect(r.message).toContain('1099-DA');
  });

  it('a form document with no layout spans is a hard failure', () => {
    expect(noLayoutSpansResult('W-2')).toMatchObject({ checkKey: 'no_layout_spans', severity: 'hard', outcome: 'fail' });
  });

  it('reading a document with another season\'s schema is a soft annotation', () => {
    const r = schemaYearSubstitutedResult('W-2', 2024, 2025);
    expect(r).toMatchObject({ checkKey: 'schema_year_substituted', severity: 'soft', outcome: 'fail' });
    expect(r.message).toContain('2024');
    expect(r.message).toContain('2025');
  });
});
