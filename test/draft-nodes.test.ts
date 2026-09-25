import { describe, expect, it } from 'vitest';
import { assertConsistent, loadNodeMap, type NodeMapFile } from '../src/draft/nodes.ts';
import { registry } from '../src/schemas/registry.ts';

/**
 * P17: the node map is loaded and checked before any document is translated, so a form type
 * nobody thought about fails at startup rather than dropping an amount halfway through a
 * bundle. These tests are the reason the file can be trusted as data.
 */
describe('the shipped 2025 node map', () => {
  it('loads and passes its own consistency checks', async () => {
    const file = await loadNodeMap(2025);
    expect(file.taxYear).toBe(2025);
    expect(file.engine.name).toBe('opentax');
    expect(file.engine.formType).toBe('f1040');
    expect(file.forms.length).toBeGreaterThan(0);
  });

  it('declares every registered 2025 form type exactly once', async () => {
    const file = await loadNodeMap(2025);
    const reg = await registry();
    const mapped = new Set(file.forms.map((f) => f.formType));
    const unmappable = new Set(file.unmappable.map((u) => u.formType));

    for (const formType of reg.formTypes(2025)) {
      const inMapped = mapped.has(formType);
      const inUnmappable = unmappable.has(formType);
      // Named in the assertion so a failure says which form type, not just "false !== true".
      expect(`${formType}: mapped=${inMapped} unmappable=${inUnmappable}`).toBe(
        `${formType}: mapped=${inMapped} unmappable=${!inMapped}`,
      );
      expect(inMapped || inUnmappable).toBe(true);
    }
  });

  it('accounts for every field of every mapped form type exactly once', async () => {
    const file = await loadNodeMap(2025);
    const reg = await registry();

    for (const form of file.forms) {
      const schema = reg.get(form.formType, 2025);
      expect(schema, `${form.formType} has no 2025 schema`).toBeDefined();

      const seen: string[] = [];
      for (const f of form.fields) seen.push(f.fieldKey);
      for (const g of form.codeGroups) for (const p of g.pairs) seen.push(p.code, p.amount);
      for (const a of form.monthlyArrays) seen.push(...a.fieldKeys);
      for (const i of form.ignored) seen.push(i.fieldKey);

      expect(new Set(seen).size, `${form.formType} references a field twice`).toBe(seen.length);
      expect(
        [...seen].sort(),
        `${form.formType}: fields on the schema and fields in the node map must match`,
      ).toEqual(schema!.fields.map((f) => f.key).sort());
    }
  });

  it('never targets one engine field from two places', async () => {
    const file = await loadNodeMap(2025);
    for (const form of file.forms) {
      const targets = [
        ...form.fields.map((f) => f.nodeField),
        ...form.codeGroups.map((g) => g.nodeField),
        ...form.monthlyArrays.map((a) => a.nodeField),
        ...Object.keys(form.constants),
      ];
      expect(new Set(targets).size, `${form.formType} targets an engine field twice`).toBe(
        targets.length,
      );
    }
  });

  it('gives every unmappable form type a reason a preparer can read', async () => {
    const file = await loadNodeMap(2025);
    expect(file.unmappable.length).toBeGreaterThan(0);
    for (const u of file.unmappable) {
      expect(u.detail.length, `${u.formType} needs a detail`).toBeGreaterThan(40);
    }
  });

  it('keeps every K-1 and the SSA-1042S off the engine, as §8 requires', async () => {
    const file = await loadNodeMap(2025);
    const unmappable = new Map(file.unmappable.map((u) => [u.formType, u]));
    for (const formType of ['K-1-1065', 'K-1-1120S', 'K-1-1041', 'SSA-1042S']) {
      expect(unmappable.get(formType)?.reason, formType).toBe('policy_boxes_as_printed');
    }
  });

  it('keeps 1099-B off the engine, because the engine wants lots and this app has subtotals', async () => {
    const file = await loadNodeMap(2025);
    const b = file.unmappable.find((u) => u.formType === '1099-B');
    expect(b?.reason).toBe('engine_shape_mismatch');
  });

  it('never forwards a TIN to the engine', async () => {
    const file = await loadNodeMap(2025);
    const reg = await registry();
    for (const form of file.forms) {
      const schema = reg.get(form.formType, 2025);
      const tinKeys = new Set(
        (schema?.fields ?? []).filter((f) => f.sensitive === 'tin').map((f) => f.key),
      );
      for (const f of form.fields) {
        expect(tinKeys.has(f.fieldKey), `${form.formType} maps the TIN field ${f.fieldKey}`).toBe(
          false,
        );
      }
      for (const key of tinKeys) {
        const ignored = form.ignored.find((i) => i.fieldKey === key);
        expect(ignored?.reason, `${form.formType} ${key}`).toBe('tin_withheld');
      }
    }
  });
});

describe('load-time refusals', () => {
  const base = async (): Promise<NodeMapFile> =>
    structuredClone(await loadNodeMap(2025)) as NodeMapFile;

  it('refuses a map that leaves a field neither mapped nor ignored', async () => {
    const file = await base();
    const reg = await registry();
    const w2 = file.forms.find((f) => f.formType === 'W-2')!;
    w2.fields = w2.fields.filter((f) => f.fieldKey !== 'box_3');
    await expect(assertConsistent(file, reg)).rejects.toThrow(/box_3 is neither mapped nor ignored/);
  });

  it('refuses a map with a field key the schema does not have', async () => {
    const file = await base();
    const reg = await registry();
    const w2 = file.forms.find((f) => f.formType === 'W-2')!;
    w2.fields.push({ fieldKey: 'box_99', nodeField: 'box99', engineRequired: false });
    await expect(assertConsistent(file, reg)).rejects.toThrow(/box_99 is not on the schema/);
  });

  it('refuses a map that drops a registered form type entirely', async () => {
    const file = await base();
    const reg = await registry();
    file.forms = file.forms.filter((f) => f.formType !== 'W-2');
    await expect(assertConsistent(file, reg)).rejects.toThrow(/W-2 is registered as a form type but is absent/);
  });

  it('refuses a form type that is both mapped and unmappable', async () => {
    const file = await base();
    const reg = await registry();
    file.unmappable.push({ formType: 'W-2', reason: 'no_engine_node', detail: 'x'.repeat(50) });
    await expect(assertConsistent(file, reg)).rejects.toThrow(/both mapped and declared unmappable/);
  });

  it('refuses two boxes aimed at one engine field', async () => {
    const file = await base();
    const reg = await registry();
    const w2 = file.forms.find((f) => f.formType === 'W-2')!;
    const box3 = w2.fields.find((f) => f.fieldKey === 'box_3')!;
    box3.nodeField = 'box1_wages';
    await expect(assertConsistent(file, reg)).rejects.toThrow(/box1_wages is targeted twice/);
  });

  it('has no node map for a year with no file, and says adding one is a data change', async () => {
    await expect(loadNodeMap(1999)).rejects.toThrow(/data change, not a code change/);
  });

  it('refuses a map that leaves a worksheet line out of the comparison', async () => {
    const file = await base();
    const reg = await registry();
    file.lines.comparable = file.lines.comparable.filter((l) => l.lineRef !== '1040:1z');
    await expect(assertConsistent(file, reg)).rejects.toThrow(
      /line 1040:1z is neither compared against the engine nor declared notCompared/,
    );
  });

  it('refuses two worksheet lines compared against one engine line', async () => {
    const file = await base();
    const reg = await registry();
    const a = file.lines.comparable.find((l) => l.lineRef === '1040:1a')!;
    a.engineLine = 'line1z_total_wages';
    await expect(assertConsistent(file, reg)).rejects.toThrow(
      /engine line f1040.line1z_total_wages is compared against twice/,
    );
  });

  it('refuses a node-map line ref that is not in the line mappings', async () => {
    const file = await base();
    const reg = await registry();
    file.lines.notCompared.push({ lineRef: '1040:99', reason: 'not_a_line' });
    await expect(assertConsistent(file, reg)).rejects.toThrow(
      /line 1040:99 is in the node map but not in the 2025 line mappings/,
    );
  });
});

describe('the line comparison map', () => {
  it('declares every 2025 worksheet line exactly once', async () => {
    const file = await loadNodeMap(2025);
    const compared = new Set(file.lines.comparable.map((l) => l.lineRef));
    const not = new Set(file.lines.notCompared.map((l) => l.lineRef));
    expect([...compared].filter((r) => not.has(r))).toEqual([]);
    expect(compared.size + not.size).toBe(60);
  });

  it('offers engine-only figures a worksheet has no counterpart for', async () => {
    const file = await loadNodeMap(2025);
    const keys = file.lines.computedOnly.map((l) => l.engineLine);
    // The whole point of a draft return: numbers the worksheet cannot produce.
    expect(keys).toContain('line11_agi');
    expect(keys).toContain('line15_taxable_income');
    expect(keys).toContain('line24_total_tax');
    expect(keys).toContain('line35a_refund');
  });

  it('notes the lines where a disagreement is expected rather than a defect', async () => {
    const file = await loadNodeMap(2025);
    const noted = new Map(file.lines.comparable.filter((l) => l.note).map((l) => [l.lineRef, l.note!]));
    // These three are withheld from the engine by design, so they cannot agree.
    expect(noted.get('1040:6a')).toContain('withholds every SSA-1099');
    expect(noted.get('1040:7')).toContain('1099-B is unmappable');
    expect(noted.get('SCH1:21')).toContain('by meaning, not by number');
  });
});
