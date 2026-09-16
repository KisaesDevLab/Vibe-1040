import { describe, expect, it } from 'vitest';
import {
  groupPages,
  normalizeFormType,
  normalizeSectionCode,
  preclassifyFromText,
  type PageClassification,
} from '../src/classify/pass.ts';

const KNOWN = [
  '1095-A', '1098', '1098-E', '1098-T', '1099-B', '1099-CONSOLIDATED', '1099-DIV', '1099-INT',
  '1099-K', '1099-MISC', '1099-NEC', '1099-R', '5498', '5498-SA', 'K-1-1041', 'K-1-1065',
  'K-1-1120S', 'RRB-1099', 'SSA-1042S', 'SSA-1099', 'W-2', 'W-2G',
];

/**
 * The classifier's form_type is a free string (an enum would make the router fail the
 * whole response on one creative spelling). A spelling the registry does not know used to
 * become `no_registered_schema` — and then be deleted by reconcile. Normalize instead.
 */
describe('normalizeFormType', () => {
  it.each([
    ['W-2', 'W-2'],
    ['w-2', 'W-2'],
    ['W2', 'W-2'],
    ['Form W-2', 'W-2'],
    ['Form W2 Wage and Tax Statement', 'Form W2 Wage and Tax Statement'], // not a form key; returned as-is
    ['W-2G', 'W-2G'],
    ['1099INT', '1099-INT'],
    ['1099 INT', '1099-INT'],
    ['Form 1099-INT', '1099-INT'],
    ['form 1099_div', '1099-DIV'],
    ['1099-B', '1099-B'],
    ['Consolidated 1099', '1099-CONSOLIDATED'],
    ['1099 Composite', '1099-CONSOLIDATED'],
    ['Schedule K-1 (Form 1065)', 'K-1-1065'],
    ['K-1 1065', 'K-1-1065'],
    ['K1-1065', 'K-1-1065'],
    ['Schedule K-1 (Form 1120-S)', 'K-1-1120S'],
    ['K-1 (1041)', 'K-1-1041'],
    ['SSA 1099', 'SSA-1099'],
    ['SSA1099', 'SSA-1099'],
    ['Form SSA-1042-S', 'SSA-1042S'],
    ['SSA-1042S', 'SSA-1042S'],
    ['1099-SSA', 'SSA-1099'],
    ['5498 SA', '5498-SA'],
    ['1095A', '1095-A'],
    ['1098-T', '1098-T'],
  ])('maps %j to %j', (raw, expected) => {
    expect(normalizeFormType(raw, KNOWN)).toBe(expected);
  });

  it('keeps null and blank as null', () => {
    expect(normalizeFormType(null, KNOWN)).toBeNull();
    expect(normalizeFormType('   ', KNOWN)).toBeNull();
  });

  it('returns an unknown spelling trimmed rather than dropping it', () => {
    expect(normalizeFormType('  Form 1099-DA ', KNOWN)).toBe('Form 1099-DA');
  });
});

describe('normalizeSectionCode', () => {
  it.each([
    ['A', 'A'],
    ['Box D', 'D'],
    ['section b', 'B'],
    ['Short-term, basis reported — Box A checked', 'A'],
    ['', null],
    [null, null],
    ['Z', null],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeSectionCode(raw)).toBe(expected);
  });
});

/** The exact text layer names the form; it is a cross-check, and it never invents a type. */
describe('preclassifyFromText', () => {
  it('reads the form number and the dominant year off a native page', () => {
    const hint = preclassifyFromText(
      'Form W-2 Wage and Tax Statement 2025\nCopy B\nOMB No. 1545-0029\n2025',
      KNOWN,
    );
    expect(hint).toMatchObject({ formType: 'W-2', taxYear: 2025 });
  });

  it('does not mistake a form revision date for the tax year', () => {
    // A continuous-use 1099-INT prints "(Rev. January 2024)" twice and "2025" once.
    const hint = preclassifyFromText(
      'OMB No. 1545-0112 Form 1099-INT (Rev. January 2024) 2025 Interest Income Copy B\nForm 1099-INT (Rev. 1-2024)',
      KNOWN,
    );
    expect(hint).toMatchObject({ formType: '1099-INT', taxYear: 2025 });
    expect(preclassifyFromText('Form 1099-NEC (Rev. April 2025) For calendar year 2025', KNOWN)?.taxYear).toBe(2025);
    expect(preclassifyFromText('Form 1099-MISC (Rev. April 2025)', KNOWN)?.taxYear).toBeNull();
  });

  it('takes the year in the title box over dates elsewhere on the page', () => {
    // A 5498 for 2025 is issued in 2026 and talks about 2026 more than once.
    const text =
      '2025 Form 5498 IRA Contribution Information\nContributions made in 2026 for 2025 by April 15, 2026\nFile by May 31, 2026';
    expect(preclassifyFromText(text, KNOWN)).toMatchObject({ formType: '5498', taxYear: 2025 });
    expect(preclassifyFromText('Form 1098-E 2025 Student Loan Interest Statement', KNOWN)?.taxYear).toBe(2025);
  });

  it('handles 1099 variants, 1098, and K-1s', () => {
    expect(preclassifyFromText('Form 1099-INT Interest Income', KNOWN)?.formType).toBe('1099-INT');
    expect(preclassifyFromText('Form 1098 Mortgage Interest Statement', KNOWN)?.formType).toBe('1098');
    expect(preclassifyFromText('Form 1098-T Tuition Statement', KNOWN)?.formType).toBe('1098-T');
    expect(preclassifyFromText('Schedule K-1 (Form 1065) 2025', KNOWN)?.formType).toBe('K-1-1065');
    expect(preclassifyFromText('Form SSA-1099 - Social Security Benefit Statement', KNOWN)?.formType).toBe('SSA-1099');
  });

  it('returns null for text that names no registered form', () => {
    expect(preclassifyFromText('Dear client, enclosed please find your documents.', KNOWN)).toBeNull();
    expect(preclassifyFromText(null, KNOWN)).toBeNull();
    // A form the registry does not carry is not promoted to something it is not.
    expect(preclassifyFromText('Form 1099-DA Digital Asset Proceeds', KNOWN)).toBeNull();
  });
});

const page = (
  overrides: Partial<PageClassification> & { pageId: string },
): PageClassification => ({
  form_type: '1099-B',
  confidence: 0.9,
  continues_previous: true,
  corrected: false,
  void: false,
  is_summary: false,
  is_supplemental: false,
  unrecognised_form: false,
  payer_name: null,
  tax_year: 2025,
  section_code: null,
  model: 'm',
  requestId: 'r',
  ...overrides,
});

/**
 * Section subtotals only foot when each Form 8949 section is its own document (§6). The
 * model's `continues_previous` is overruled by a new section heading.
 */
describe('1099-B section splitting', () => {
  it('starts a new document when the section letter changes, even if the model says it continues', () => {
    const groups = groupPages([
      page({ pageId: 'p1', continues_previous: false, section_code: 'A' }),
      page({ pageId: 'p2', continues_previous: true, section_code: 'A' }),
      page({ pageId: 'p3', continues_previous: true, section_code: 'D' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ sectionCode: 'A', pageIds: ['p1', 'p2'] });
    expect(groups[1]).toMatchObject({ sectionCode: 'D', pageIds: ['p3'] });
  });

  it('lets a continuation page without a visible heading inherit the open section', () => {
    const groups = groupPages([
      page({ pageId: 'p1', continues_previous: false, section_code: 'B' }),
      page({ pageId: 'p2', continues_previous: true, section_code: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ sectionCode: 'B', pageIds: ['p1', 'p2'] });
  });

  it('records no section on forms other than a 1099-B', () => {
    const groups = groupPages([page({ pageId: 'p1', form_type: 'W-2', continues_previous: false, section_code: 'A' })]);
    expect(groups[0]!.sectionCode).toBeNull();
  });
});
