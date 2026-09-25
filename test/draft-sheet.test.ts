import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildWorksheetModel, type MappedDocument } from '../src/mapping/engine.ts';
import type { FieldValue } from '../src/reconcile/checks.ts';
import { FormRegistry } from '../src/schemas/registry.ts';
import type { DraftSheetModel } from '../src/worksheet/draft-sheet.ts';
import type { WorksheetContext } from '../src/worksheet/model.ts';
import { buildXlsx } from '../src/worksheet/xlsx.ts';

/**
 * The workbook's `Draft Return` sheet (P17 stage 3).
 *
 * The sheet is what a preparer actually opens, and a spreadsheet full of tax figures reads as
 * authoritative whatever the header says. So the tests here are less about layout than about
 * three claims that must hold on the artifact itself: the omissions are on the same sheet as
 * the figures, the engine and its version are named, and a workbook still builds when no draft
 * return exists — which is the ordinary case.
 */
const asExcelBuffer = (b: Buffer) => b as unknown as Parameters<ExcelJS.Xlsx['load']>[0];
const DATA = join(process.cwd(), 'data');

const field = (v: Partial<FieldValue> = {}): FieldValue => ({
  cents: null,
  text: null,
  bool: null,
  spanIds: ['s1'],
  present: true,
  ...v,
});

async function model() {
  const forms = await FormRegistry.load(join(DATA, 'form-schemas'));
  const docs: MappedDocument[] = [
    {
      documentId: 'doc-w2',
      formType: 'W-2',
      taxYear: 2025,
      schema: forms.resolve('W-2', 2025)!.schema,
      fields: new Map<string, FieldValue>([
        ['box_1', field({ cents: 8_500_000 })],
        ['box_2', field({ cents: 1_142_000 })],
      ]),
    },
  ];
  return buildWorksheetModel(2025, docs, join(DATA, 'line-mappings'));
}

const ctx: WorksheetContext = {
  bundleId: 'b-1',
  bundleLabel: 'Draft sheet test',
  generatedAt: new Date('2026-09-25T00:00:00Z'),
  generatedByName: 'Tester',
  documentCount: 1,
  taxpayers: [{ displayName: 'ROBERT J SMITH', tinLast4: '6789' }],
  documentLabels: new Map([['doc-w2', 'W-2 — ACME']]),
  softAnnotations: [],
};

const draft: DraftSheetModel = {
  engineVersion: '9.9.9-fake',
  nodeMapVersion: '2025.1',
  complete: false,
  documentsIncluded: 1,
  documentsWithheld: 1,
  lines: [
    {
      lineRef: '1040:1a',
      label: 'Form 1040 line 1a — wages',
      reportedCents: 8_500_000,
      computedCents: 8_500_000,
      verdict: 'agrees',
      note: null,
    },
    {
      lineRef: '1040:5a',
      label: 'Form 1040 line 5a — pensions',
      reportedCents: 2_500_000,
      computedCents: 0,
      verdict: 'differs',
      note: 'The 1099-R was withheld: box 2b is checked.',
    },
    {
      lineRef: null,
      label: 'Adjusted gross income',
      reportedCents: null,
      computedCents: 8_500_000,
      verdict: 'computed_only',
      note: null,
    },
  ],
  omissions: [
    {
      formType: '1099-R',
      fieldKey: 'box_2b_not_determined',
      reason: 'judgment_required',
      detail: "box 2b (taxable amount not determined) needs a preparer's judgment.",
    },
    {
      formType: null,
      fieldKey: 'carryovers',
      reason: 'not_in_bundle',
      detail: 'Prior-year carryovers are not on any source document.',
    },
  ],
  validations: [
    { severity: 'hard', code: 'F1040-001', message: 'filing status is required' },
    { severity: 'soft', code: 'F1040-900', message: 'no dependents were supplied' },
  ],
};

async function sheetText(withDraft: DraftSheetModel | undefined): Promise<{
  wb: ExcelJS.Workbook;
  text: string | null;
}> {
  const buffer = await buildXlsx(await model(), ctx, undefined, withDraft);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(asExcelBuffer(buffer));
  const sheet = wb.getWorksheet('Draft Return');
  if (!sheet) return { wb, text: null };

  const parts: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value));
    });
  });
  return { wb, text: parts.join(' | ') };
}

describe('the Draft Return sheet', () => {
  it('is absent when no draft return has been computed — the ordinary case', async () => {
    const { wb, text } = await sheetText(undefined);
    expect(text).toBeNull();
    // And the rest of the workbook is unaffected.
    expect(wb.getWorksheet('Worksheet')).toBeDefined();
    expect(wb.getWorksheet('Summary')).toBeDefined();
  });

  it('puts reported and computed side by side, with the difference', async () => {
    const { text } = await sheetText(draft);
    expect(text).toContain('Documents report');
    expect(text).toContain('Engine computes');
    expect(text).toContain('1040:1a');
    expect(text).toContain('agrees');
    expect(text).toContain('DIFFERS — look');
  });

  it('carries an engine-only figure with no line ref', async () => {
    const { text } = await sheetText(draft);
    expect(text).toContain('Adjusted gross income');
    expect(text).toContain('computed only');
  });

  it('lists the omissions on the same sheet as the figures', async () => {
    const { text } = await sheetText(draft);
    // A preparer who reads only this sheet must still see what is missing from it.
    expect(text).toContain('Not in this draft');
    expect(text).toContain('judgment required');
    expect(text).toContain('1099-R');
    expect(text).toContain('carryovers');
  });

  it('says why a computed zero is not a reported zero', async () => {
    const { text } = await sheetText(draft);
    // This is the sentence that stops the sheet being read as a finished return.
    expect(text).toContain('computes to zero');
    expect(text).toContain('wrong by');
  });

  it("shows the engine's own diagnostics, hard and soft apart", async () => {
    const { text } = await sheetText(draft);
    expect(text).toContain('F1040-001');
    expect(text).toContain('F1040-900');
    expect(text).toContain('hard');
    expect(text).toContain('soft');
  });

  it('says so when nothing was left out', async () => {
    const { text } = await sheetText({ ...draft, omissions: [], complete: true });
    expect(text).toContain('Nothing was left out.');
  });
});
