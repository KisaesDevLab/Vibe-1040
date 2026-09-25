import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildWorksheetModel, type MappedDocument } from '../src/mapping/engine.ts';
import type { FieldValue } from '../src/reconcile/checks.ts';
import { FormRegistry, type FormSchema } from '../src/schemas/registry.ts';
import type { WorksheetContext } from '../src/worksheet/model.ts';
import { planFormSheets, buildXlsx, sheetNameFor } from '../src/worksheet/xlsx.ts';
import { reviewModelFrom, type ReviewDocument, type ReviewField } from '../src/worksheet/review.ts';

const asExcelBuffer = (b: Buffer) => b as unknown as Parameters<ExcelJS.Xlsx['load']>[0];
const DATA = join(process.cwd(), 'data');

const fv = (v: Partial<FieldValue> = {}): FieldValue => ({
  cents: null,
  text: null,
  bool: null,
  spanIds: ['s1'],
  present: v.cents !== undefined || v.text !== undefined || v.bool !== undefined,
  ...v,
});

/** A review document whose fields follow the schema; `reads` says what the binder returned. */
function reviewDoc(
  schema: FormSchema,
  meta: Partial<ReviewDocument> & { documentId: string; payerName: string },
  reads: Record<string, Partial<ReviewField> & { cents?: number | null; text?: string | null; bool?: boolean | null }>,
): ReviewDocument {
  const fields: ReviewField[] = schema.fields
    .filter((f) => f.sensitive !== 'tin')
    .map((f) => {
      const r = reads[f.key];
      const cents = r?.cents ?? null;
      const text = r?.text ?? null;
      const bool = r?.bool ?? null;
      return {
        fieldKey: f.key,
        box: f.box ?? null,
        label: f.label,
        type: f.type,
        cents,
        text,
        bool,
        present: (cents !== null || text !== null || bool !== null) && !(f.type === 'bool' && bool === false),
        read: r !== undefined,
        needsReview: r?.needsReview ?? false,
        reviewReason: r?.reviewReason ?? null,
        disagreed: false,
        wasCorrected: r?.wasCorrected ?? false,
        original: r?.original ?? { cents, text, bool },
        spanCount: r?.spanCount ?? 1,
        judgmentRequired: f.judgmentRequired,
        judgmentReason: f.judgmentReason ?? null,
        lineRefs: r?.lineRefs ?? [],
      };
    });
  return {
    formType: schema.formType,
    schemaVersion: schema.version,
    taxpayerLabel: 'ROBERT J SMITH (…6789)',
    taxYear: 2025,
    taxYearMismatch: false,
    sectionCode: null,
    corrected: false,
    void: false,
    isSupplemental: false,
    isSummary: false,
    unrecognisedForm: false,
    parentDocumentId: null,
    extractionOutcome: 'extracted',
    pages: [{ filename: 'packet.pdf', pageNumber: 1, layoutSource: 'text_layer', spanCount: 90, route: 'text_layer' }],
    fields,
    checks: [],
    provenance: { classifierModel: 'glm', extractionModel: 'qwen', passCount: 1 },
    ...meta,
  };
}

async function build() {
  const forms = await FormRegistry.load(join(DATA, 'form-schemas'));
  const w2 = forms.resolve('W-2', 2025)!.schema;
  const int = forms.resolve('1099-INT', 2025)!.schema;

  const docs: MappedDocument[] = [
    {
      documentId: 'w2-a',
      formType: 'W-2',
      taxYear: 2025,
      schema: w2,
      fields: new Map([['box_1', fv({ cents: 8_500_000 })], ['box_2', fv({ cents: 1_142_000 })]]),
    },
    {
      documentId: 'w2-b',
      formType: 'W-2',
      taxYear: 2025,
      schema: w2,
      fields: new Map([['box_1', fv({ cents: 4_200_000 })], ['box_2', fv({ cents: 402_000 })]]),
    },
    { documentId: 'int-a', formType: '1099-INT', taxYear: 2025, schema: int, fields: new Map([['box_1', fv({ cents: 13_542 })]]) },
  ];
  const model = await buildWorksheetModel(2025, docs, join(DATA, 'line-mappings'));

  const review = reviewModelFrom({
    taxYear: 2025,
    documents: [
      reviewDoc(w2, { documentId: 'w2-a', payerName: 'ACME MANUFACTURING INC' }, {
        box_1: { cents: 8_500_000, lineRefs: ['1040:1a'] },
        box_2: { cents: 1_142_000, needsReview: true, reviewReason: 'span_mismatch' },
        box_3: { cents: 9_000_000 },
        box_7: { cents: null }, // blank
        box_8: { cents: 0 }, // printed zero
        box_13_retirement: { bool: true },
        box_13_statutory: { bool: false },
        box_16: { cents: 9_000_000, wasCorrected: true, original: { cents: 9_100_000, text: null, bool: null } },
      }),
      reviewDoc(w2, { documentId: 'w2-b', payerName: 'OZARK REGIONAL HEALTH' }, {
        box_1: { cents: 4_200_000 },
        box_2: { cents: 402_000 },
        box_7: { cents: null },
      }),
      reviewDoc(int, { documentId: 'int-a', payerName: 'STATE EMPLOYEES CREDIT UNION' }, {
        box_1: { cents: 13_542 },
      }),
      {
        ...reviewDoc(int, { documentId: 'cover', payerName: '' }, {}),
        formType: null,
        fields: [],
        isSupplemental: true,
        extractionOutcome: 'skipped_supplemental',
        payerName: null,
      },
    ],
  });
  review.documents[0]!.checks = [
    {
      checkKey: 'w2_ss_tax_rate',
      severity: 'hard',
      outcome: 'fail',
      message: 'Box 4 exceeds box 3 × 6.2%.',
      expectedCents: 558_000,
      actualCents: 600_000,
      toleranceCents: 100,
      disposition: { kind: 'accepted_as_is', note: 'employer error confirmed', by: 'Reviewer', at: new Date() },
    },
    { checkKey: 'w2_box1_vs_box3_box5', severity: 'soft', outcome: 'fail', message: 'differs', expectedCents: null, actualCents: null, toleranceCents: null, disposition: null },
  ];

  const ctx: WorksheetContext = {
    bundleId: 'bundle-1',
    bundleLabel: 'Smith 2025',
    generatedAt: new Date('2026-03-01T12:00:00Z'),
    generatedByName: 'Test Reviewer',
    documentCount: 4,
    taxpayers: [{ displayName: 'ROBERT J SMITH', tinLast4: '6789' }],
    documentLabels: new Map([
      ['w2-a', 'W-2 — ACME MANUFACTURING INC'],
      ['w2-b', 'W-2 — OZARK REGIONAL HEALTH'],
      ['int-a', '1099-INT — STATE EMPLOYEES CREDIT UNION'],
    ]),
    softAnnotations: [],
  };

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(asExcelBuffer(await buildXlsx(model, ctx, review)));
  return { wb, review, w2 };
}

describe('review workbook', () => {
  it('has the reading-path sheets in order', async () => {
    const { wb } = await build();
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'Summary', 'Worksheet', 'Documents', 'W-2', '1099-INT', 'Judgment Required', 'Review Items', 'Checks', 'Provenance',
    ]);
  });

  it('lays a form out box by box with one column per document, blank as blank and zero as zero', async () => {
    const { wb, review, w2 } = await build();
    const plan = planFormSheets(review).find((p) => p.formType === 'W-2')!;
    const sheet = wb.getWorksheet('W-2')!;
    expect(sheet.getCell(2, plan.docCol.get('w2-a')).value).toBe('W-2 — ACME MANUFACTURING INC');
    expect(sheet.getCell(2, plan.docCol.get('w2-b')).value).toBe('W-2 — OZARK REGIONAL HEALTH');

    const rowOf = (key: string) => plan.fieldRow.get(key)!;
    expect(sheet.getCell(rowOf('box_1'), 2).value).toBe(w2.fields.find((f) => f.key === 'box_1')!.label);
    expect(sheet.getCell(rowOf('box_1'), 3).value).toBe('1040:1a');
    expect(sheet.getCell(rowOf('box_1'), plan.docCol.get('w2-a')).value).toBe(85_000);
    expect(sheet.getCell(rowOf('box_1'), plan.docCol.get('w2-b')).value).toBe(42_000);
    // §5 on the sheet: an empty box is an empty cell; a printed zero is 0.
    expect(sheet.getCell(rowOf('box_7'), plan.docCol.get('w2-a')).value).toBeNull();
    expect(sheet.getCell(rowOf('box_8'), plan.docCol.get('w2-a')).value).toBe(0);
    // Checkboxes read as marks.
    expect(sheet.getCell(rowOf('box_13_retirement'), plan.docCol.get('w2-a')).value).toBe('☑');
    expect(sheet.getCell(rowOf('box_13_statutory'), plan.docCol.get('w2-a')).value).toBe('☐');
    // A total column sums across documents; SUM skips blanks.
    const totalCol = plan.docCol.get('w2-b')! + 1;
    expect(sheet.getCell(rowOf('box_1'), totalCol).value).toMatchObject({ formula: expect.stringMatching(/^SUM\(/) });
  });

  it('colours flagged and corrected cells and explains them in a note', async () => {
    const { wb, review } = await build();
    const plan = planFormSheets(review).find((p) => p.formType === 'W-2')!;
    const sheet = wb.getWorksheet('W-2')!;
    const col = plan.docCol.get('w2-a')!;
    const mismatch = sheet.getCell(plan.fieldRow.get('box_2')!, col);
    expect((mismatch.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFF8CBAD');
    expect(String(mismatch.note)).toContain('misread');
    const corrected = sheet.getCell(plan.fieldRow.get('box_16')!, col);
    expect((corrected.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFE2EFDA');
    expect(String(corrected.note)).toContain('91,000.00');
    // The other W-2 never reported box 16: greyed, not blank-as-if-read.
    const unread = sheet.getCell(plan.fieldRow.get('box_16')!, plan.docCol.get('w2-b'));
    expect((unread.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFEDEDED');
  });

  it('puts each document\'s arithmetic checks under its column with the disposition', async () => {
    const { wb, review } = await build();
    const plan = planFormSheets(review).find((p) => p.formType === 'W-2')!;
    const sheet = wb.getWorksheet('W-2')!;
    const col = plan.docCol.get('w2-a')!;
    const texts: string[] = [];
    sheet.eachRow((row) => {
      const v = row.getCell(col).value;
      if (typeof v === 'string' && v.startsWith('✗')) texts.push(v);
    });
    expect(texts.some((t) => t.includes('expected 5,580.00, got 6,000.00') && t.includes('accepted as is'))).toBe(true);
  });

  it('indexes every document, including the pages that were not forms', async () => {
    const { wb } = await build();
    const sheet = wb.getWorksheet('Documents')!;
    expect(sheet.rowCount).toBe(5); // header + 4
    const last = sheet.getRow(5);
    expect(last.getCell(2).value).toBe('—');
    expect(last.getCell(9).value).toBe('not a form — skipped');
    const first = sheet.getRow(2);
    expect(first.getCell(17).value).toMatchObject({ hyperlink: expect.stringContaining("#'W-2'!") });
  });

  it('links each worksheet contribution to its cell on the form sheet', async () => {
    const { wb, review } = await build();
    const plan = planFormSheets(review).find((p) => p.formType === 'W-2')!;
    const sheet = wb.getWorksheet('Worksheet')!;
    let found: unknown = null;
    sheet.eachRow((row) => {
      const v = row.getCell(7).value; // 'Source' — keys are not kept on a reloaded sheet
      if (v && typeof v === 'object' && 'hyperlink' in v && String(v.hyperlink).includes("'W-2'") && found === null) found = v;
    });
    expect(found).toMatchObject({ hyperlink: `#'W-2'!D${plan.fieldRow.get('box_1')}` });
  });

  it('lists what is waiting on a human, with open hard failures marked', async () => {
    const { wb } = await build();
    const sheet = wb.getWorksheet('Review Items')!;
    const kinds: string[] = [];
    sheet.eachRow((row, n) => {
      if (n > 1) kinds.push(String(row.getCell(1).value));
    });
    expect(kinds).toContain('field');
    expect(kinds).toContain('hard check');
    expect(kinds).toContain('soft check');
  });

  it('sanitizes sheet names and keeps them unique', () => {
    const taken = new Set<string>();
    expect(sheetNameFor('K-1-1065', taken)).toBe('K-1-1065');
    expect(sheetNameFor('K-1-1065', taken)).toBe('K-1-1065 (2)');
    expect(sheetNameFor('A/B:C*D?E[F]', taken)).toBe('A-B-C-D-E-F-');
  });

  it('still renders the classic workbook when no review model is supplied', async () => {
    const forms = await FormRegistry.load(join(DATA, 'form-schemas'));
    const model = await buildWorksheetModel(
      2025,
      [{ documentId: 'd', formType: 'W-2', taxYear: 2025, schema: forms.resolve('W-2', 2025)!.schema, fields: new Map([['box_1', fv({ cents: 1 })]]) }],
      join(DATA, 'line-mappings'),
    );
    const ctx: WorksheetContext = {
      bundleId: 'b', bundleLabel: 'b', generatedAt: new Date(), generatedByName: 'x', documentCount: 1,
      taxpayers: [], documentLabels: new Map(), softAnnotations: [],
    };
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asExcelBuffer(await buildXlsx(model, ctx)));
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Summary', 'Worksheet', 'Judgment Required']);
  });
});
