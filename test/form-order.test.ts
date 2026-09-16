import { describe, expect, it } from 'vitest';
import { compareFormTypes, loadFormOrder, placementOf, sortDocuments } from '../src/worksheet/form-order.ts';
import { bookmarkTitle } from '../src/worksheet/sorted-pdf.ts';

const doc = (formType: string | null, payerName = '', extra: Record<string, unknown> = {}) => ({
  formType,
  payerName,
  sectionCode: null,
  isSupplemental: false,
  ...extra,
});

describe('return order', () => {
  it('loads and covers every registered form type or files it under Other forms', () => {
    const order = loadFormOrder();
    expect(order.groups[0]!.forms).toContain('W-2');
    expect(placementOf(doc('1099-DA')).groupLabel).toBe('Other forms');
    expect(placementOf(doc(null, '', { isSupplemental: true })).groupLabel).toBe('Other pages');
  });

  it('sorts a packet the way the return reads', () => {
    const sorted = sortDocuments([
      doc(null, '', { isSupplemental: true }),
      doc('1098', 'HERITAGE MORTGAGE'),
      doc('1099-DIV', 'NORTHSHORE'),
      doc('SSA-1099'),
      doc('W-2', 'OZARK'),
      doc('1099-INT', 'FIRST BANK'),
      doc('W-2', 'ACME'),
      doc('K-1-1065', 'SPRINGFIELD'),
      doc('1099-R', 'VANGUARD'),
      doc('1099-B', 'NORTHSHORE', { sectionCode: 'D' }),
      doc('1099-B', 'NORTHSHORE', { sectionCode: 'A' }),
    ]);
    expect(sorted.map((d) => `${d.formType ?? '-'}${d.payerName ? ':' + d.payerName : ''}${d.sectionCode ? '/' + d.sectionCode : ''}`)).toEqual([
      'W-2:ACME',
      'W-2:OZARK',
      '1099-INT:FIRST BANK',
      '1099-DIV:NORTHSHORE',
      '1099-R:VANGUARD',
      'SSA-1099',
      '1099-B:NORTHSHORE/A',
      '1099-B:NORTHSHORE/D',
      'K-1-1065:SPRINGFIELD',
      '1098:HERITAGE MORTGAGE',
      '-',
    ]);
  });

  it('orders form types alone, for the workbook sheets', () => {
    expect(['1099-INT', 'W-2', '1098', '1099-B'].sort(compareFormTypes)).toEqual(['W-2', '1099-INT', '1099-B', '1098']);
  });

  it('names bookmarks from the form, section, issuer and flags', () => {
    const base = { corrected: false, void: false, isSupplemental: false, unrecognisedForm: false, sectionCode: null };
    expect(bookmarkTitle({ ...base, formType: 'W-2', payerName: 'ACME MANUFACTURING INC' })).toBe('W-2 — ACME MANUFACTURING INC');
    expect(bookmarkTitle({ ...base, formType: '1099-B', payerName: 'NORTHSHORE', sectionCode: 'A', corrected: true })).toBe(
      '1099-B — section A — NORTHSHORE — [CORRECTED]',
    );
    expect(bookmarkTitle({ ...base, formType: null, payerName: null, isSupplemental: true })).toBe('Other page');
    expect(bookmarkTitle({ ...base, formType: null, payerName: null, unrecognisedForm: true })).toBe('Unrecognised tax document');
  });
});
