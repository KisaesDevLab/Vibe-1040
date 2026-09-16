/**
 * XLSX worksheet (P12).
 *
 * Built for a tax manager sitting with the prepared return open in the tax package and this
 * workbook beside it. Three questions, three reading paths:
 *
 *  1. **Was every document captured?** — the `Documents` sheet: one row per document with
 *     issuer, taxpayer, year, pages, and how the read went.
 *  2. **Was every box read correctly?** — one recap sheet per form type, laid out the way
 *     the form is: rows are the form's boxes in printed order, columns are each document
 *     instance, cells are the amounts as read. Flagged cells are coloured and carry a note
 *     saying why; corrected cells show what the model read before the reviewer changed it.
 *     A blank box is a blank cell, a printed zero is 0.00 (§5). Each column ends with that
 *     document's arithmetic checks.
 *  3. **Do the line totals tie?** — the `Worksheet` sheet in standard 1040 order, with each
 *     contribution hyperlinked to its cell on the recap sheet.
 *
 * `Review Items` gathers everything still waiting on a human, `Checks` lists every check
 * with its disposition, `Judgment Required` is unchanged, and `Provenance` records which
 * models and which geometry source produced each document.
 *
 * The prior-year comparison column is present and empty: v1 has no client master and no
 * prior-season data (§7), and leaving the column out would mean redesigning the layout in
 * season two.
 */
import ExcelJS from 'exceljs';
import { centsToDollars, formatCents } from '../lib/money.ts';
import type { WorksheetModel } from '../mapping/engine.ts';
import type { WorksheetContext } from './model.ts';
import { compareFormTypes } from './form-order.ts';
import { documentTitle, pagesLabel, type ReviewCheck, type ReviewDocument, type ReviewField, type ReviewModel } from './review.ts';

const MONEY = '#,##0.00;(#,##0.00)';

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

/** Cell colours. Listed in the Summary legend; keep the two in step. */
const FILL_REVIEW = fill('FFFFF2CC'); // needs a look: no span, disagreement, unparseable
const FILL_MISMATCH = fill('FFF8CBAD'); // value not in the spans it cites — a likely misread
const FILL_CORRECTED = fill('FFE2EFDA'); // a reviewer changed it; note shows the model's read
const FILL_JUDGMENT = fill('FFDDEBF7'); // Judgment Required (§9)
const FILL_UNREAD = fill('FFEDEDED'); // the binder never returned this field

const REVIEW_LABEL: Record<string, string> = {
  no_span: 'No layout span supports this value (§4). Confirm against the page.',
  span_mismatch: 'The value is not in the text of the spans it cites — likely a misread.',
  pass_disagreement: 'Binding passes disagreed on this value.',
  unmapped: 'The printed value could not be parsed as this field type.',
  hard_failure: 'Part of a hard arithmetic failure.',
  soft_failure: 'Part of a soft arithmetic annotation.',
  judgment_required: 'Judgment Required (§9).',
};

function headerRow(sheet: ExcelJS.Worksheet, row = 1): void {
  const r = sheet.getRow(row);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.fill = HEADER_FILL;
}

/** Excel sheet names: 31 chars, none of []:*?/\ */
export function sheetNameFor(formType: string, taken: Set<string>): string {
  let base = formType.replace(/[[\]:*?/\\]/g, '-').slice(0, 28);
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base} (${n++})`;
  taken.add(name);
  return name;
}

interface FormSheetPlan {
  formType: string;
  sheetName: string;
  docs: ReviewDocument[];
  /** fieldKey → row number on the sheet. */
  fieldRow: Map<string, number>;
  /** documentId → column number on the sheet. */
  docCol: Map<string, number>;
}

const FIRST_DOC_COL = 4; // A box, B field, C line, D.. documents
const FIRST_FIELD_ROW = 5; // 1 title, 2 issuer, 3 pages, 4 taxpayer/year

/**
 * Decide where everything lives before rendering, so the Worksheet sheet can hyperlink into
 * the recap sheets that are created after it.
 */
export function planFormSheets(review: ReviewModel): FormSheetPlan[] {
  const taken = new Set(['Summary', 'Worksheet', 'Documents', 'Judgment Required', 'Review Items', 'Checks', 'Provenance']);
  const byType = new Map<string, ReviewDocument[]>();
  for (const doc of review.documents) {
    if (!doc.formType || !doc.fields.length) continue;
    byType.set(doc.formType, [...(byType.get(doc.formType) ?? []), doc]);
  }
  const plans: FormSheetPlan[] = [];
  // Sheets in return order — wages first — not alphabetical.
  for (const [formType, docs] of [...byType.entries()].sort(([a], [b]) => compareFormTypes(a, b))) {
    const fieldRow = new Map<string, number>();
    docs[0]!.fields.forEach((f, i) => fieldRow.set(f.fieldKey, FIRST_FIELD_ROW + i));
    const docCol = new Map<string, number>();
    docs.forEach((d, i) => docCol.set(d.documentId, FIRST_DOC_COL + i));
    plans.push({ formType, sheetName: sheetNameFor(formType, taken), docs, fieldRow, docCol });
  }
  return plans;
}

const colLetter = (n: number): string => {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

function cellValueFor(f: ReviewField): ExcelJS.CellValue {
  if (!f.read) return null;
  if (f.type === 'money') return f.cents === null ? null : centsToDollars(f.cents);
  if (f.type === 'bool') return f.bool === null ? null : f.bool ? '☑' : '☐';
  if (f.type === 'count') return f.text !== null && /^\d+$/.test(f.text) ? Number(f.text) : f.text;
  return f.text;
}

function originalText(f: ReviewField): string {
  const o = f.original;
  if (f.type === 'money') return o.cents === null ? 'blank' : formatCents(o.cents);
  if (f.type === 'bool') return o.bool === null ? 'blank' : o.bool ? 'checked' : 'unchecked';
  return o.text ?? 'blank';
}

function styleFieldCell(cell: ExcelJS.Cell, f: ReviewField): void {
  const notes: string[] = [];
  if (f.type === 'money') cell.numFmt = MONEY;
  if (!f.read) {
    cell.fill = FILL_UNREAD;
    notes.push('Not returned by the binder.');
  }
  if (f.wasCorrected) {
    cell.fill = FILL_CORRECTED;
    cell.font = { bold: true };
    notes.push(`Corrected by reviewer. Model read: ${originalText(f)}.`);
  } else if (f.needsReview) {
    cell.fill = f.reviewReason === 'span_mismatch' ? FILL_MISMATCH : FILL_REVIEW;
    notes.push(REVIEW_LABEL[f.reviewReason ?? ''] ?? `Needs review (${f.reviewReason ?? 'unspecified'}).`);
  } else if (f.judgmentRequired && f.present) {
    cell.fill = FILL_JUDGMENT;
    notes.push(f.judgmentReason ?? 'Judgment Required (§9).');
  }
  if (f.disagreed && !notes.some((n) => n.includes('disagreed'))) notes.push('Binding passes disagreed.');
  if (f.present && f.spanCount === 0 && f.type !== 'bool') notes.push('No span cited.');
  if (notes.length) cell.note = notes.join('\n');
}

function checkCellText(c: ReviewCheck): string {
  if (c.outcome === 'not_applicable') return 'n/a';
  if (c.outcome === 'pass') return '✓';
  const parts = ['✗'];
  if (c.expectedCents !== null && c.actualCents !== null) {
    parts.push(`expected ${formatCents(c.expectedCents)}, got ${formatCents(c.actualCents)}`);
  }
  if (c.disposition) parts.push(`— ${c.disposition.kind.replace(/_/g, ' ')}${c.disposition.note ? `: ${c.disposition.note}` : ''}`);
  return parts.join(' ');
}

// ── recap sheet per form type ────────────────────────────────────────────────

function renderFormSheet(wb: ExcelJS.Workbook, plan: FormSheetPlan): void {
  const sheet = wb.addWorksheet(plan.sheetName);
  const docs = plan.docs;
  const fields = docs[0]!.fields;
  const totalCol = FIRST_DOC_COL + docs.length;

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 44;
  sheet.getColumn(3).width = 16;
  for (let i = 0; i < docs.length; i += 1) sheet.getColumn(FIRST_DOC_COL + i).width = 26;
  sheet.getColumn(totalCol).width = 16;

  // Header block: title, issuer, pages, taxpayer/year/section.
  sheet.getCell(1, 1).value = `${plan.formType} — boxes as read, one column per document`;
  sheet.getCell(1, 1).font = { bold: true, size: 13 };
  sheet.getCell(2, 1).value = 'Box';
  sheet.getCell(2, 2).value = 'Field';
  sheet.getCell(2, 3).value = '1040 line';
  sheet.getCell(3, 2).value = 'Pages';
  sheet.getCell(4, 2).value = 'Taxpayer · tax year';
  for (const doc of docs) {
    const col = plan.docCol.get(doc.documentId)!;
    const title = sheet.getCell(2, col);
    title.value = documentTitle(doc);
    title.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    title.fill = HEADER_FILL;
    title.alignment = { wrapText: true, vertical: 'top' };
    sheet.getCell(3, col).value = pagesLabel(doc);
    sheet.getCell(3, col).font = { size: 9, color: { argb: 'FF595959' } };
    const who = [doc.taxpayerLabel ?? 'taxpayer not assigned', doc.taxYear ? `TY${doc.taxYear}` : 'year unknown'];
    if (doc.taxYearMismatch) who.push('⚠ off-year');
    if (doc.unrecognisedForm) who.push('⚠ unrecognised form');
    sheet.getCell(4, col).value = who.join(' · ');
    sheet.getCell(4, col).font = { size: 9, color: { argb: 'FF595959' } };
  }
  sheet.getCell(2, totalCol).value = docs.length > 1 ? 'Total' : '';
  for (const c of [1, 2, 3, totalCol]) {
    sheet.getCell(2, c).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getCell(2, c).fill = HEADER_FILL;
  }
  sheet.getRow(2).height = 32;
  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 4 }];

  // One row per field, in schema (printed) order.
  fields.forEach((template, i) => {
    const row = FIRST_FIELD_ROW + i;
    sheet.getCell(row, 1).value = template.box ?? '';
    sheet.getCell(row, 2).value = template.label;
    sheet.getCell(row, 3).value = template.lineRefs.join(', ');
    sheet.getCell(row, 3).font = { size: 9, color: { argb: 'FF595959' } };
    if (template.judgmentRequired) sheet.getCell(row, 2).font = { italic: true };

    let present = 0;
    let blank = 0;
    for (const doc of docs) {
      const f = doc.fields.find((x) => x.fieldKey === template.fieldKey);
      const cell = sheet.getCell(row, plan.docCol.get(doc.documentId)!);
      if (!f) continue;
      cell.value = cellValueFor(f);
      styleFieldCell(cell, f);
      if (f.type === 'money' && f.read) {
        if (f.cents === null) blank += 1;
        else present += 1;
      }
    }
    if (template.type === 'money' && docs.length > 1) {
      const total = sheet.getCell(row, totalCol);
      const from = `${colLetter(FIRST_DOC_COL)}${row}`;
      const to = `${colLetter(FIRST_DOC_COL + docs.length - 1)}${row}`;
      // SUM ignores blank cells, which is exactly §5: a blank is not a zero.
      total.value = present ? { formula: `SUM(${from}:${to})` } : null;
      total.numFmt = MONEY;
      total.font = { bold: true };
      if (blank) total.note = `${blank} of ${docs.length} document(s) blank in this box.`;
    }
  });

  // Per-document checks under the fields.
  let row = FIRST_FIELD_ROW + fields.length + 1;
  sheet.getCell(row, 2).value = 'Arithmetic checks';
  sheet.getCell(row, 2).font = { bold: true };
  row += 1;
  const checkKeys = [...new Set(docs.flatMap((d) => d.checks.map((c) => c.checkKey)))].sort();
  for (const key of checkKeys) {
    sheet.getCell(row, 2).value = key;
    sheet.getCell(row, 2).font = { name: 'Consolas', size: 9 };
    for (const doc of docs) {
      const c = doc.checks.find((x) => x.checkKey === key);
      if (!c) continue;
      const cell = sheet.getCell(row, plan.docCol.get(doc.documentId)!);
      cell.value = checkCellText(c);
      cell.alignment = { wrapText: true, vertical: 'top' };
      if (c.outcome === 'fail') {
        cell.font = { color: { argb: c.severity === 'hard' ? 'FFC00000' : 'FF9C5700' } };
        cell.note = c.message;
      } else if (c.outcome === 'not_applicable') {
        cell.font = { color: { argb: 'FF808080' } };
      }
    }
    row += 1;
  }

  row += 1;
  const summaryRows: [string, (d: ReviewDocument) => number | string][] = [
    ['Fields needing review', (d) => d.fields.filter((f) => f.needsReview).length],
    ['Corrected by reviewer', (d) => d.fields.filter((f) => f.wasCorrected).length],
    ['Open hard failures', (d) => d.checks.filter((c) => c.severity === 'hard' && c.outcome === 'fail' && !c.disposition).length],
    ['Extraction outcome', (d) => d.extractionOutcome ?? 'pending'],
  ];
  for (const [label, get] of summaryRows) {
    sheet.getCell(row, 2).value = label;
    sheet.getCell(row, 2).font = { bold: true, size: 9 };
    for (const doc of docs) {
      const cell = sheet.getCell(row, plan.docCol.get(doc.documentId)!);
      cell.value = get(doc);
      cell.font = { size: 9 };
    }
    row += 1;
  }
}

// ── documents index ──────────────────────────────────────────────────────────

function renderDocumentsSheet(wb: ExcelJS.Workbook, review: ReviewModel, plans: FormSheetPlan[]): void {
  const sheet = wb.addWorksheet('Documents');
  sheet.columns = [
    { header: '#', key: 'n', width: 4 },
    { header: 'Form', key: 'form', width: 18 },
    { header: 'Section', key: 'section', width: 8 },
    { header: 'Issuer / payer', key: 'payer', width: 32 },
    { header: 'Taxpayer', key: 'taxpayer', width: 26 },
    { header: 'Tax year', key: 'year', width: 9 },
    { header: 'Flags', key: 'flags', width: 26 },
    { header: 'Pages', key: 'pages', width: 30 },
    { header: 'Read', key: 'outcome', width: 20 },
    { header: 'Fields', key: 'fields', width: 7 },
    { header: 'Blank', key: 'blank', width: 7 },
    { header: 'Review', key: 'review', width: 7 },
    { header: 'Corrected', key: 'corrected', width: 9 },
    { header: 'Hard open', key: 'hard', width: 9 },
    { header: 'Hard decided', key: 'hardDone', width: 11 },
    { header: 'Soft', key: 'soft', width: 6 },
    { header: 'Recap', key: 'link', width: 14 },
  ];
  headerRow(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'Q1' };

  const planByType = new Map(plans.map((p) => [p.formType, p]));
  review.documents.forEach((doc, i) => {
    const flags = [
      doc.corrected ? 'CORRECTED' : '',
      doc.void ? 'VOID' : '',
      doc.taxYearMismatch ? `off-year (${doc.taxYear})` : '',
      doc.unrecognisedForm ? 'UNRECOGNISED FORM' : '',
      doc.isSupplemental ? 'supplemental page' : '',
      doc.isSummary ? 'package summary' : '',
      doc.parentDocumentId ? 'sub-form' : '',
    ].filter(Boolean);
    const outcome: Record<string, string> = {
      extracted: 'extracted',
      skipped_supplemental: 'not a form — skipped',
      skipped_unclassified: 'unclassified — skipped',
      no_schema: 'NO SCHEMA — not read',
      no_spans: 'NO TEXT FOUND — not read',
    };
    const row = sheet.addRow({
      n: i + 1,
      form: doc.formType ?? '—',
      section: doc.sectionCode ?? '',
      payer: doc.payerName ?? '',
      taxpayer: doc.taxpayerLabel ?? '',
      year: doc.taxYear ?? '',
      flags: flags.join(', '),
      pages: pagesLabel(doc),
      outcome: outcome[doc.extractionOutcome ?? ''] ?? (doc.extractionOutcome ?? 'pending'),
      fields: doc.fields.filter((f) => f.read).length,
      blank: doc.fields.filter((f) => f.read && !f.present && f.type === 'money').length,
      review: doc.fields.filter((f) => f.needsReview).length,
      corrected: doc.fields.filter((f) => f.wasCorrected).length,
      hard: doc.checks.filter((c) => c.severity === 'hard' && c.outcome === 'fail' && !c.disposition).length,
      hardDone: doc.checks.filter((c) => c.severity === 'hard' && c.outcome === 'fail' && c.disposition).length,
      soft: doc.checks.filter((c) => c.severity === 'soft' && c.outcome === 'fail').length,
    });
    const plan = doc.formType ? planByType.get(doc.formType) : undefined;
    if (plan) {
      const col = plan.docCol.get(doc.documentId)!;
      row.getCell('link').value = { text: `→ ${plan.sheetName}`, hyperlink: `#'${plan.sheetName}'!${colLetter(col)}2` };
      row.getCell('link').font = { color: { argb: 'FF0563C1' }, underline: true };
    }
    if (doc.extractionOutcome === 'no_schema' || doc.extractionOutcome === 'no_spans' || doc.unrecognisedForm) {
      row.getCell('outcome').font = { bold: true, color: { argb: 'FFC00000' } };
    }
    if ((row.getCell('review').value as number) > 0) row.getCell('review').fill = FILL_REVIEW;
    if ((row.getCell('hard').value as number) > 0) row.getCell('hard').fill = FILL_MISMATCH;
  });
}

// ── review items ─────────────────────────────────────────────────────────────

function renderReviewItems(wb: ExcelJS.Workbook, review: ReviewModel, plans: FormSheetPlan[]): void {
  const sheet = wb.addWorksheet('Review Items');
  sheet.columns = [
    { header: 'Kind', key: 'kind', width: 12 },
    { header: 'Form', key: 'form', width: 18 },
    { header: 'Issuer / payer', key: 'payer', width: 30 },
    { header: 'Box', key: 'box', width: 7 },
    { header: 'Field / check', key: 'field', width: 44 },
    { header: 'Value', key: 'value', width: 16, style: { numFmt: MONEY } },
    { header: 'Model read', key: 'original', width: 16 },
    { header: 'Why', key: 'why', width: 60 },
    { header: 'Decision', key: 'decision', width: 18 },
    { header: 'Note', key: 'note', width: 40 },
    { header: 'Where', key: 'link', width: 14 },
  ];
  headerRow(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'K1' };
  const planByType = new Map(plans.map((p) => [p.formType, p]));

  const link = (doc: ReviewDocument, fieldKey?: string): ExcelJS.CellValue => {
    const plan = doc.formType ? planByType.get(doc.formType) : undefined;
    if (!plan) return '';
    const col = colLetter(plan.docCol.get(doc.documentId)!);
    const row = fieldKey ? (plan.fieldRow.get(fieldKey) ?? 2) : 2;
    return { text: `→ ${plan.sheetName}`, hyperlink: `#'${plan.sheetName}'!${col}${row}` };
  };

  let n = 0;
  for (const doc of review.documents) {
    for (const f of doc.fields) {
      if (!f.needsReview && !(f.judgmentRequired && f.present)) continue;
      n += 1;
      const row = sheet.addRow({
        kind: f.needsReview ? 'field' : 'judgment',
        form: doc.formType,
        payer: doc.payerName ?? '',
        box: f.box ?? '',
        field: f.label,
        value: cellValueFor(f),
        original: f.wasCorrected ? originalText(f) : '',
        why: f.needsReview
          ? (REVIEW_LABEL[f.reviewReason ?? ''] ?? f.reviewReason ?? '')
          : (f.judgmentReason ?? 'Judgment Required (§9).'),
        decision: f.wasCorrected ? 'corrected' : '',
        note: '',
        link: link(doc, f.fieldKey),
      });
      row.getCell('link').font = { color: { argb: 'FF0563C1' }, underline: true };
      if (f.needsReview) row.getCell('value').fill = f.reviewReason === 'span_mismatch' ? FILL_MISMATCH : FILL_REVIEW;
    }
    for (const c of doc.checks) {
      if (c.outcome !== 'fail') continue;
      n += 1;
      const row = sheet.addRow({
        kind: c.severity === 'hard' ? 'hard check' : 'soft check',
        form: doc.formType,
        payer: doc.payerName ?? '',
        box: '',
        field: c.checkKey,
        value: c.actualCents === null ? null : centsToDollars(c.actualCents),
        original: c.expectedCents === null ? '' : `expected ${formatCents(c.expectedCents)}`,
        why: c.message,
        decision: c.disposition ? c.disposition.kind.replace(/_/g, ' ') : c.severity === 'hard' ? 'OPEN' : '',
        note: c.disposition ? `${c.disposition.note} (${c.disposition.by})`.trim() : '',
        link: link(doc),
      });
      row.getCell('link').font = { color: { argb: 'FF0563C1' }, underline: true };
      if (c.severity === 'hard' && !c.disposition) row.getCell('decision').font = { bold: true, color: { argb: 'FFC00000' } };
    }
  }
  for (const c of review.bundleChecks) {
    if (c.outcome !== 'fail') continue;
    n += 1;
    sheet.addRow({
      kind: c.severity === 'hard' ? 'hard check' : 'soft check',
      form: 'bundle',
      payer: '',
      box: '',
      field: c.checkKey,
      value: c.actualCents === null ? null : centsToDollars(c.actualCents),
      original: c.expectedCents === null ? '' : `expected ${formatCents(c.expectedCents)}`,
      why: c.message,
      decision: c.disposition ? c.disposition.kind.replace(/_/g, ' ') : '',
      note: c.disposition?.note ?? '',
      link: '',
    });
  }
  if (!n) sheet.addRow({ kind: '—', field: 'Nothing in this bundle is waiting on a reviewer.' });
}

// ── checks ───────────────────────────────────────────────────────────────────

function renderChecks(wb: ExcelJS.Workbook, review: ReviewModel): void {
  const sheet = wb.addWorksheet('Checks');
  sheet.columns = [
    { header: 'Form', key: 'form', width: 18 },
    { header: 'Issuer / payer', key: 'payer', width: 30 },
    { header: 'Check', key: 'check', width: 40 },
    { header: 'Severity', key: 'severity', width: 9 },
    { header: 'Outcome', key: 'outcome', width: 14 },
    { header: 'Expected', key: 'expected', width: 14, style: { numFmt: MONEY } },
    { header: 'Actual', key: 'actual', width: 14, style: { numFmt: MONEY } },
    { header: 'Tolerance', key: 'tolerance', width: 10, style: { numFmt: MONEY } },
    { header: 'Message', key: 'message', width: 70 },
    { header: 'Decision', key: 'decision', width: 18 },
    { header: 'Decided by', key: 'by', width: 18 },
    { header: 'Note', key: 'note', width: 40 },
  ];
  headerRow(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'L1' };

  const add = (form: string, payer: string, c: ReviewCheck): void => {
    const row = sheet.addRow({
      form,
      payer,
      check: c.checkKey,
      severity: c.severity,
      outcome: c.outcome.replace(/_/g, ' '),
      expected: c.expectedCents === null ? null : centsToDollars(c.expectedCents),
      actual: c.actualCents === null ? null : centsToDollars(c.actualCents),
      tolerance: c.toleranceCents === null ? null : centsToDollars(c.toleranceCents),
      message: c.message,
      decision: c.disposition ? c.disposition.kind.replace(/_/g, ' ') : '',
      by: c.disposition?.by ?? '',
      note: c.disposition?.note ?? '',
    });
    if (c.outcome === 'fail') {
      row.getCell('outcome').font = { bold: true, color: { argb: c.severity === 'hard' ? 'FFC00000' : 'FF9C5700' } };
    }
  };
  for (const doc of review.documents) for (const c of doc.checks) add(doc.formType ?? '—', doc.payerName ?? '', c);
  for (const c of review.bundleChecks) add('bundle', '', c);
}

// ── provenance ───────────────────────────────────────────────────────────────

function renderProvenance(wb: ExcelJS.Workbook, review: ReviewModel, ctx: WorksheetContext): void {
  const sheet = wb.addWorksheet('Provenance');
  sheet.columns = [
    { header: 'Form', key: 'form', width: 18 },
    { header: 'Issuer / payer', key: 'payer', width: 30 },
    { header: 'Pages', key: 'pages', width: 30 },
    { header: 'Geometry', key: 'geometry', width: 22 },
    { header: 'Spans', key: 'spans', width: 8 },
    { header: 'Classifier model', key: 'classifier', width: 30 },
    { header: 'Extraction model', key: 'extractor', width: 30 },
    { header: 'Passes', key: 'passes', width: 8 },
    { header: 'Schema', key: 'schema', width: 10 },
  ];
  headerRow(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const doc of review.documents) {
    const sources = [...new Set(doc.pages.map((p) => p.layoutSource ?? 'pending'))];
    sheet.addRow({
      form: doc.formType ?? '—',
      payer: doc.payerName ?? '',
      pages: pagesLabel(doc),
      geometry: sources
        .map((s) => (s === 'text_layer' ? 'exact (PDF text layer)' : s === 'model' ? 'estimated (vision model)' : s))
        .join(', '),
      spans: doc.pages.reduce((n, p) => n + (p.spanCount ?? 0), 0),
      classifier: doc.provenance.classifierModel ?? '',
      extractor: doc.provenance.extractionModel ?? '',
      passes: doc.provenance.passCount ?? '',
      schema: doc.schemaVersion ?? '',
    });
  }
  sheet.addRow([]);
  sheet.addRow(['Generated by', ctx.generatedByName]);
  sheet.addRow(['Generated at', ctx.generatedAt.toISOString()]);
  sheet.addRow(['Vibe 1040 version', review.appVersion]);
  sheet.addRow(['Bundle id', ctx.bundleId]);
}

// ── the workbook ─────────────────────────────────────────────────────────────

export async function buildXlsx(model: WorksheetModel, ctx: WorksheetContext, review?: ReviewModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vibe 1040';
  wb.created = ctx.generatedAt;

  const plans = review ? planFormSheets(review) : [];
  const planByType = new Map(plans.map((p) => [p.formType, p]));

  // ── cover / table of contents ──────────────────────────────────────────────
  const cover = wb.addWorksheet('Summary');
  cover.columns = [{ width: 42 }, { width: 58 }];
  cover.addRow(['Vibe 1040 — source document worksheet']).font = { bold: true, size: 14 };
  cover.addRow([]);
  cover.addRow(['Bundle', ctx.bundleLabel]);
  cover.addRow(['Tax year', model.taxYear]);
  cover.addRow(['Mapping version', model.mappingVersion]);
  cover.addRow(['Generated', ctx.generatedAt.toISOString()]);
  cover.addRow(['Generated by', ctx.generatedByName]);
  cover.addRow(['Taxpayers', ctx.taxpayers.map((t) => `${t.displayName ?? 'unnamed'} (…${t.tinLast4})`).join('; ')]);
  cover.addRow(['Documents', String(ctx.documentCount)]);
  cover.addRow([]);
  const disclaimer = cover.addRow([
    'This worksheet reports what the source documents say. It performs no tax computation ' +
      'and makes no determination about filing status, income characterization, deductions, ' +
      'or credits. Items requiring judgment are listed in the Judgment Required section.',
  ]);
  disclaimer.font = { italic: true };
  cover.mergeCells(disclaimer.number, 1, disclaimer.number, 2);
  disclaimer.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  cover.getRow(disclaimer.number).height = 46;

  if (review) {
    const docs = review.documents;
    const forms = docs.filter((d) => d.formType && !d.isSupplemental);
    cover.addRow([]);
    cover.addRow(['How to review']).font = { bold: true };
    cover.addRow(['1. Documents', 'Every page that came in, what it was classified as, and how the read went. Confirm nothing is missing.']);
    cover.addRow(['2. One sheet per form', 'Each form laid out box by box, one column per document. Compare to the source and to the return.']);
    cover.addRow(['3. Worksheet', 'Form 1040 line totals. Each contribution links back to its cell on the form sheet.']);
    cover.addRow(['4. Review Items', 'Everything still waiting on a human: flagged fields, open checks, Judgment Required.']);
    cover.addRow([]);
    cover.addRow(['Counts']).font = { bold: true };
    cover.addRow(['Form documents', forms.length]);
    const byType = new Map<string, number>();
    for (const d of forms) byType.set(d.formType!, (byType.get(d.formType!) ?? 0) + 1);
    for (const [type, n] of [...byType.entries()].sort()) cover.addRow([`  ${type}`, n]);
    cover.addRow(['Documents not read', forms.filter((d) => d.extractionOutcome !== 'extracted').length]);
    cover.addRow(['Fields needing review', docs.reduce((n, d) => n + d.fields.filter((f) => f.needsReview).length, 0)]);
    cover.addRow(['Fields corrected by a reviewer', docs.reduce((n, d) => n + d.fields.filter((f) => f.wasCorrected).length, 0)]);
    const hard = [...docs.flatMap((d) => d.checks), ...review.bundleChecks].filter((c) => c.severity === 'hard' && c.outcome === 'fail');
    cover.addRow(['Hard failures (decided / total)', `${hard.filter((c) => c.disposition).length} / ${hard.length}`]);
    cover.addRow(['Soft annotations', [...docs.flatMap((d) => d.checks), ...review.bundleChecks].filter((c) => c.severity === 'soft' && c.outcome === 'fail').length]);
    cover.addRow([]);
    cover.addRow(['Cell colours on the form sheets']).font = { bold: true };
    const legend: [string, string, ExcelJS.Fill][] = [
      ['Needs a look', 'no span cited, passes disagreed, or unparseable', FILL_REVIEW],
      ['Likely misread', 'the value is not in the text it cites', FILL_MISMATCH],
      ['Corrected', 'a reviewer changed it; the note shows what the model read', FILL_CORRECTED],
      ['Judgment Required', 'reported as printed; the preparer decides', FILL_JUDGMENT],
      ['Not returned', 'the binder did not report this field', FILL_UNREAD],
    ];
    for (const [name, meaning, f] of legend) {
      const r = cover.addRow([name, meaning]);
      r.getCell(1).fill = f;
    }
    cover.addRow(['Blank cell', 'the box was empty on the form. 0.00 means the form printed a zero.']);
  }

  if (ctx.softAnnotations.length) {
    cover.addRow([]);
    cover.addRow(['Annotations (soft check failures)']).font = { bold: true };
    for (const note of ctx.softAnnotations) cover.addRow([note.checkKey, note.message]);
  }

  // ── worksheet lines ────────────────────────────────────────────────────────
  const sheet = wb.addWorksheet('Worksheet');
  sheet.columns = [
    { header: 'Line', key: 'line', width: 16 },
    { header: 'Description', key: 'label', width: 62 },
    { header: 'Amount', key: 'amount', width: 16, style: { numFmt: MONEY } },
    { header: 'Prior year', key: 'prior', width: 14, style: { numFmt: MONEY } },
    { header: 'Docs', key: 'docs', width: 7 },
    { header: 'Blank', key: 'blank', width: 7 },
    { header: 'Source', key: 'source', width: 34 },
    { header: 'Note', key: 'note', width: 52 },
  ];
  headerRow(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const reviewDocs = new Map((review?.documents ?? []).map((d) => [d.documentId, d]));

  for (const line of model.lines) {
    if (line.isJudgmentRequired) continue; // its own section, below

    const row = sheet.addRow({
      line: line.lineRef,
      label: line.label,
      amount: centsToDollars(line.totalCents),
      prior: null, // deliberately empty in v1 — see §7
      docs: line.contributorCount,
      blank: line.nullContributorCount,
      note: line.notComputed ? (line.notComputedReason ?? 'Not computed by this app.') : '',
    });
    row.font = { bold: true };
    if (line.notComputed) row.getCell('amount').font = { bold: true, italic: true, color: { argb: 'FF7F7F7F' } };

    for (const c of line.contributions) {
      const rdoc = reviewDocs.get(c.documentId);
      const rfield = rdoc?.fields.find((f) => f.fieldKey === c.fieldKey);
      const notes = [c.informational ? 'informational only' : '', c.wasCorrected ? 'corrected by reviewer' : ''];
      if (rfield?.needsReview) notes.push(`needs review: ${rfield.reviewReason ?? ''}`);
      const detail = sheet.addRow({
        line: '',
        label: `    ${c.formType} — ${c.fieldLabel}`,
        amount: centsToDollars(c.valueCents),
        prior: null,
        docs: '',
        blank: c.valueCents === null ? 'blank' : '',
        source: ctx.documentLabels.get(c.documentId) ?? c.documentId,
        note: notes.filter(Boolean).join('; '),
      });
      detail.font = { size: 10, color: { argb: 'FF404040' } };
      if (c.wasCorrected) detail.getCell('amount').font = { size: 10, bold: true, color: { argb: 'FF9C5700' } };
      if (rfield?.needsReview) detail.getCell('amount').fill = rfield.reviewReason === 'span_mismatch' ? FILL_MISMATCH : FILL_REVIEW;
      // A blank contributor is shown as blank, never as 0.00 — that distinction is the
      // whole point of the tool (§5).
      if (c.valueCents === null) detail.getCell('amount').value = null;

      const plan = planByType.get(c.formType);
      if (plan && plan.docCol.has(c.documentId)) {
        const col = colLetter(plan.docCol.get(c.documentId)!);
        const fieldRow = plan.fieldRow.get(c.fieldKey) ?? 2;
        detail.getCell('source').value = {
          text: ctx.documentLabels.get(c.documentId) ?? c.documentId,
          hyperlink: `#'${plan.sheetName}'!${col}${fieldRow}`,
        };
        detail.getCell('source').font = { size: 10, color: { argb: 'FF0563C1' }, underline: true };
      }
    }
  }

  if (review) renderDocumentsSheet(wb, review, plans);
  for (const plan of plans) renderFormSheet(wb, plan);

  // ── judgment required ──────────────────────────────────────────────────────
  const judgment = wb.addWorksheet('Judgment Required');
  judgment.columns = [
    { header: 'Form', key: 'form', width: 20 },
    { header: 'Field', key: 'field', width: 46 },
    { header: 'Amount', key: 'amount', width: 16, style: { numFmt: MONEY } },
    { header: 'Source', key: 'source', width: 34 },
    { header: 'Why this needs a preparer', key: 'reason', width: 76 },
  ];
  headerRow(judgment);
  judgment.views = [{ state: 'frozen', ySplit: 1 }];

  const judgmentLine = model.lines.find((l) => l.isJudgmentRequired);
  for (const c of judgmentLine?.contributions ?? []) {
    judgment.addRow({
      form: c.formType,
      field: c.fieldLabel,
      amount: centsToDollars(c.valueCents),
      source: ctx.documentLabels.get(c.documentId) ?? c.documentId,
      reason: c.judgmentReason ?? 'Requires preparer judgment.',
    });
  }
  if (!judgmentLine?.contributions.length) {
    judgment.addRow({ form: '—', field: 'Nothing in this bundle required judgment.', reason: '' });
  }

  if (review) {
    renderReviewItems(wb, review, plans);
    renderChecks(wb, review);
    renderProvenance(wb, review, ctx);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
