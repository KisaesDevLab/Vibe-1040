import { describe, expect, it } from 'vitest';
import {
  checkAgainstCatalog,
  mappedNodeTypes,
  type CatalogFinding,
} from '../src/draft/catalog.ts';
import type { EngineCatalog } from '../src/draft/client.ts';
import { loadNodeMap, type NodeMapFile } from '../src/draft/nodes.ts';
import { GENERAL_NODE_FIELDS } from '../src/draft/translate.ts';

/**
 * The node map checked against the engine's own field catalogue (P17).
 *
 * The failure this guards is specific and was verified against engine 2.0.4 rather than
 * reasoned about: a renamed **optional** field is accepted by `form add` and ignored. A
 * 1099-INT box 1 of 12,345 sent as `box1_interest` leaves `line2b_taxable_interest` absent,
 * and absent is exactly what "the documents reported nothing on this line" looks like. No
 * rejection, no diagnostic, and nothing in the omissions either — because from the
 * translator's side the field was sent successfully.
 *
 * These tests drive the pure comparison. `test/draft-wrapper.test.ts` covers the parsing of
 * the engine's own listing, against slices copied verbatim out of 2.0.4.
 */

/**
 * An engine catalogue that agrees with the map exactly, as a baseline to mutate away from.
 *
 * Fields are **merged** across form types rather than assigned, because a node type can serve
 * more than one form: RRB-1099 binds to `ssa1099` with `is_rrb` set, so assigning per form
 * leaves whichever came last and makes the other's boxes look renamed.
 */
function catalogFor(file: NodeMapFile): EngineCatalog {
  const nodes: EngineCatalog['nodes'] = {};
  for (const form of file.forms) {
    const node = (nodes[form.nodeType] ??= {
      implemented: true,
      collection: `${form.nodeType}s`,
      fields: {},
      otherFields: [],
    });
    const fields = node.fields!;
    for (const f of form.fields) fields[f.nodeField] ??= { type: 'number', required: f.engineRequired };
    for (const g of form.codeGroups) fields[g.nodeField] ??= { type: 'array', required: false };
    for (const m of form.monthlyArrays) fields[m.nodeField] ??= { type: 'array', required: false };
    for (const key of Object.keys(form.constants)) fields[key] ??= { type: 'boolean', required: false };
  }
  nodes['general'] = {
    implemented: true,
    collection: null,
    fields: Object.fromEntries(
      GENERAL_NODE_FIELDS.map((f) => [
        f,
        { type: f === 'filing_status' ? 'enum' : 'boolean', required: f === 'filing_status' },
      ]),
    ),
    // The dependents array and its item fields (P18). They sit at a deeper indent in the
    // engine's own listing, which the wrapper reports under `otherFields`.
    otherFields: [
      file.preparerInputs?.dependents.nodeField ?? 'dependents',
      ...(file.preparerInputs?.dependents.fields ?? []).map((f) => f.nodeField),
    ],
  };

  // The preparer-input nodes. Same treatment as a form's: a catalogue that knows less than the
  // map makes every field look renamed.
  const inputs = file.preparerInputs;
  if (inputs) {
    const node = (fields: { nodeField: string }[]) => ({
      implemented: true,
      collection: null,
      fields: Object.fromEntries(fields.map((f) => [f.nodeField, { type: 'number', required: false }])),
      otherFields: [],
    });
    nodes[inputs.scheduleA.nodeType] = node([...inputs.scheduleA.fields, ...inputs.scheduleA.flags]);
    for (const activity of inputs.activities) {
      nodes[activity.nodeType] = node(activity.fields);
    }
  }
  return { engineVersion: '2.0.4', nodes };
}

const kinds = (findings: CatalogFinding[]): string[] => findings.map((f) => f.kind);

describe('checking the node map against the engine catalogue', () => {
  it('reports nothing when every name the map sends exists on the engine', async () => {
    const file = await loadNodeMap(2025);
    const check = checkAgainstCatalog(file, catalogFor(file));
    expect(check.findings).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.engineVersion).toBe('2.0.4');
  });

  it('asks about every node type the map targets, and about `general`', async () => {
    const file = await loadNodeMap(2025);
    const types = mappedNodeTypes(file);
    for (const form of file.forms) expect(types).toContain(form.nodeType);
    // `general` is on no form's map — it carries the filing status the reviewer states — so it
    // would go unchecked, and a rename there loses the entire tax computation.
    expect(types).toContain('general');
  });

  it('blocks on a renamed field — the silent-drop case', async () => {
    const file = await loadNodeMap(2025);
    const catalog = catalogFor(file);
    // What an engine release renaming `box1` to `box1_interest` looks like from here.
    delete catalog.nodes['f1099int']!.fields!['box1'];
    catalog.nodes['f1099int']!.fields!['box1_interest'] = { type: 'number', required: false };

    const check = checkAgainstCatalog(file, catalog);
    expect(check.ok).toBe(false);
    const finding = check.blocking.find((f) => f.engineField === 'box1');
    expect(finding, 'a field the engine no longer has must be reported').toBeDefined();
    expect(finding!.kind).toBe('field_unknown');
    expect(finding!.formType).toBe('1099-INT');
    // The detail has to say why this is dangerous, because the symptom looks like nothing.
    expect(finding!.detail).toMatch(/ignores it|vanishes|absent/);
  });

  it('blocks on a node type the engine does not have', async () => {
    const file = await loadNodeMap(2025);
    const catalog = catalogFor(file);
    catalog.nodes['w2'] = { implemented: false, reason: 'Unknown node type: w2' };

    const check = checkAgainstCatalog(file, catalog);
    const finding = check.blocking.find((f) => f.kind === 'node_type_absent');
    expect(finding).toBeDefined();
    expect(finding!.formType).toBe('W-2');
    // One finding for the node, not one per field on it.
    expect(check.findings.filter((f) => f.nodeType === 'w2')).toHaveLength(1);
  });

  it('blocks when the engine has no filing_status, since nothing computes without it', async () => {
    const file = await loadNodeMap(2025);
    const catalog = catalogFor(file);
    catalog.nodes['general']!.fields = {};

    const check = checkAgainstCatalog(file, catalog);
    expect(check.ok).toBe(false);
    expect(kinds(check.blocking)).toContain('field_unknown');
  });

  it('checks every field the general node sends, not only the filing status', async () => {
    const file = await loadNodeMap(2025);

    // The hole this closes, found by reading the translator rather than by a failing test:
    // the age and blindness flags are engine field names held in code rather than in the map,
    // and they are all OPTIONAL on the engine — so a rename is accepted and ignored, and the
    // additional standard deduction for an elderly or blind taxpayer quietly disappears.
    for (const field of GENERAL_NODE_FIELDS) {
      const catalog = catalogFor(file);
      delete catalog.nodes['general']!.fields![field];

      const check = checkAgainstCatalog(file, catalog);
      const finding = check.blocking.find((f) => f.engineField === field);
      expect(finding, `a renamed general.${field} must be reported`).toBeDefined();
      expect(finding!.nodeType).toBe('general');
    }
  });

  it('blocks when the engine has no general node at all', async () => {
    const file = await loadNodeMap(2025);
    const catalog = catalogFor(file);
    catalog.nodes['general'] = { implemented: false, reason: 'Unknown node type: general' };

    const check = checkAgainstCatalog(file, catalog);
    expect(kinds(check.blocking)).toContain('node_type_absent');
    // One finding for the node, not one per field it would have carried.
    expect(check.findings.filter((f) => f.nodeType === 'general')).toHaveLength(1);
  });

  it('advises, without blocking, when our engineRequired flag has gone stale either way', async () => {
    const file = await loadNodeMap(2025);

    // The engine started requiring something we treat as optional: documents missing it are
    // sent and refused whole, instead of withheld with a reason a reviewer can read.
    const nowRequired = catalogFor(file);
    nowRequired.nodes['w2']!.fields!['box3_ss_wages'] = { type: 'number', required: true };
    const a = checkAgainstCatalog(file, nowRequired);
    expect(a.ok, 'a stale flag is not a reason to withhold every draft').toBe(true);
    expect(kinds(a.findings)).toContain('required_flag_stale');

    // And the reverse: we withhold documents the engine would have accepted, so drafts are
    // needlessly incomplete. Also worth saying, also not worth blocking.
    const nowOptional = catalogFor(file);
    nowOptional.nodes['w2']!.fields!['box1_wages'] = { type: 'number', required: false };
    const b = checkAgainstCatalog(file, nowOptional);
    expect(b.ok).toBe(true);
    expect(b.findings.find((f) => f.engineField === 'box1_wages')!.detail).toMatch(/less complete|optional/);
  });

  it('advises when the engine requires a field the map sends nothing for', async () => {
    const file = await loadNodeMap(2025);
    const catalog = catalogFor(file);
    // §7's shape: the engine wants the taxpayer's own TIN and this app will never send one.
    catalog.nodes['w2']!.fields!['employee_tin'] = { type: 'string', required: true };

    const check = checkAgainstCatalog(file, catalog);
    const finding = check.findings.find((f) => f.kind === 'required_field_unmapped');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('advisory');
    // It must point at the right remedy: such a form type belongs in `unmappable`, not `forms`.
    expect(finding!.detail).toMatch(/unmappable/);
  });

  it('counts a constant the binding implies as sent, not as an unmapped requirement', async () => {
    const file = await loadNodeMap(2025);
    const withConstant = file.forms.find((f) => Object.keys(f.constants).length > 0);
    expect(withConstant, 'the shipped map should still have at least one constant').toBeDefined();

    const catalog = catalogFor(file);
    const key = Object.keys(withConstant!.constants)[0]!;
    catalog.nodes[withConstant!.nodeType]!.fields![key] = { type: 'boolean', required: true };

    const check = checkAgainstCatalog(file, catalog);
    expect(check.findings.filter((f) => f.engineField === key)).toEqual([]);
  });
});
