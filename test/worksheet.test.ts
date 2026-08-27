import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildWorksheetModel, type MappedDocument } from '../src/mapping/engine.ts';
import type { FieldValue } from '../src/reconcile/checks.ts';
import { FormRegistry } from '../src/schemas/registry.ts';
import type { WorksheetContext } from '../src/worksheet/model.ts';
import { buildPdf } from '../src/worksheet/pdf.ts';
import { buildXlsx } from '../src/worksheet/xlsx.ts';

/** exceljs declares its own Buffer type; node's Buffer is structurally fine here. */
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

async function fixtureModel() {
  const forms = await FormRegistry.load(join(DATA, 'form-schemas'));
  const docs: MappedDocument[] = [
    {
      documentId: 'doc-w2',
      formType: 'W-2',
      taxYear: 2025,
      schema: forms.resolve('W-2', 2025)!.schema,
      fields: new Map<string, FieldValue>([
        ['box_1', field({ cents: 8_500_000 })],
        ['box_2', field({ cents: 1_100_000 })],
        ['box_3', field({ cents: 9_000_000 })],
        ['box_4', field({ cents: 558_000 })],
      ]),
      correctedFieldKeys: new Set(['box_2']),
    },
    {
      documentId: 'doc-int',
      formType: '1099-INT',
      taxYear: 2025,
      schema: forms.resolve('1099-INT', 2025)!.schema,
      fields: new Map<string, FieldValue>([
        ['box_1', field({ cents: 42_350 })],
        ['box_4', field({ present: false })], // blank withholding box
      ]),
    },
    {
      documentId: 'doc-ssa',
      formType: 'SSA-1099',
      taxYear: 2025,
      schema: forms.resolve('SSA-1099', 2025)!.schema,
      fields: new Map<string, FieldValue>([['box_5', field({ cents: 2_400_000 })]]),
    },
  ];

  const model = await buildWorksheetModel(2025, docs, join(DATA, 'line-mappings'));
  const ctx: WorksheetContext = {
    bundleId: 'bundle-1',
    bundleLabel: 'Smith 2025',
    generatedAt: new Date('2026-03-01T12:00:00Z'),
    generatedByName: 'Test Reviewer',
    documentCount: docs.length,
    taxpayers: [{ displayName: 'ROBERT J SMITH', tinLast4: '6789' }],
    documentLabels: new Map([
      ['doc-w2', 'W-2 — ACME CORP'],
      ['doc-int', '1099-INT — FIRST BANK'],
      ['doc-ssa', 'SSA-1099'],
    ]),
    softAnnotations: [{ checkKey: 'w2_box1_vs_box3_box5', message: 'Box 1 differs from box 3.' }],
  };
  return { model, ctx };
}

/** P12 exit criteria. */
describe('worksheet rendering', () => {
  it('generates an XLSX whose totals reconcile to the model', async () => {
    const { model, ctx } = await fixtureModel();
    const bytes = await buildXlsx(model, ctx);
    expect(bytes.length).toBeGreaterThan(2_000);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(bytes));
    const sheet = wb.getWorksheet('Worksheet')!;

    const found = new Map<string, number | null>();
    sheet.eachRow((row) => {
      const ref = row.getCell(1).value;
      if (typeof ref === 'string' && ref.includes(':')) {
        const amount = row.getCell(3).value;
        found.set(ref, typeof amount === 'number' ? Math.round(amount * 100) : null);
      }
    });

    const modelLine = (ref: string) => model.lines.find((l) => l.lineRef === ref)!;
    expect(found.get('1040:1a')).toBe(modelLine('1040:1a').totalCents);
    expect(found.get('1040:2b')).toBe(modelLine('1040:2b').totalCents);
    expect(found.get('1040:6a')).toBe(modelLine('1040:6a').totalCents);
    expect(found.get('1040:1a')).toBe(8_500_000);
  });

  it('keeps the prior-year column present but empty for v1 (§7)', async () => {
    const { model, ctx } = await fixtureModel();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildXlsx(model, ctx)));
    const sheet = wb.getWorksheet('Worksheet')!;
    expect(sheet.getRow(1).getCell(4).value).toBe('Prior year');
    let anyPrior = false;
    sheet.eachRow((row, n) => {
      if (n > 1 && row.getCell(4).value !== null && row.getCell(4).value !== undefined) anyPrior = true;
    });
    expect(anyPrior).toBe(false);
  });

  it('gives Judgment Required its own sheet, populated', async () => {
    const { model, ctx } = await fixtureModel();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildXlsx(model, ctx)));
    const sheet = wb.getWorksheet('Judgment Required')!;
    expect(sheet).toBeDefined();
    // SSA-1099 box 5 maps to line 6a, and its gross-benefits field is judgment-flagged.
    expect(sheet.rowCount).toBeGreaterThan(1);
  });

  it('generates a bookmarked PDF from the same model', async () => {
    const { model, ctx } = await fixtureModel();
    const bytes = await buildPdf(model, ctx);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(3_000);
    const text = bytes.toString('latin1');
    expect(text).toContain('Outlines');
  });

  it('shows a blank contributing box as blank rather than zero (§5)', async () => {
    const { model } = await fixtureModel();
    const withholding = model.lines.find((l) => l.lineRef === '1040:25b')!;
    // The 1099-INT box 4 was blank: it counts as a contributor with no value.
    expect(withholding.nullContributorCount).toBe(1);
    expect(withholding.totalCents).toBeNull();
  });
});
