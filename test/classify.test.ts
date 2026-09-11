import { describe, expect, it } from 'vitest';
import { groupPages, majorityTaxYear, type PageClassification } from '../src/classify/pass.ts';

const page = (
  pageId: string,
  form_type: string | null,
  overrides: Partial<PageClassification> = {},
): PageClassification => ({
  pageId,
  form_type,
  confidence: 0.9,
  continues_previous: false,
  corrected: false,
  void: false,
  is_summary: false,
  is_supplemental: false,
  unrecognised_form: false,
  payer_name: null,
  tax_year: 2025,
  model: 'digitalocean/glm-5.3-flash',
  requestId: `req-${pageId}`,
  ...overrides,
});

describe('groupPages', () => {
  it('carries the classifying model and request id of the first page onto the group', () => {
    const groups = groupPages([
      page('p1', 'W-2'),
      page('p2', 'W-2', { continues_previous: true, model: 'other-model', requestId: 'req-p2' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      formType: 'W-2',
      pageIds: ['p1', 'p2'],
      classifierModel: 'digitalocean/glm-5.3-flash',
      classifierRequestId: 'req-p1',
    });
  });

  it('only continues a document when the form type agrees', () => {
    const groups = groupPages([page('p1', '1099-INT'), page('p2', '1099-DIV', { continues_previous: true })]);
    expect(groups.map((g) => g.formType)).toEqual(['1099-INT', '1099-DIV']);
  });

  it('parents sub-forms to an open consolidated package', () => {
    const groups = groupPages([
      page('p1', '1099-CONSOLIDATED'),
      page('p2', '1099-INT'),
      page('p3', '1099-B'),
      page('p4', 'W-2'),
    ]);
    expect(groups.map((g) => g.parentIndex)).toEqual([undefined, 0, 0, undefined]);
  });
});

describe('majorityTaxYear', () => {
  it('takes the bundle majority', () => {
    const groups = groupPages([page('p1', 'W-2'), page('p2', '1098', { tax_year: 2024 }), page('p3', '1099-INT')]);
    expect(majorityTaxYear(groups)).toBe(2025);
  });
});

/**
 * A tax document the classifier cannot name must stay visible.
 *
 * Before this, `form_type: null` meant both "cover letter" and "a tax form I do not
 * recognise", and the pipeline skipped both. An SSA-1042S in a real client packet was
 * therefore dropped in silence — the failure this product exists to prevent.
 */
describe('unrecognised forms', () => {
  it('keeps an unrecognised page as its own document rather than folding it away', () => {
    const groups = groupPages([
      page('p1', 'W-2'),
      page('p2', null, { is_supplemental: true, unrecognised_form: true }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.unrecognisedForm).toBe(true);
  });

  it('does not flag an ordinary cover letter', () => {
    const groups = groupPages([page('p1', null, { is_supplemental: true })]);
    expect(groups[0]!.unrecognisedForm).toBe(false);
  });

  it('carries the flag when an unrecognised page continues onto another page', () => {
    const groups = groupPages([
      page('p1', null, { is_supplemental: true, unrecognised_form: true }),
      page('p2', null, { is_supplemental: true, continues_previous: true }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pageIds).toEqual(['p1', 'p2']);
    expect(groups[0]!.unrecognisedForm).toBe(true);
  });
});
