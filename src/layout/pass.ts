/**
 * Layout pass (P7).
 *
 * A document-OCR model reads the page and returns text spans with geometry. We store those
 * spans verbatim as the provenance substrate (§4) — the field binder later selects from
 * them, so no model is ever asked to invent a coordinate for a value.
 *
 * Coordinate normalization is this app's job, not the router's. The router passes provider
 * output through and policy can change which model serves at any time, so we normalize to
 * one convention on receipt and record which model produced each span set. A provider swap
 * mid-season then shows up as a model change in the data rather than as silent drift.
 */
import { z } from 'zod';
import { db } from '../db/client.ts';
import { layoutSpans } from '../db/schema.ts';
import { completeJson } from '../router/client.ts';
import { TASK_CLASS } from '../router/task-classes.ts';

/**
 * Requested response shape. Coordinates are asked for as fractions of page width/height,
 * but `normalizeSpan` re-normalizes anything that clearly came back in pixels rather than
 * trusting the model to have complied.
 */
export const LAYOUT_RESPONSE_SCHEMA = {
  name: 'page_layout',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['spans'],
    properties: {
      spans: {
        type: 'array',
        description: 'Every text span on the page, in reading order.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'x0', 'y0', 'x1', 'y1'],
          properties: {
            text: { type: 'string' },
            x0: { type: 'number', description: 'Left edge as a fraction of page width (0–1).' },
            y0: { type: 'number', description: 'Top edge as a fraction of page height (0–1).' },
            x1: { type: 'number', description: 'Right edge as a fraction of page width (0–1).' },
            y1: { type: 'number', description: 'Bottom edge as a fraction of page height (0–1).' },
          },
        },
      },
    },
  },
} as const;

const layoutResponse = z.object({
  spans: z.array(
    z.object({
      text: z.string(),
      x0: z.number(),
      y0: z.number(),
      x1: z.number(),
      y1: z.number(),
    }),
  ),
});

export interface RawSpan {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageDims {
  widthPx: number;
  heightPx: number;
}

/**
 * Bring a span into the 0..1 page-relative convention.
 *
 * Two shapes turn up in practice: fractions already in 0..1, and absolute pixels. Anything
 * beyond 1 on either axis is treated as pixels and divided by the page dimension. The
 * result is clamped, because a model that rounds 1.0000001 should not fail a database
 * constraint.
 */
export function normalizeSpan(span: RawSpan, dims: PageDims): RawSpan {
  const looksLikePixels =
    span.x1 > 1.5 || span.y1 > 1.5 || span.x0 > 1.5 || span.y0 > 1.5;

  const sx = looksLikePixels ? dims.widthPx : 1;
  const sy = looksLikePixels ? dims.heightPx : 1;

  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const x0 = clamp(span.x0 / sx);
  const y0 = clamp(span.y0 / sy);
  const x1 = clamp(span.x1 / sx);
  const y1 = clamp(span.y1 / sy);

  // Some providers emit (x, y, w, h) styled as (x0, y0, x1, y1). An inverted box is the
  // tell; swapping is better than storing something the overlay will draw backwards.
  return {
    text: span.text,
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
  };
}

const PROMPT =
  'You are a document OCR engine. Transcribe every text span visible on this page of a US ' +
  'tax form and report its bounding box. Report boxes as fractions of the page width and ' +
  'height, between 0 and 1. Transcribe exactly what is printed, including currency ' +
  'formatting and any dashes used to denote a printed zero. Do not interpret, summarize, ' +
  'total, or correct anything. An empty box has no span.';

export interface LayoutResult {
  spanCount: number;
  model: string;
  requestId: string;
}

/**
 * Run the layout pass for one page image and persist the spans.
 *
 * One page per request (§3). The image goes inline as a base64 data URI — never a URL,
 * which would mean a provider reaching back into our storage.
 */
export async function runLayoutPass(
  pageId: string,
  imageJpeg: Buffer,
  dims: PageDims,
  ctx: { bundleId: string; userId?: string },
): Promise<LayoutResult> {
  const dataUri = `data:image/jpeg;base64,${imageJpeg.toString('base64')}`;

  const { data, model, requestId } = await completeJson<z.infer<typeof layoutResponse>>(
    TASK_CLASS.LAYOUT,
    [
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this page with span geometry.' },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
    LAYOUT_RESPONSE_SCHEMA,
    { bundleId: ctx.bundleId, ...(ctx.userId ? { userId: ctx.userId } : {}), temperature: 0 },
  );

  const parsed = layoutResponse.parse(data);
  const normalized = parsed.spans.map((s) => normalizeSpan(s, dims));

  if (normalized.length > 0) {
    await db.insert(layoutSpans).values(
      normalized.map((s, i) => ({
        pageId,
        spanIndex: i,
        text: s.text,
        x0: s.x0,
        y0: s.y0,
        x1: s.x1,
        y1: s.y1,
        producedByModel: model,
        routerRequestId: requestId,
      })),
    );
  }

  return { spanCount: normalized.length, model, requestId };
}
