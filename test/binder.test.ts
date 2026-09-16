import { describe, expect, it } from 'vitest';
import {
  buildUserMessage,
  groupIntoRows,
  serializeSpans,
  valueSupportedBySpans,
  type StoredSpan,
} from '../src/extract/binder.ts';
import type { FormSchema } from '../src/schemas/registry.ts';

const span = (
  i: number,
  text: string,
  x0: number,
  y0: number,
  w = 0.1,
  h = 0.012,
  pageId = 'p1',
): StoredSpan => ({ id: `s${i}`, spanIndex: i, text, pageId, x0, y0, x1: x0 + w, y1: y0 + h });

/**
 * The binder used to see `[12] 85,000.00` with no position at all. On a W-2 grid the only
 * thing that ties a value to box 1 rather than box 3 is where it sits, so the serialization
 * has to carry it.
 */
describe('spatial serialization', () => {
  it('groups spans that share a baseline into one row, left to right', () => {
    const rows = groupIntoRows([
      span(2, '2 Federal income tax withheld', 0.55, 0.2),
      span(1, '1 Wages, tips, other compensation', 0.05, 0.2),
      span(3, '85,000.00', 0.06, 0.215),
      span(4, '11,420.00', 0.56, 0.215),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.spans.map((s) => s.spanIndex)).toEqual([1, 2]);
    expect(rows[1]!.spans.map((s) => s.spanIndex)).toEqual([3, 4]);
  });

  it('emits index, x, and text per cell and y per row, in thousandths', () => {
    const out = serializeSpans([span(0, '1 Wages', 0.05, 0.2), span(1, '85,000.00', 0.06, 0.215)]);
    expect(out).toContain('--- page 1 of 1 ---');
    expect(out).toContain('y=200: [0]@x=050 "1 Wages"');
    expect(out).toContain('y=215: [1]@x=060 "85,000.00"');
  });

  it('separates pages of a multi-page document', () => {
    const out = serializeSpans([span(0, 'a', 0.1, 0.1, 0.1, 0.01, 'p1'), span(1, 'b', 0.1, 0.1, 0.1, 0.01, 'p2')]);
    expect(out).toContain('--- page 1 of 2 ---');
    expect(out).toContain('--- page 2 of 2 ---');
  });

  it('lists the schema fields with their box numbers ahead of the spans', () => {
    const schema = {
      formType: 'W-2',
      taxYear: 2025,
      version: '1',
      description: '',
      container: false,
      allJudgmentRequired: false,
      checks: [],
      fields: [{ key: 'box_1', label: 'Wages', type: 'money', nullable: true, box: '1', repeating: false, judgmentRequired: false }],
    } as unknown as FormSchema;
    const msg = buildUserMessage(schema, [span(0, '1 Wages', 0.05, 0.2)]);
    expect(msg).toContain('box_1 (box 1): Wages [money]');
    expect(msg.indexOf('Fields to bind')).toBeLessThan(msg.indexOf('Spans extracted'));
  });
});

/**
 * Verification is the confidence signal (decision 2026-09-16). A value that does not appear
 * in the spans it cites is a misread, whatever a second pass would have said.
 */
describe('valueSupportedBySpans', () => {
  it('accepts a money value whose cited span parses to the same cents', () => {
    expect(valueSupportedBySpans('$85,000.00', [span(0, '85,000.00', 0, 0)], true)).toBe(true);
    expect(valueSupportedBySpans('85000', [span(0, '85,000.00', 0, 0)], true)).toBe(true);
  });

  it('accepts a value embedded in a label-plus-value span', () => {
    expect(valueSupportedBySpans('85,000.00', [span(0, '1 Wages, tips, other compensation 85,000.00', 0, 0)], true)).toBe(true);
  });

  it('rejects a money value the cited spans do not contain', () => {
    expect(valueSupportedBySpans('85,000.00', [span(0, '58,000.00', 0, 0)], true)).toBe(false);
    expect(valueSupportedBySpans('85,000.00', [span(0, '1 Wages, tips, other compensation', 0, 0)], true)).toBe(false);
  });

  it('accepts a printed zero and -0- against each other', () => {
    expect(valueSupportedBySpans('0', [span(0, '-0-', 0, 0)], true)).toBe(true);
  });

  it('treats a blank as needing no support and a populated value with no spans as unsupported', () => {
    expect(valueSupportedBySpans(null, [], true)).toBe(true);
    expect(valueSupportedBySpans('', [], true)).toBe(true);
    expect(valueSupportedBySpans('12.00', [], true)).toBe(false);
  });

  it('compares text loosely, in either direction of containment', () => {
    expect(valueSupportedBySpans('ACME MANUFACTURING INC', [span(0, 'Acme Manufacturing, Inc.', 0, 0)], false)).toBe(true);
    expect(valueSupportedBySpans('ACME', [span(0, 'ACME MANUFACTURING INC', 0, 0)], false)).toBe(true);
    expect(valueSupportedBySpans('OZARK REGIONAL HEALTH', [span(0, 'ACME MANUFACTURING INC', 0, 0)], false)).toBe(false);
  });
});
