import { describe, expect, it } from 'vitest';
import { normalizeSpan } from '../src/layout/pass.ts';

/**
 * P7 exit criterion: span storage round-trips without coordinate drift, at multiple zoom
 * levels and DPIs. Normalizing to 0..1 on receipt is what makes that true regardless of
 * which provider policy selected.
 */
const dims = { widthPx: 1700, heightPx: 2200 };

describe('span normalization', () => {
  it('leaves already-normalized fractions alone', () => {
    const span = normalizeSpan({ text: 'x', x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.25 }, dims);
    expect(span).toEqual({ text: 'x', x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.25 });
  });

  it('converts pixel coordinates to page fractions', () => {
    const span = normalizeSpan({ text: 'x', x0: 170, y0: 220, x1: 340, y1: 440 }, dims);
    expect(span.x0).toBeCloseTo(0.1, 5);
    expect(span.y0).toBeCloseTo(0.1, 5);
    expect(span.x1).toBeCloseTo(0.2, 5);
    expect(span.y1).toBeCloseTo(0.2, 5);
  });

  it('produces identical fractions from the same page at different DPIs', () => {
    const at200 = normalizeSpan({ text: 'x', x0: 200, y0: 400, x1: 400, y1: 500 }, { widthPx: 1700, heightPx: 2200 });
    const at400 = normalizeSpan({ text: 'x', x0: 400, y0: 800, x1: 800, y1: 1000 }, { widthPx: 3400, heightPx: 4400 });
    expect(at200.x0).toBeCloseTo(at400.x0, 6);
    expect(at200.y1).toBeCloseTo(at400.y1, 6);
  });

  it('swaps an inverted box rather than storing something the overlay draws backwards', () => {
    const span = normalizeSpan({ text: 'x', x0: 0.4, y0: 0.5, x1: 0.2, y1: 0.3 }, dims);
    expect(span.x0).toBeLessThan(span.x1);
    expect(span.y0).toBeLessThan(span.y1);
  });

  it('clamps into range so a rounding overshoot cannot break the database constraint', () => {
    const span = normalizeSpan({ text: 'x', x0: -0.001, y0: 0, x1: 1.0000001, y1: 1.2 }, dims);
    expect(span.x0).toBeGreaterThanOrEqual(0);
    expect(span.x1).toBeLessThanOrEqual(1);
    expect(span.y1).toBeLessThanOrEqual(1);
  });
});
