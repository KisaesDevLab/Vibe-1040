import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { OPENTAX_TEST_URL } from './helpers/opentax-global.ts';

/**
 * P17 stage 2: `opentax/server.mjs`, the HTTP wrapper around the engine's CLI.
 *
 * Driven over **real HTTP against a real child process**, with `test/helpers/fake-opentax.mjs`
 * standing in for the binary. That covers everything except the engine's own arithmetic: the
 * request shape, the `create` → `add` × n → `get` → `validate` sequence, a refused node, the
 * diagnostic split, and — the one that matters for §11 — that no state holding taxpayer
 * amounts survives the response.
 *
 * The engine itself is not here, and this test does not pretend otherwise.
 */
const base = OPENTAX_TEST_URL;

describe('health', () => {
  it('reports the engine version the binary prints', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('9.9.9-fake');
  });

  it('404s anything else, rather than guessing', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('POST /draft', () => {
  it('runs create → add → get → validate and returns the computed lines', async () => {
    const res = await fetch(`${base}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taxYear: 2025,
        nodes: [
          { nodeType: 'w2', documentId: 'doc-a', payload: { box1_wages: 55_000, box2_fed_withheld: 5_200 } },
          { nodeType: 'w2', documentId: 'doc-b', payload: { box1_wages: 12_000, box2_fed_withheld: 900 } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(body.returnId).toBe('fake-return-1');
    expect(body.year).toBe(2025);
    expect(body.engineVersion).toBe('9.9.9-fake');
    // Both W-2s reached the engine and it saw them as one return.
    expect(body.lines.line1z_total_wages).toBe(67_000);
    // The engine sends some lines as a two-element array of the same figure; the wrapper
    // passes the wire value through untouched, and `toCents` is what flattens it.
    expect(body.lines.line25a_w2_withheld).toEqual([6_100, 6_100]);
    expect(body.forms).toEqual(['w2']);
    expect(body.rejected).toEqual([]);
  });

  it('reports a node the engine refused without failing the whole draft', async () => {
    const res = await fetch(`${base}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taxYear: 2025,
        nodes: [
          { nodeType: 'w2', documentId: 'doc-a', payload: { box1_wages: 1_000, box2_fed_withheld: 0 } },
          { nodeType: 'reject_me', documentId: 'doc-bad', payload: {} },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    // The good node still computed.
    expect(body.lines.line1z_total_wages).toBe(1_000);
    // And the bad one is named, with the document it came from.
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].nodeType).toBe('reject_me');
    expect(body.rejected[0].documentId).toBe('doc-bad');
    expect(body.rejected[0].message).toContain('unknown node type');
  });

  it('splits diagnostics, and treats an unclassified one as hard', async () => {
    const res = await fetch(`${base}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taxYear: 2025, nodes: [] }),
    });
    const body = (await res.json()) as Record<string, any>;

    const hard = body.validation.hard.map((d: { code: string }) => d.code);
    const soft = body.validation.soft.map((d: { code: string }) => d.code);
    expect(hard).toContain('F1040-001');
    // No severity at all must land in hard: under-reporting a blocker is the worse error.
    expect(hard).toContain('F1040-XXX');
    expect(soft).toContain('F1040-900');
    expect(soft).toContain('warning');
  });

  it('refuses a body that is not JSON, and one missing taxYear or nodes', async () => {
    const notJson = await fetch(`${base}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(notJson.status).toBe(400);

    const missing = await fetch(`${base}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: [] }),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain('taxYear');
  });
});

describe('no taxpayer amounts survive the response (§11)', () => {
  it('leaves no taxpayer amount behind on disk', async () => {
    // A sentinel no other test uses, so this asserts the property directly rather than
    // counting directories — other test files share this wrapper and create their own.
    const sentinel = 987_654_321;

    await fetch(`${base}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taxYear: 2025,
        nodes: [{ nodeType: 'w2', documentId: 'd', payload: { box1_wages: sentinel } }],
      }),
    });

    // The wrapper wrote this amount to disk to compute with it. Nothing may still hold it.
    const dirs = (await readdir(tmpdir())).filter((n) => n.startsWith('opentax-'));
    const found: string[] = [];
    for (const dir of dirs) {
      const full = join(tmpdir(), dir);
      let entries: string[];
      try {
        entries = await readdir(full, { recursive: true });
      } catch {
        continue; // deleted underneath us, which is the point
      }
      for (const entry of entries) {
        try {
          const text = await readFile(join(full, entry), 'utf8');
          if (text.includes(String(sentinel))) found.push(join(dir, entry));
        } catch {
          // a directory, or already gone
        }
      }
    }
    expect(found, 'a taxpayer amount survived the response').toEqual([]);
  });

  it('gives each request its own state, so two drafts cannot bleed together', async () => {
    const draft = async (wages: number): Promise<number> => {
      const res = await fetch(`${base}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taxYear: 2025,
          nodes: [{ nodeType: 'w2', documentId: 'd', payload: { box1_wages: wages } }],
        }),
      });
      const body = (await res.json()) as Record<string, any>;
      return body.lines.line1z_total_wages;
    };

    const [a, b] = await Promise.all([draft(10_000), draft(20_000)]);
    // Neither is 30,000: no shared return, no cross-contamination between concurrent requests.
    expect([a, b].sort((x, y) => x - y)).toEqual([10_000, 20_000]);
  });
});

/**
 * The catalogue endpoint (`src/draft/catalog.ts` explains why it exists).
 *
 * The schema slices in the stand-in are copied verbatim out of engine 2.0.4, so these tests
 * are about the real formatting rather than a tidied-up version of it.
 */
describe('GET /catalog', () => {
  const catalog = async (nodes: string): Promise<any> => {
    const res = await fetch(`${base}/catalog?nodes=${nodes}`);
    expect(res.status).toBe(200);
    return res.json();
  };

  it('reports an array node\'s item fields, which is what a payload carries', async () => {
    const body = await catalog('w2');
    expect(body.engineVersion).toBe('9.9.9-fake');
    expect(body.nodes.w2.implemented).toBe(true);
    expect(body.nodes.w2.collection).toBe('w2s');
    expect(Object.keys(body.nodes.w2.fields)).toContain('box1_wages');
    // Requiredness survives a description sitting between the type and `(optional)`.
    expect(body.nodes.w2.fields.box1_wages.required).toBe(true);
    expect(body.nodes.w2.fields.employer_ein.required).toBe(false);
    expect(body.nodes.w2.fields.box3_ss_wages.required).toBe(false);
    // The collection header is not itself a field.
    expect(body.nodes.w2.fields.w2s).toBeUndefined();
  });

  it('keeps a top-level field that follows an array block out of the payload fields', async () => {
    const body = await catalog('f1099int');
    expect(body.nodes.f1099int.collection).toBe('f1099ints');
    // The item fields, which is what a payload carries.
    expect(Object.keys(body.nodes.f1099int.fields)).toEqual(
      expect.arrayContaining(['box1', 'payer_name', 'payer_tin']),
    );
    expect(body.nodes.f1099int.fields.payer_name.required).toBe(true);
    expect(body.nodes.f1099int.fields.box1.required).toBe(false);
    // `filing_status` sits at the top level, after the array block — known to exist on the
    // node, so a rename check still sees it, but not an item field.
    expect(body.nodes.f1099int.otherFields).toContain('filing_status');
    expect(Object.keys(body.nodes.f1099int.fields)).not.toContain('filing_status');
  });

  it('reads a flat node as flat even though it contains an array of its own', async () => {
    const body = await catalog('general');
    // The bug this pins: `general` embeds `dependents`, and treating that as the payload shape
    // picks a dependent's `first_name` over the taxpayer's `filing_status`.
    expect(body.nodes.general.collection).toBeNull();
    expect(body.nodes.general.fields.filing_status).toEqual({ type: 'enum', required: true });
    expect(body.nodes.general.fields.first_name).toBeUndefined();
    expect(body.nodes.general.otherFields).toContain('dependents');
  });

  it('reports a node type the engine does not have, rather than inventing an empty one', async () => {
    const body = await catalog('not_a_node');
    expect(body.nodes.not_a_node.implemented).toBe(false);
    expect(body.nodes.not_a_node.fields).toBeUndefined();
  });

  it('refuses a request that names no node types', async () => {
    expect((await fetch(`${base}/catalog`)).status).toBe(400);
    expect((await fetch(`${base}/catalog?nodes=`)).status).toBe(400);
  });
});
