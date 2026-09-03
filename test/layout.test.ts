import { describe, expect, it } from 'vitest';
import { detectConvention, normalizeSpans, type RawSpan } from '../src/layout/pass.ts';

/**
 * P7 exit criterion: span storage round-trips without coordinate drift, at multiple zoom
 * levels and DPIs. Normalizing to 0..1 on receipt is what makes that true regardless of
 * which provider policy selected.
 *
 * The convention is detected per page over the whole span set. The failure this guards
 * against: GLM/Qwen-family vision models ground on a 0–1000 scale, and a per-span "anything
 * above 1 is pixels" rule divides those by the raster width and misplaces every box.
 */
const dims = { widthPx: 1700, heightPx: 2200 };

const span = (x0: number, y0: number, x1: number, y1: number, text = 'x'): RawSpan => ({
  text,
  x0,
  y0,
  x1,
  y1,
});

describe('convention detection', () => {
  it('reads an all-fraction set as fractions', () => {
    expect(detectConvention([span(0.1, 0.2, 0.3, 0.25), span(0.5, 0.9, 0.6, 0.95)])).toBe('fraction');
  });

  it('reads a 0–1000 integer set as thousandths, not pixels', () => {
    expect(detectConvention([span(170, 220, 340, 440), span(100, 950, 900, 990)])).toBe('thousandths');
  });

  it('reads a set with a bottom-edge span beyond 1000 as pixels', () => {
    expect(detectConvention([span(170, 220, 340, 440), span(100, 2050, 900, 2100)])).toBe('pixel');
  });

  it('decides once for the whole page — one large span flips the whole set to pixels', () => {
    const spans = [span(10, 10, 100, 40), span(10, 60, 100, 90), span(1400, 2000, 1600, 2100)];
    expect(detectConvention(spans)).toBe('pixel');
  });

  it('tolerates a model that rounds to just over 1000', () => {
    expect(detectConvention([span(0, 0, 1001, 1002)])).toBe('thousandths');
  });

  it('treats an empty set as the requested convention', () => {
    expect(detectConvention([])).toBe('thousandths');
  });
});

describe('span normalization', () => {
  it('leaves already-normalized fractions alone', () => {
    const { spans, convention } = normalizeSpans([span(0.1, 0.2, 0.3, 0.25)], dims);
    expect(convention).toBe('fraction');
    expect(spans[0]).toEqual({ text: 'x', x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.25 });
  });

  it('maps thousandths to fractions on both axes regardless of the raster size', () => {
    // The old per-span rule would have produced 500/1700 = 0.29 on x.
    const { spans, convention } = normalizeSpans([span(500, 500, 750, 600)], dims);
    expect(convention).toBe('thousandths');
    expect(spans[0]!.x0).toBeCloseTo(0.5, 6);
    expect(spans[0]!.y0).toBeCloseTo(0.5, 6);
    expect(spans[0]!.x1).toBeCloseTo(0.75, 6);
    expect(spans[0]!.y1).toBeCloseTo(0.6, 6);
  });

  it('converts pixel coordinates to page fractions', () => {
    const { spans, convention } = normalizeSpans([span(170, 220, 340, 440), span(0, 2000, 1700, 2200)], dims);
    expect(convention).toBe('pixel');
    expect(spans[0]!.x0).toBeCloseTo(0.1, 5);
    expect(spans[0]!.y0).toBeCloseTo(0.1, 5);
    expect(spans[0]!.x1).toBeCloseTo(0.2, 5);
    expect(spans[0]!.y1).toBeCloseTo(0.2, 5);
  });

  it('produces identical fractions from the same page at different DPIs', () => {
    const at200 = normalizeSpans([span(200, 400, 400, 500), span(0, 2100, 1700, 2200)], { widthPx: 1700, heightPx: 2200 });
    const at400 = normalizeSpans([span(400, 800, 800, 1000), span(0, 4200, 3400, 4400)], { widthPx: 3400, heightPx: 4400 });
    expect(at200.spans[0]!.x0).toBeCloseTo(at400.spans[0]!.x0, 6);
    expect(at200.spans[0]!.y1).toBeCloseTo(at400.spans[0]!.y1, 6);
  });

  it('swaps an inverted box rather than storing something the overlay draws backwards', () => {
    const { spans } = normalizeSpans([span(0.4, 0.5, 0.2, 0.3)], dims);
    expect(spans[0]!.x0).toBeLessThan(spans[0]!.x1);
    expect(spans[0]!.y0).toBeLessThan(spans[0]!.y1);
  });

  it('clamps into range so a rounding overshoot cannot break the database constraint', () => {
    const { spans } = normalizeSpans([span(-0.001, 0, 1.0000001, 1.2)], dims);
    expect(spans[0]!.x0).toBeGreaterThanOrEqual(0);
    expect(spans[0]!.x1).toBeLessThanOrEqual(1);
    expect(spans[0]!.y1).toBeLessThanOrEqual(1);
  });

  it('flags pixel coordinates that overshoot the raster instead of hiding them behind the clamp', () => {
    const { overshoot } = normalizeSpans([span(0, 0, 100, 50), span(0, 2000, 2500, 2100)], dims);
    expect(overshoot).toBe(true);
  });

  it('refuses to divide pixel coordinates by unknown page dimensions', () => {
    expect(() => normalizeSpans([span(0, 2000, 1700, 2100)], { widthPx: 1, heightPx: 1 })).toThrow(
      /page dimensions are unknown/,
    );
  });

  it('handles an empty span set without throwing', () => {
    const { spans, convention } = normalizeSpans([], { widthPx: 1, heightPx: 1 });
    expect(spans).toEqual([]);
    expect(convention).toBe('thousandths');
  });
});
