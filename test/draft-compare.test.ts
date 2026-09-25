import { describe, expect, it } from 'vitest';
import type { EngineResult } from '../src/draft/client.ts';
import { compareDraft, describeDifference } from '../src/draft/compare.ts';
import { loadNodeMap, type NodeMapFile } from '../src/draft/nodes.ts';
import type { WorksheetLine, WorksheetModel } from '../src/mapping/engine.ts';

/**
 * P17: the engine's computed lines beside the worksheet's reported totals.
 *
 * Pure, so none of this needs an engine. The cases that matter are the ones where the two
 * sides legitimately disagree — an expected disagreement dressed up as a defect teaches a
 * reviewer to ignore the whole panel, which is worse than showing nothing.
 */

const TOLERANCE = 100; // $1, the per-document rounding tolerance (§6).

let file: NodeMapFile;
const nodeMap = async (): Promise<NodeMapFile> => (file ??= await loadNodeMap(2025));

function line(lineRef: string, totalCents: number | null): WorksheetLine {
  return {
    lineRef,
    label: lineRef,
    sortOrder: 1,
    totalCents,
    contributorCount: totalCents === null ? 0 : 1,
    nullContributorCount: 0,
    isJudgmentRequired: false,
    notComputed: false,
    contributions: [],
  };
}

function worksheet(lines: WorksheetLine[]): WorksheetModel {
  return { taxYear: 2025, mappingVersion: '2025.3', lines };
}

function engine(lines: Record<string, unknown>): EngineResult {
  return {
    returnId: 'r-1',
    year: 2025,
    engineVersion: '0.1.0',
    summary: {},
    lines,
    forms: Object.keys(lines),
    warnings: [],
    validation: { hard: [], soft: [] },
    rejected: [],
  };
}

describe('verdicts', () => {
  it('agrees when both sides match', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:1z', 5_500_000)]),
      engine({ line1z_total_wages: 55_000 }),
      TOLERANCE,
    );
    const l = c.lines.find((x) => x.lineRef === '1040:1z')!;
    expect(l.verdict).toBe('agrees');
    expect(l.computedCents).toBe(5_500_000);
    expect(l.deltaCents).toBe(0);
    expect(c.differing).toHaveLength(0);
  });

  it('agrees inside the firm tolerance, and differs outside it', async () => {
    const inside = compareDraft(
      await nodeMap(),
      worksheet([line('1040:1z', 5_500_000)]),
      engine({ line1z_total_wages: 55_000.99 }),
      TOLERANCE,
    );
    expect(inside.lines.find((x) => x.lineRef === '1040:1z')!.verdict).toBe('agrees');

    const outside = compareDraft(
      await nodeMap(),
      worksheet([line('1040:1z', 5_500_000)]),
      engine({ line1z_total_wages: 55_010 }),
      TOLERANCE,
    );
    const l = outside.lines.find((x) => x.lineRef === '1040:1z')!;
    expect(l.verdict).toBe('differs');
    expect(l.deltaCents).toBe(1_000);
    expect(outside.differing.map((x) => x.lineRef)).toEqual(['1040:1z']);
  });

  it('calls it engine_silent when the worksheet reports and the engine has nothing', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:6a', 2_400_000)]),
      engine({}),
      TOLERANCE,
    );
    const l = c.lines.find((x) => x.lineRef === '1040:6a')!;
    expect(l.verdict).toBe('engine_silent');
    // Not a disagreement to chase: the SSA-1099 was withheld on purpose.
    expect(c.differing).toHaveLength(0);
    expect(l.note).toContain('withholds every SSA-1099');
  });

  it('calls it worksheet_silent when only the engine has a figure', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:6b', null)]),
      engine({ line6b_ss_taxable: 12_000 }),
      TOLERANCE,
    );
    expect(c.lines.find((x) => x.lineRef === '1040:6b')!.verdict).toBe('worksheet_silent');
  });

  it('counts a line neither side has as both_blank and shows nothing to chase', async () => {
    const c = compareDraft(await nodeMap(), worksheet([]), engine({}), TOLERANCE);
    expect(c.counts.both_blank).toBe(c.lines.length);
    expect(c.differing).toHaveLength(0);
  });
});

describe('a blank is not a zero, on the way in as well as out (§5)', () => {
  it('reads an absent engine line as null, never 0', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:1z', null)]),
      engine({}),
      TOLERANCE,
    );
    expect(c.lines.find((x) => x.lineRef === '1040:1z')!.computedCents).toBeNull();
  });

  it('keeps a real engine zero as 0, because that is a computed figure', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:1z', 0)]),
      engine({ line1z_total_wages: 0 }),
      TOLERANCE,
    );
    const l = c.lines.find((x) => x.lineRef === '1040:1z')!;
    expect(l.computedCents).toBe(0);
    expect(l.verdict).toBe('agrees');
  });

  it('reads a non-numeric engine value as null rather than coercing it', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:1z', 100)]),
      engine({ line1z_total_wages: 'n/a' }),
      TOLERANCE,
    );
    expect(c.lines.find((x) => x.lineRef === '1040:1z')!.computedCents).toBeNull();
  });

  it('rounds dollars to cents rather than truncating', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:2b', 12_346)]),
      engine({ line2b_taxable_interest: 123.455 }),
      TOLERANCE,
    );
    expect(c.lines.find((x) => x.lineRef === '1040:2b')!.computedCents).toBe(12_346);
  });
});

describe('computed-only figures', () => {
  it('carries the numbers the worksheet cannot produce, which is the point', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([]),
      engine({ line11_agi: [78_500, 78_500], line15_taxable_income: 63_900, line37_amount_owed: 1_240 }),
      TOLERANCE,
    );
    const byLine = new Map(c.computedOnly.map((x) => [x.engineLine, x.computedCents]));
    expect(byLine.get('line11_agi')).toBe(7_850_000);
    expect(byLine.get('line15_taxable_income')).toBe(6_390_000);
    expect(byLine.get('line37_amount_owed')).toBe(124_000);
    // Absent ones are null, not zero.
    expect(byLine.get('line35a_refund')).toBeNull();
  });
});

describe('describeDifference', () => {
  it('names both sides, and says when a disagreement is expected', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:7', 1_500_000)]),
      engine({ line7_capital_gain: 0 }),
      TOLERANCE,
    );
    const l = c.lines.find((x) => x.lineRef === '1040:7')!;
    const text = describeDifference(l);
    expect(text).toContain('worksheet reports 15,000.00');
    expect(text).toContain('engine computes 0.00');
    expect(text).toContain('Expected:');
    expect(text).toContain('1099-B is unmappable');
  });
});

describe('ordering', () => {
  it('follows the worksheet sort order, so the panel reads like a 1040', async () => {
    const ws = worksheet([
      { ...line('1040:25a', 100), sortOrder: 900 },
      { ...line('1040:1z', 200), sortOrder: 100 },
      { ...line('1040:2b', 300), sortOrder: 200 },
    ]);
    const c = compareDraft(await nodeMap(), ws, engine({}), TOLERANCE);
    const known = c.lines.filter((l) => ['1040:1z', '1040:2b', '1040:25a'].includes(l.lineRef));
    expect(known.map((l) => l.lineRef)).toEqual(['1040:1z', '1040:2b', '1040:25a']);
  });
});

describe('engine lines the node map declares nowhere', () => {
  /**
   * The failure measured against engine 2.0.4 when dependents landed (P18): the engine began
   * returning `line20_nonrefundable_credits`, the credit for every dependent entered, and the
   * node map declared no such line — so the figure went into total tax and appeared nowhere. An
   * applied dependent and an ignored one looked identical on every surface.
   *
   * This cannot be checked at load time: enumerating the lines a release emits means computing a
   * return. So it is checked per draft, which also means an engine upgrade cannot add a line
   * without the next draft naming it.
   */
  it('reports a line the engine returned and the map accounts for in no way', async () => {
    const c = compareDraft(
      await nodeMap(),
      worksheet([line('1040:1a', 12_700_000)]),
      engine({ line1a_wages: 127_000, line99_new_credit_the_engine_invented: 2_200 }),
      TOLERANCE,
    );
    expect(c.undeclaredLines).toEqual(['line99_new_credit_the_engine_invented']);
  });

  it('stays quiet about every line the shipped map does account for', async () => {
    const file_ = await nodeMap();
    // Everything the map knows about, in one return: nothing here is news.
    const lines: Record<string, unknown> = {};
    for (const c of file_.lines.comparable) lines[c.engineLine] = 1;
    for (const c of file_.lines.computedOnly) lines[c.engineLine] = 1;
    for (const c of file_.lines.ignoredLines) lines[c.engineLine] = 1;

    const c = compareDraft(file_, worksheet([]), engine(lines), TOLERANCE);
    expect(c.undeclaredLines).toEqual([]);
  });

  it('declares the credit line the dependents feed, with what it is for', async () => {
    const file_ = await nodeMap();
    const credit = file_.lines.computedOnly.find((c) => c.engineLine === 'line20_nonrefundable_credits');
    expect(credit, 'the child tax credit must be shown somewhere, not only netted into total tax').toBeDefined();
    expect(credit!.note).toMatch(/dependents/);
    // And the pair that resolves what 2.0.4 leaves ambiguous about line 12c.
    const declared = file_.lines.computedOnly.map((c) => c.engineLine);
    expect(declared).toContain('line12a_standard_deduction');
    expect(declared).toContain('line12e_itemized_deductions');
  });

  it('counts a line as accounted for only with a reason a preparer could read', async () => {
    const file_ = await nodeMap();
    expect(file_.lines.ignoredLines.length).toBeGreaterThan(0);
    for (const ignored of file_.lines.ignoredLines) {
      // Not a silencing mechanism: every entry says why, in prose, and the reasons are a
      // closed set so "we did not get round to it" cannot become one of them.
      expect(ignored.detail.length).toBeGreaterThan(20);
      expect(['echoes_an_input', 'not_a_money_figure', 'superseded_by_another_line']).toContain(
        ignored.reason,
      );
    }
    // A figure the engine computes about money is never in here.
    expect(file_.lines.ignoredLines.map((i) => i.engineLine)).not.toContain('line20_nonrefundable_credits');
  });
});
