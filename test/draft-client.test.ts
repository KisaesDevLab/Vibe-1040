import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeReturn, DraftEngineError, engineHealth } from '../src/draft/client.ts';
import { env } from '../src/config/env.ts';

/**
 * P17 stage 2: the app's own client, driven against the real wrapper over real HTTP.
 *
 * Two halves, and the first one matters as much as the second: with nothing listening, the
 * client must report a degraded state rather than throw something a route turns into a 500.
 * An optional checking aid that takes the appliance down with it would be worse than no
 * checking aid — the precedent is router-down parking (§3).
 *
 * `OPENTAX_URL` is set in vitest.config.ts to the port this file starts the wrapper on, so the
 * engine is genuinely absent until `beforeAll` and genuinely present afterwards.
 */

/** A loopback port with nothing on it, so "the engine is absent" is literally true. */
const DEAD_URL = 'http://127.0.0.1:18239';

describe('with no engine listening', () => {
  let restore: string;
  beforeAll(() => {
    restore = env.OPENTAX_URL;
    (env as { OPENTAX_URL: string }).OPENTAX_URL = DEAD_URL;
  });
  afterAll(() => {
    (env as { OPENTAX_URL: string }).OPENTAX_URL = restore;
  });

  it('reports unreachable rather than throwing', async () => {
    const health = await engineHealth();
    expect(health.ok).toBe(false);
    expect(health.version).toBeNull();
    expect(health.reason).toBe('unreachable');
  });

  it('throws a typed error whose code says the engine is absent, not that the input was wrong', async () => {
    await expect(computeReturn(2025, [])).rejects.toThrow(DraftEngineError);
    try {
      await computeReturn(2025, []);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DraftEngineError);
      const e = err as DraftEngineError;
      expect(e.code).toBe('engine_unreachable');
      // The distinction a route depends on to choose 503 over 502.
      expect(e.isUnavailable).toBe(true);
    }
  });
});

describe('with the engine listening', () => {

  it('reports healthy, with the version the binary prints', async () => {
    const health = await engineHealth();
    expect(health.ok).toBe(true);
    expect(health.version).toBe('9.9.9-fake');
  });

  it('parses a computed return, with lines, forms and diagnostics', async () => {
    const result = await computeReturn(2025, [
      { nodeType: 'w2', documentId: 'doc-a', payload: { box1_wages: 40_000, box2_fed_withheld: 3_000 } },
      { nodeType: 'w2', documentId: 'doc-b', payload: { box1_wages: 15_000, box2_fed_withheld: 1_100 } },
    ]);

    expect(result.returnId).toBe('fake-return-1');
    expect(result.year).toBe(2025);
    expect(result.engineVersion).toBe('9.9.9-fake');
    expect(result.lines['f1040']?.['line1z_total_wages']).toBe(55_000);
    expect(result.lines['f1040']?.['line25a_w2_withheld']).toBe(4_100);
    expect(result.forms).toEqual(['w2']);
    expect(result.validation.hard.map((d) => d.code)).toContain('F1040-001');
    expect(result.validation.soft.map((d) => d.code)).toContain('F1040-900');
    expect(result.rejected).toEqual([]);
  });

  it('surfaces a refused node without losing the rest of the draft', async () => {
    const result = await computeReturn(2025, [
      { nodeType: 'w2', documentId: 'doc-a', payload: { box1_wages: 9_000, box2_fed_withheld: 0 } },
      { nodeType: 'reject_me', documentId: 'doc-bad', payload: {} },
    ]);
    expect(result.lines['f1040']?.['line1z_total_wages']).toBe(9_000);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.documentId).toBe('doc-bad');
  });

  it('reports a refused input as invalid_input, which is an app bug, not an outage', async () => {
    // taxYear is required by the wrapper; omitting it is a 400.
    await expect(
      computeReturn(Number.NaN, [{ nodeType: 'w2', documentId: null, payload: {} }]),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    try {
      await computeReturn(Number.NaN, []);
    } catch (err) {
      expect((err as DraftEngineError).isUnavailable).toBe(false);
    }
  });
});
