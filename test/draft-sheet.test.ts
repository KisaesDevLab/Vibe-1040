import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildWorksheetModel, type MappedDocument } from '../src/mapping/engine.ts';
import type { FieldValue } from '../src/reconcile/checks.ts';
import { FormRegistry } from '../src/schemas/registry.ts';
import type { DraftSheetModel, HandCheckModel } from '../src/worksheet/draft-sheet.ts';
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

  it('says that a withheld document leaves no mark on the figures', async () => {
    const { text } = await sheetText(draft);
    // This is the sentence that stops the sheet being read as a finished return: the totals are
    // confident numbers computed as though the withheld document did not exist.
    expect(text).toContain('wrong by');
    expect(text).toContain('simply absent');
    expect(text).toContain('as though it did not exist');
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

// ── the hand-check sheet (P17 exit criterion) ────────────────────────────────

const handCheck: HandCheckModel = {
  taxYear: 2025,
  engineVersion: '9.9.9-fake',
  nodeMapVersion: '2025.1',
  mappingVersion: '2025.3',
  filingStatus: 'mfj',
  complete: false,
  documentsIncluded: 1,
  documentsWithheld: 1,
  generatedAt: new Date('2026-09-25T00:00:00Z'),
  omissions: draft.omissions,
  // What a person typed, apart from what was read off a page (P18). The mortgage-interest line
  // is the one that displaces a document, which is the case a checker most needs told.
  preparerFigures: [
    { group: 'This return', label: 'Filing status', valueCents: null, stated: 'Married filing jointly', supersedes: null },
    {
      group: 'Dependents',
      label: 'ANNA SMITH — Daughter, born 2014-03-02, 12 month(s) in the home',
      valueCents: null,
      stated: 'Qualifying child for the child tax credit: not stated — no credit is computed',
      supersedes: null,
    },
    {
      group: 'Itemised deductions',
      label: '8a. Home mortgage interest reported on Form 1098',
      valueCents: 1_500_000,
      stated: null,
      supersedes: '1098 — HERITAGE MORTGAGE CO (box 1)',
    },
  ],
  rows: [
    {
      lineRef: '1040:1a',
      label: 'Form 1040 line 1a — wages',
      reportedCents: 12_700_000,
      computedCents: 12_700_000,
      verdict: 'agrees',
      note: null,
      // Two employers, so the total is only checkable if both are named.
      sources: [
        {
          document: 'W-2 — ACME MANUFACTURING INC',
          fieldLabel: 'box 1 · Wages, tips, other compensation',
          valueCents: 8_500_000,
          wasCorrected: false,
          judgmentReason: undefined,
        },
        {
          document: 'W-2 — OZARK REGIONAL HEALTH',
          fieldLabel: 'box 1 · Wages, tips, other compensation',
          valueCents: 4_200_000,
          wasCorrected: true,
          judgmentReason: undefined,
        },
      ],
    },
    {
      lineRef: '1040:5a',
      label: 'Form 1040 line 5a — pensions',
      reportedCents: 2_500_000,
      computedCents: null,
      verdict: 'engine_silent',
      note: 'The 1099-R was withheld: box 2b is checked.',
      sources: [
        {
          document: '1099-R — VANGUARD FIDUCIARY TRUST',
          fieldLabel: 'box 1 · Gross distribution',
          valueCents: 2_500_000,
          wasCorrected: false,
          judgmentReason: 'Taxable amount not determined',
        },
      ],
    },
  ],
};

async function handCheckText(withCheck: HandCheckModel | undefined): Promise<string | null> {
  const buffer = await buildXlsx(await model(), ctx, undefined, draft, withCheck);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(asExcelBuffer(buffer));
  const sheet = wb.getWorksheet('Hand check');
  if (!sheet) return null;
  const parts: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value));
    });
  });
  return parts.join(' | ');
}

describe('the Hand check sheet', () => {
  it('is absent unless one was asked for', async () => {
    expect(await handCheckText(undefined)).toBeNull();
  });

  it('traces every contributing figure to a named document and a box', async () => {
    const text = (await handCheckText(handCheck))!;
    // The whole reason the sheet exists: a checker holding two W-2s can see which is which
    // without working backwards from the total.
    expect(text).toContain('W-2 — ACME MANUFACTURING INC');
    expect(text).toContain('W-2 — OZARK REGIONAL HEALTH');
    expect(text).toContain('box 1 · Wages, tips, other compensation');
    expect(text).toContain('85000');
    expect(text).toContain('42000');
    // And a figure a human already corrected is marked, because it is the one most worth
    // checking and least worth trusting.
    expect(text).toContain('[corrected]');
  });

  it('puts the omissions above the figures, as every other surface does', async () => {
    const text = (await handCheckText(handCheck))!;
    const omission = text.indexOf('Prior-year carryovers');
    const firstFigure = text.indexOf('1040:1a');
    expect(omission).toBeGreaterThan(-1);
    expect(firstFigure).toBeGreaterThan(-1);
    expect(omission, 'a checker must read what is missing before reconciling anything').toBeLessThan(
      firstFigure,
    );
    expect(text).toMatch(/wrong by whatever these would have contributed/);
  });

  it('names the engine, the maps and the stated filing status', async () => {
    const text = (await handCheckText(handCheck))!;
    // A draft checked against the wrong engine or the wrong season's map proves nothing, so
    // the sheet has to carry what produced it.
    expect(text).toContain('OpenTax 9.9.9-fake');
    expect(text).toContain('node map 2025.1');
    expect(text).toContain('line mapping 2025.3');
    expect(text).toContain('filing status mfj');
    expect(text).toContain('never a finished return');
  });

  it('carries the expected-disagreement note so a checker does not chase it', async () => {
    const text = (await handCheckText(handCheck))!;
    expect(text).toContain('Expected: The 1099-R was withheld');
  });

  it('keeps what a person typed apart from what was read off a page', async () => {
    const text = (await handCheckText(handCheck))!;
    expect(text).toContain('Stated by the preparer — not read from any document');
    expect(text).toContain('Married filing jointly');
    expect(text).toContain('8a. Home mortgage interest reported on Form 1098');
    // A checker has nothing in the packet to tick these against, and must be told so rather
    // than left hunting for a form that was never there.
    expect(text).toMatch(/nothing in the packet to tick them against/);
  });

  it('says which document a typed figure displaced, in the same row as the figure', async () => {
    const text = (await handCheckText(handCheck))!;
    // The one thing in that block a checker must not skim past: a 1098 is sitting in the pile
    // in front of them and the draft deliberately did not use it.
    expect(text).toContain('overrides a document');
    expect(text).toContain('replaces 1098 — HERITAGE MORTGAGE CO (box 1)');
    expect(text).toContain('15000');
  });

  it('carries the determination that decides whether a dependent earns a credit', async () => {
    const text = (await handCheckText(handCheck))!;
    expect(text).toContain('ANNA SMITH');
    // "Not stated" earns no credit while looking like nothing at all, which is exactly why it
    // is spelled out rather than left blank.
    expect(text).toMatch(/not stated — no credit is computed/);
  });

  it('puts what a person typed above the line-by-line figures', async () => {
    const text = (await handCheckText(handCheck))!;
    const stated = text.indexOf('Stated by the preparer');
    const firstFigure = text.indexOf('1040:1a');
    expect(stated).toBeGreaterThan(-1);
    expect(stated).toBeLessThan(firstFigure);
  });

  it('leaves somewhere to sign', async () => {
    expect((await handCheckText(handCheck))!).toContain('Checked by');
  });

  it('is laid out for printing, because it is read beside the paper', async () => {
    const buffer = await buildXlsx(await model(), ctx, undefined, draft, handCheck);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(buffer));
    const sheet = wb.getWorksheet('Hand check')!;
    expect(sheet.pageSetup.orientation).toBe('landscape');
    expect(sheet.pageSetup.fitToPage).toBe(true);
    // Headers on every page: a multi-page sheet whose columns are unlabelled after page one
    // is worse than no sheet.
    expect(sheet.pageSetup.printTitlesRow).toBe('1:1');
  });
});

