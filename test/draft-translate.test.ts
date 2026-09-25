import { describe, expect, it } from 'vitest';
import { loadNodeMap, type NodeMapFile } from '../src/draft/nodes.ts';
import {
  buildDraftInput,
  type DraftDocument,
  type DraftFieldValue,
} from '../src/draft/translate.ts';
import { registry } from '../src/schemas/registry.ts';

/**
 * P17 translator. Pure, so every case here runs with no engine, no router and no database.
 */

/** A read value, with a span, not flagged — the ordinary case. */
const money = (cents: number): DraftFieldValue => ({
  cents,
  text: null,
  bool: null,
  spanIds: ['11111111-1111-1111-1111-111111111111'],
  present: true,
});

const text = (value: string): DraftFieldValue => ({
  cents: null,
  text: value,
  bool: null,
  spanIds: ['11111111-1111-1111-1111-111111111111'],
  present: true,
});

const flag = (value: boolean): DraftFieldValue => ({
  cents: null,
  text: null,
  bool: value,
  spanIds: ['11111111-1111-1111-1111-111111111111'],
  present: true,
});

/** An empty box: read, and blank. Not a zero (§5). */
const blank: DraftFieldValue = {
  cents: null,
  text: null,
  bool: null,
  spanIds: [],
  present: false,
};

let file: NodeMapFile;
const nodeMap = async (): Promise<NodeMapFile> => (file ??= await loadNodeMap(2025));

async function doc(
  formType: string,
  fields: Record<string, DraftFieldValue>,
  documentId = 'doc-1',
  taxYear = 2025,
): Promise<DraftDocument> {
  const reg = await registry();
  const schema = reg.get(formType, 2025);
  if (!schema) throw new Error(`no 2025 schema for ${formType}`);
  return { documentId, formType, taxYear, schema, fields: new Map(Object.entries(fields)) };
}

/** A W-2 that satisfies the engine's required fields. */
async function plainW2(
  extra: Record<string, DraftFieldValue> = {},
  documentId = 'doc-1',
): Promise<DraftDocument> {
  return doc(
    'W-2',
    {
      employer_name: text('ACME INC'),
      employer_ein: text('12-3456789'),
      box_1: money(5_500_000),
      box_2: money(520_000),
      ...extra,
    },
    documentId,
  );
}

describe('a clean W-2', () => {
  it('becomes a w2 node with dollars, not cents', async () => {
    const input = buildDraftInput(await nodeMap(), [await plainW2({ box_3: money(5_500_000) })]);
    const w2 = input.nodes.find((n) => n.nodeType === 'w2');
    expect(w2).toBeDefined();
    expect(w2!.payload['box1_wages']).toBe(55_000);
    expect(w2!.payload['box2_fed_withheld']).toBe(5_200);
    expect(w2!.payload['box3_ss_wages']).toBe(55_000);
    expect(input.documentsIncluded).toBe(1);
    expect(input.documentsWithheld).toBe(0);
  });

  it('collapses box 12 code/amount pairs into the engine array', async () => {
    const input = buildDraftInput(await nodeMap(), [
      await plainW2({
        box_12a_code: text('d'),
        box_12a_amount: money(1_150_000),
        box_12c_code: text(' DD '),
        box_12c_amount: money(1_842_300),
      }),
    ]);
    expect(input.nodes[0]!.payload['box12_entries']).toEqual([
      { code: 'D', amount: 11_500 },
      { code: 'DD', amount: 18_423 },
    ]);
  });

  it('carries no TIN into the payload', async () => {
    const w2 = await plainW2({ employee_tin: text('123-45-6789') });
    const input = buildDraftInput(await nodeMap(), [w2]);
    expect(JSON.stringify(input.nodes)).not.toContain('123-45-6789');
  });
});

describe('blank is not zero (§5) — the boundary into a calculation engine', () => {
  it('leaves an optional blank box off the payload entirely, rather than sending 0', async () => {
    const input = buildDraftInput(await nodeMap(), [await plainW2({ box_3: blank })]);
    const payload = input.nodes[0]!.payload;
    expect('box3_ss_wages' in payload).toBe(false);
    expect(payload['box3_ss_wages']).toBeUndefined();
  });

  it('withholds the whole document when the engine requires a box that is blank', async () => {
    const w2 = await doc('W-2', {
      employer_name: text('ACME INC'),
      box_1: blank,
      box_2: money(520_000),
    });
    const input = buildDraftInput(await nodeMap(), [w2]);
    expect(input.nodes.some((n) => n.nodeType === 'w2')).toBe(false);
    const omission = input.omissions.find((o) => o.reason === 'engine_required_field_blank');
    expect(omission?.fieldKey).toBe('box_1');
    expect(omission?.detail).toContain('blank is not a zero');
    expect(input.documentsWithheld).toBe(1);
  });

  it('never pads a partially-read 1095-A year with zero-premium months', async () => {
    const months = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const fields: Record<string, DraftFieldValue> = { policy_issuer_name: text('HEALTHCO') };
    for (const m of months) {
      fields[`monthly_${m}_premium`] = m === 'december' ? blank : money(50_000);
      fields[`monthly_${m}_slcsp`] = money(52_000);
      fields[`monthly_${m}_aptc`] = money(30_000);
    }
    const input = buildDraftInput(await nodeMap(), [await doc('1095-A', fields)]);
    const node = input.nodes.find((n) => n.nodeType === 'f1095a');
    expect(node).toBeDefined();
    // The two complete arrays go; the incomplete one does not, and says why.
    expect(node!.payload['monthly_slcsps']).toHaveLength(12);
    expect('monthly_premiums' in node!.payload).toBe(false);
    const omission = input.omissions.find((o) => o.fieldKey === 'monthly_december_premium');
    expect(omission?.detail).toContain('month of no coverage');
  });

  it('records a zero the form actually printed, because that is a value, not a blank', async () => {
    const input = buildDraftInput(await nodeMap(), [await plainW2({ box_3: money(0) })]);
    expect(input.nodes[0]!.payload['box3_ss_wages']).toBe(0);
  });
});

describe('a value a human has not accepted does not feed a computation', () => {
  it('withholds a document whose mapped field is flagged for review', async () => {
    const w2 = await plainW2({ box_3: { ...money(100), needsReview: true } });
    const input = buildDraftInput(await nodeMap(), [w2]);
    expect(input.nodes.some((n) => n.nodeType === 'w2')).toBe(false);
    expect(input.omissions.find((o) => o.reason === 'needs_review')?.fieldKey).toBe('box_3');
  });

  it('withholds a document whose mapped field cites no span', async () => {
    const w2 = await plainW2({ box_3: { ...money(100), spanIds: [] } });
    const input = buildDraftInput(await nodeMap(), [w2]);
    expect(input.nodes.some((n) => n.nodeType === 'w2')).toBe(false);
    expect(input.omissions.find((o) => o.reason === 'no_spans')?.fieldKey).toBe('box_3');
  });

  it('withholds a negative amount rather than sending it to a non-negative field', async () => {
    const w2 = await plainW2({ box_3: money(-100) });
    const input = buildDraftInput(await nodeMap(), [w2]);
    expect(input.omissions.find((o) => o.reason === 'negative_amount')?.fieldKey).toBe('box_3');
  });
});

describe('judgment stays with the preparer (§9, §11)', () => {
  it('withholds an SSA-1099 every time, because box 3 is always printed', async () => {
    const ssa = await doc('SSA-1099', {
      box_3: money(2_400_000),
      box_5: money(2_400_000),
      box_6: money(100_000),
    });
    const input = buildDraftInput(await nodeMap(), [ssa]);
    expect(input.nodes.some((n) => n.nodeType === 'ssa1099')).toBe(false);
    const omission = input.omissions.find((o) => o.reason === 'judgment_required');
    expect(omission?.fieldKey).toBe('box_3');
    expect(omission?.formType).toBe('SSA-1099');
  });

  it('lets a 1099-DIV through when its judgment box is blank', async () => {
    const div = await doc('1099-DIV', {
      payer_name: text('BROKER LLC'),
      box_1a: money(150_000),
      box_1b: money(120_000),
      box_3: blank,
    });
    const input = buildDraftInput(await nodeMap(), [div]);
    expect(input.nodes.find((n) => n.nodeType === 'f1099div')?.payload['box1a']).toBe(1_500);
  });

  it('withholds the same 1099-DIV once its judgment box is populated', async () => {
    const div = await doc('1099-DIV', {
      payer_name: text('BROKER LLC'),
      box_1a: money(150_000),
      box_3: money(5_000),
    });
    const input = buildDraftInput(await nodeMap(), [div]);
    expect(input.nodes.some((n) => n.nodeType === 'f1099div')).toBe(false);
    expect(input.omissions.find((o) => o.reason === 'judgment_required')?.fieldKey).toBe('box_3');
  });

  it('withholds every K-1 as boxes-as-printed, never dispersing it onto lines', async () => {
    const k1 = await doc('K-1-1065', {});
    const input = buildDraftInput(await nodeMap(), [k1]);
    expect(input.nodes).toHaveLength(0);
    const omission = input.omissions.find(
      (o) => o.reason === 'all_judgment_required' || o.reason === 'form_type_unmappable',
    );
    expect(omission).toBeDefined();
  });

  it('withholds a 1099-B, because the engine wants lots and this app reads subtotals', async () => {
    const b = await doc('1099-B', { payer_name: text('BROKER LLC'), section_total_proceeds: money(1) });
    const input = buildDraftInput(await nodeMap(), [b]);
    expect(input.nodes).toHaveLength(0);
    const omission = input.omissions.find((o) => o.reason === 'form_type_unmappable');
    expect(omission?.detail).toContain('per-lot');
  });
});

describe('a document from another season stays out of the arithmetic', () => {
  it('withholds a prior-year 1098 and says which year it is', async () => {
    const prior = await doc(
      '1098',
      { recipient_name: text('BIG BANK'), box_1: money(1_341_900) },
      'doc-prior',
      2024,
    );
    const input = buildDraftInput(await nodeMap(), [prior]);
    expect(input.nodes.some((n) => n.nodeType === 'f1098')).toBe(false);
    const omission = input.omissions.find((o) => o.reason === 'off_year_document');
    expect(omission?.detail).toContain('is for 2024 and the bundle is 2025');
  });

  it('lets the current-year 1098 through beside it', async () => {
    const current = await doc(
      '1098',
      { recipient_name: text('BIG BANK'), box_1: money(1_284_400) },
      'doc-current',
      2025,
    );
    const prior = await doc(
      '1098',
      { recipient_name: text('BIG BANK'), box_1: money(1_341_900) },
      'doc-prior',
      2024,
    );
    const input = buildDraftInput(await nodeMap(), [current, prior]);
    const nodes = input.nodes.filter((n) => n.nodeType === 'f1098');
    // Exactly one, and it is this season's number — not the sum of both.
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.payload['box1_mortgage_interest']).toBe(12_844);
    expect(input.documentsWithheld).toBe(1);
  });
});

describe('what a bundle cannot know is enumerated, never inferred', () => {
  it('reports filing status as missing and emits no general node without it', async () => {
    const input = buildDraftInput(await nodeMap(), [await plainW2()]);
    expect(input.nodes.some((n) => n.nodeType === 'general')).toBe(false);
    expect(input.omissions.find((o) => o.fieldKey === 'filing_status')?.reason).toBe('not_in_bundle');
    expect(input.complete).toBe(false);
  });

  it('emits a general node from what the reviewer states, and stops reporting that as missing', async () => {
    const input = buildDraftInput(await nodeMap(), [await plainW2()], {
      filingStatus: 'married_filing_jointly',
      taxpayerAge65OrOlder: true,
    });
    const general = input.nodes.find((n) => n.nodeType === 'general');
    expect(general?.payload['filing_status']).toBe('married_filing_jointly');
    expect(general?.payload['taxpayer_age_65_or_older']).toBe(true);
    expect(general?.documentId).toBeNull();
    expect(input.omissions.some((o) => o.fieldKey === 'filing_status')).toBe(false);
  });

  it('always reports basis, carryovers and estimated payments as outside the bundle', async () => {
    const input = buildDraftInput(await nodeMap(), [await plainW2()], {
      filingStatus: 'single',
      dependentCount: 0,
    });
    const reasons = input.omissions.filter((o) => o.reason === 'not_in_bundle').map((o) => o.fieldKey);
    expect(reasons).toContain('capital_basis');
    expect(reasons).toContain('carryovers');
    expect(reasons).toContain('estimated_payments');
    // Never complete from documents alone — that is the point.
    expect(input.complete).toBe(false);
  });
});

describe('RRB-1099 binds to the social security node with the railroad flag', () => {
  it('sets is_rrb, and still withholds on the judgment box', async () => {
    const map = await nodeMap();
    const rrb = map.forms.find((f) => f.formType === 'RRB-1099');
    expect(rrb?.nodeType).toBe('ssa1099');
    expect(rrb?.constants['is_rrb']).toBe(true);

    const input = buildDraftInput(map, [await doc('RRB-1099', { box_4: money(1_200_000) })]);
    expect(input.omissions.find((o) => o.formType === 'RRB-1099')?.reason).toBe('judgment_required');
  });
});

describe('provenance', () => {
  it('stamps the node map version and the engine it was written against', async () => {
    const input = buildDraftInput(await nodeMap(), []);
    expect(input.nodeMapVersion).toBe('2025.1');
    expect(input.engine.name).toBe('opentax');
    expect(input.taxYear).toBe(2025);
  });

  it('keeps every node traceable to the document it came from', async () => {
    const input = buildDraftInput(await nodeMap(), [
      await plainW2({}, 'doc-a'),
      await doc('1098-E', { lender_name: text('SERVICER'), box_1: money(210_000) }, 'doc-b'),
    ]);
    const ids = input.nodes.filter((n) => n.documentId !== null).map((n) => n.documentId);
    expect(ids).toEqual(['doc-a', 'doc-b']);
  });
});
