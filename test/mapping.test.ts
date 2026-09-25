import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorksheetModel, type MappedDocument } from '../src/mapping/engine.ts';
import type { FieldValue } from '../src/reconcile/checks.ts';
import { FormRegistry } from '../src/schemas/registry.ts';

const DATA_ROOT = join(process.cwd(), 'data');

const field = (v: Partial<FieldValue> = {}): FieldValue => ({
  cents: null,
  text: null,
  bool: null,
  spanIds: ['s1'],
  present: true,
  ...v,
});

async function registry() {
  return FormRegistry.load(join(DATA_ROOT, 'form-schemas'));
}

async function doc(
  formType: string,
  fields: Record<string, FieldValue>,
  extra: Partial<MappedDocument> = {},
): Promise<MappedDocument> {
  const forms = await registry();
  const schema = forms.resolve(formType, 2025)!.schema;
  return {
    documentId: `doc-${formType}`,
    formType,
    taxYear: 2025,
    schema,
    fields: new Map(Object.entries(fields)),
    ...extra,
  };
}

const line = (model: Awaited<ReturnType<typeof buildWorksheetModel>>, ref: string) =>
  model.lines.find((l) => l.lineRef === ref)!;

describe('line mapping (P10)', () => {
  it('maps W-2 box 1 to line 1a and rolls it into 1z', async () => {
    const model = await buildWorksheetModel(
      2025,
      [await doc('W-2', { box_1: field({ cents: 7_500_000 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(line(model, '1040:1a').totalCents).toBe(7_500_000);
    expect(line(model, '1040:1z').totalCents).toBe(7_500_000);
  });

  it('sums non-null contributors and reports the blank count separately (§5)', async () => {
    const model = await buildWorksheetModel(
      2025,
      [
        await doc('1099-INT', { box_1: field({ cents: 10_000 }) }),
        { ...(await doc('1099-INT', { box_1: field({ cents: 25_000 }) })), documentId: 'doc-int-2' },
        { ...(await doc('1099-INT', { box_1: field({ present: false }) })), documentId: 'doc-int-3' },
      ],
      join(DATA_ROOT, 'line-mappings'),
    );
    const l = line(model, '1040:2b');
    expect(l.totalCents).toBe(35_000);
    expect(l.nullContributorCount).toBe(1);
    expect(l.contributorCount).toBe(3);
  });

  it('keeps a printed zero as a contributor, distinct from a blank', async () => {
    const model = await buildWorksheetModel(
      2025,
      [await doc('1099-INT', { box_1: field({ cents: 0 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    const l = line(model, '1040:2b');
    expect(l.totalCents).toBe(0);
    expect(l.nullContributorCount).toBe(0);
  });

  it('routes an IRA 1099-R to 4a/4b and a pension to 5a/5b by the IRA checkbox', async () => {
    const ira = await buildWorksheetModel(
      2025,
      [
        await doc('1099-R', {
          box_1: field({ cents: 1_000_000 }),
          box_2a: field({ cents: 900_000 }),
          box_7_ira_sep_simple: field({ bool: true }),
        }),
      ],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(line(ira, '1040:4a').totalCents).toBe(1_000_000);
    expect(line(ira, '1040:5a').totalCents).toBeNull();

    const pension = await buildWorksheetModel(
      2025,
      [
        await doc('1099-R', {
          box_1: field({ cents: 1_000_000 }),
          box_2a: field({ cents: 900_000 }),
          box_7_ira_sep_simple: field({ bool: false }),
        }),
      ],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(line(pension, '1040:5a').totalCents).toBe(1_000_000);
    expect(line(pension, '1040:4a').totalCents).toBeNull();
  });

  it('includes Schedule 1-A totalling to Form 1040 line 13b, computed by nobody', async () => {
    const model = await buildWorksheetModel(2025, [], join(DATA_ROOT, 'line-mappings'));
    expect(line(model, 'SCH1A:total')).toBeDefined();
    expect(line(model, '1040:13b')).toBeDefined();
    // The app reports the W-2 as printed and does not compute the new deductions (§10).
    expect(line(model, 'SCH1A:1').notComputed).toBe(true);
    expect(line(model, 'SCH1A:2').notComputed).toBe(true);
  });
});

describe('Judgment Required routing (§9)', () => {
  const judgment = (model: Awaited<ReturnType<typeof buildWorksheetModel>>) =>
    model.lines.find((l) => l.isJudgmentRequired)!;

  it('routes SSA-1099 gross benefits without computing the taxable portion', async () => {
    const model = await buildWorksheetModel(
      2025,
      [await doc('SSA-1099', { box_3: field({ cents: 2_400_000 }), box_5: field({ cents: 2_400_000 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(line(model, '1040:6a').totalCents).toBe(2_400_000);
    expect(line(model, '1040:6b').notComputed).toBe(true);
    expect(judgment(model).contributions.some((c) => c.fieldKey === 'box_3')).toBe(true);
  });

  it('routes a 1099-G state refund to judgment rather than guessing prior-year itemization', async () => {
    const model = await buildWorksheetModel(
      2025,
      [await doc('1099-G', { box_2: field({ cents: 120_000 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    const item = judgment(model).contributions.find((c) => c.fieldKey === 'box_2');
    expect(item).toBeDefined();
    expect(item!.judgmentReason).toMatch(/itemi/i);
  });

  it('routes a 1099-S to judgment because §121 is not this app to decide', async () => {
    const model = await buildWorksheetModel(
      2025,
      [await doc('1099-S', { box_2: field({ cents: 45_000_000 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(judgment(model).contributions.some((c) => c.judgmentReason?.includes('§121'))).toBe(true);
  });

  it('puts every K-1 value in judgment and never on a numbered line (§8)', async () => {
    const model = await buildWorksheetModel(
      2025,
      [await doc('K-1-1065', { box_1: field({ cents: 500_000 }), box_2: field({ cents: 250_000 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    const j = judgment(model);
    expect(j.contributions).toHaveLength(2);
    for (const l of model.lines) {
      if (l.isJudgmentRequired) continue;
      expect(l.contributions.every((c) => c.formType !== 'K-1-1065')).toBe(true);
    }
  });

  it('surfaces a populated money field with no mapping rather than dropping it', async () => {
    const model = await buildWorksheetModel(
      2025,
      // 1099-INT box 5 (investment expenses) has no TY2025 line mapping.
      [await doc('1099-INT', { box_5: field({ cents: 4_200 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    const item = judgment(model).contributions.find((c) => c.fieldKey === 'box_5');
    expect(item).toBeDefined();
    expect(item!.judgmentReason).toMatch(/No 2025 line mapping/);
  });

  it('never puts a TIN on the worksheet (§7)', async () => {
    const model = await buildWorksheetModel(
      2025,
      [await doc('W-2', { employee_tin: field({ text: '123-45-6789' }), box_1: field({ cents: 100 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    const all = model.lines.flatMap((l) => l.contributions);
    expect(all.some((c) => c.fieldKey === 'employee_tin')).toBe(false);
  });
});

describe('W-2 box 12 (reviewed 2026-08-26)', () => {
  const judgment = (model: Awaited<ReturnType<typeof buildWorksheetModel>>) =>
    model.lines.find((l) => l.isJudgmentRequired)!;

  it('routes code W to Form 8889 — the one mechanical, consequential code', async () => {
    const model = await buildWorksheetModel(
      2025,
      [
        await doc('W-2', {
          box_12a_code: field({ text: 'W' }),
          box_12a_amount: field({ cents: 425_000 }),
        }),
      ],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(line(model, 'F8889:9').totalCents).toBe(425_000);
    expect(judgment(model).contributions).toHaveLength(0);
  });

  it('routes elective deferrals to an informational detail line, not Judgment', async () => {
    const model = await buildWorksheetModel(
      2025,
      [
        await doc('W-2', {
          box_12a_code: field({ text: 'D' }),
          box_12a_amount: field({ cents: 2_300_000 }),
        }),
      ],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(line(model, 'INFO:box12_deferrals').totalCents).toBe(2_300_000);
    expect(judgment(model).contributions).toHaveLength(0);
  });

  it('matches codes case-insensitively and tolerates surrounding whitespace', async () => {
    const model = await buildWorksheetModel(
      2025,
      [
        await doc('W-2', {
          box_12a_code: field({ text: ' w ' }),
          box_12a_amount: field({ cents: 100_000 }),
        }),
      ],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(line(model, 'F8889:9').totalCents).toBe(100_000);
  });

  it('sends an unenumerated code to Judgment rather than dropping it silently', async () => {
    const model = await buildWorksheetModel(
      2025,
      [
        await doc('W-2', {
          // Code C — group-term life over $50k. Not enumerated, so not mechanical.
          box_12a_code: field({ text: 'C' }),
          box_12a_amount: field({ cents: 18_400 }),
        }),
      ],
      join(DATA_ROOT, 'line-mappings'),
    );
    const item = judgment(model).contributions.find((c) => c.fieldKey === 'box_12a_amount');
    expect(item).toBeDefined();
    expect(item!.valueCents).toBe(18_400);
    expect(item!.judgmentReason).toMatch(/code this mapping does not enumerate/);
  });

  it('routes SSA-1099 voluntary withholding to line 25b (reviewer call)', async () => {
    const model = await buildWorksheetModel(
      2025,
      [await doc('SSA-1099', { box_6: field({ cents: 240_000 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    expect(line(model, '1040:25b').totalCents).toBe(240_000);
    expect(line(model, '1040:25c').totalCents).toBeNull();
  });
});

/**
 * TY2026 (P10's "a season is a data change" criterion, exercised).
 *
 * `loadMapping` **throws** when a year's file is absent — unlike the form-schema registry,
 * which substitutes the nearest season and annotates it. So until `2026.json` existed, a
 * TY2026 bundle produced no worksheet at all: the first one uploaded in the January 2027
 * season would have failed outright. That is the right failure (a worksheet built on a
 * mapping nobody wrote would be worse) and it is still a failure with a date on it.
 *
 * These tests hold two things: that a TY2026 bundle now produces a worksheet, and that the
 * worksheet says out loud that its mapping has not been checked against a printed form.
 */
describe('TY2026', () => {
  const doc2026 = async (formType: string, fields: Record<string, FieldValue>): Promise<MappedDocument> => {
    const forms = await registry();
    const resolved = forms.resolve(formType, 2026)!;
    return {
      documentId: `doc-2026-${formType}`,
      formType,
      taxYear: 2026,
      schema: resolved.schema,
      fields: new Map(Object.entries(fields)),
    };
  };

  it('produces a worksheet, where before it threw', async () => {
    const model = await buildWorksheetModel(
      2026,
      [
        await doc2026('W-2', {
          box_1: field({ cents: 12_700_000 }),
          box_2: field({ cents: 1_544_000 }),
          box_17: field({ cents: 382_500 }),
        }),
      ],
      join(DATA_ROOT, 'line-mappings'),
    );

    expect(line(model, '1040:1a').totalCents).toBe(12_700_000);
    expect(line(model, '1040:1z').totalCents).toBe(12_700_000);
    expect(line(model, '1040:25a').totalCents).toBe(1_544_000);
    // State withholding is a Schedule A line, and is *also* listed on an INFO detail line so
    // a preparer can see it per payer. It is not Judgment Required: a figure with a home is
    // not a question for a preparer.
    expect(line(model, 'SCHA:5a').totalCents).toBe(382_500);
    expect(
      line(model, 'INFO:state_withholding').contributions.map((c) => c.valueCents),
    ).toEqual([382_500]);
  });

  it('carries a year that has no mapping on refusing, rather than guessing one', async () => {
    // The contrast that makes the above worth having: the registry substitutes a schema and
    // says so, and the mapping does not substitute at all.
    await expect(
      buildWorksheetModel(2027, [], join(DATA_ROOT, 'line-mappings')),
    ).rejects.toThrow(/no line mapping for tax year 2027/);
  });

  it('says on every artifact that the mapping has not been checked against a printed form', async () => {
    const model = await buildWorksheetModel(
      2026,
      [await doc2026('W-2', { box_1: field({ cents: 100 }) })],
      join(DATA_ROOT, 'line-mappings'),
    );
    // `mappingVersion` is printed on the workbook cover, the PDF cover, the Hand check sheet
    // caption and every stored draft return. The suffix is how a carried-forward mapping
    // admits to being one, without a line of code knowing about it.
    expect(model.mappingVersion).toBe('2026.0-unverified');
  });

  it('leaves 1099-DA unregistered, so it blocks rather than being read against a guess', async () => {
    const forms = await registry();
    // New for TY2026 and deliberately absent: an unregistered form type blocks the bundle
    // until a human reads the page (§6), which is the right outcome for a layout nobody here
    // has seen. QUESTIONS.md Q25.
    expect(forms.resolve('1099-DA', 2026)).toBeUndefined();
  });

  it('is the 2025 mapping carried forward — same lines, same refs, same order', async () => {
    const { loadMapping } = await import('../src/mapping/engine.ts');
    const root = join(DATA_ROOT, 'line-mappings');
    const [a, b] = await Promise.all([loadMapping(2025, root), loadMapping(2026, root)]);
    // If a future season genuinely diverges this test should be changed, deliberately, by
    // whoever diverges it. Until then it holds the claim the file's own notes make.
    expect(b.lines).toEqual(a.lines);
    expect(b.mappings).toEqual(a.mappings);
    expect(b.taxYear).toBe(2026);
  });
});
