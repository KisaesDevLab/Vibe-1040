/**
 * Layout pass (P7).
 *
 * A vision model reads the page and returns text spans with geometry. We store those spans
 * verbatim as the provenance substrate (§4) — the field binder later selects from them, so
 * no model is ever asked to invent a coordinate for a value.
 *
 * Coordinate normalization is this app's job, not the router's. The router passes provider
 * output through and policy can change which model serves at any time, so we normalize to
 * one convention on receipt and record which model produced each span set. A provider swap
 * mid-season then shows up as a model change in the data rather than as silent drift.
 *
 * The convention is detected **per page, over the whole span set**, not per span. GLM- and
 * Qwen-family vision models ground natively on a 0–1000 integer scale; a per-span "anything
 * above 1 is pixels" rule would divide those by the raster width and put every box in the
 * wrong place. The detected convention is recorded on the page row.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { layoutSpans, pages } from '../db/schema.ts';
import { completeJson, RouterCallError } from '../router/client.ts';
import { TASK_CLASS } from '../router/task-classes.ts';

/**
 * Requested response shape. Coordinates are asked for on a 0–1000 scale — the native
 * grounding convention of the models policy is expected to bind, and cheaper in output
 * tokens than fractional decimals — but `normalizeSpans` detects what actually came back
 * rather than trusting the model to have complied.
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
            x0: { type: 'number', description: 'Left edge in thousandths of page width: an integer 0–1000.' },
            y0: { type: 'number', description: 'Top edge in thousandths of page height: an integer 0–1000.' },
            x1: { type: 'number', description: 'Right edge in thousandths of page width: an integer 0–1000.' },
            y1: { type: 'number', description: 'Bottom edge in thousandths of page height: an integer 0–1000.' },
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

/** What scale the model actually used for the page. Recorded on `pages`. */
export type CoordConvention = 'fraction' | 'thousandths' | 'pixel';

/** Above this a span set is read as pixels, not thousandths. Slack for a model that rounds to 1001. */
const THOUSANDTHS_CEILING = 1050;

/**
 * Decide the convention once for the whole page.
 *
 * A page rasterized at 200–400 DPI is 1700–2200 px on the long edge, and a full-page
 * transcription always has a span near the bottom edge, so a genuine pixel set exceeds the
 * thousandths ceiling on every page that is not nearly empty. The ambiguity resolves in
 * favour of the convention we asked for.
 */
export function detectConvention(spans: readonly RawSpan[]): CoordConvention {
  if (!spans.length) return 'thousandths'; // nothing to detect; report what we asked for
  let max = 0;
  for (const s of spans) max = Math.max(max, s.x0, s.y0, s.x1, s.y1);
  if (max <= 1.5) return 'fraction';
  if (max <= THOUSANDTHS_CEILING) return 'thousandths';
  return 'pixel';
}

export interface NormalizedSpans {
  spans: RawSpan[];
  convention: CoordConvention;
  /** Set when pixel coordinates overshoot the page by more than 5% — the model used some fourth convention. */
  overshoot: boolean;
}

/**
 * Bring a page's spans into the 0..1 page-relative convention.
 *
 * The result is clamped, because a model that rounds 1.0000001 should not fail a database
 * constraint. Pixel coordinates against unknown page dimensions throw a plain Error rather
 * than dividing by the pipeline's `?? 1` fallback and clamping every box into the corner —
 * that is an app-data bug and must fail the job loudly, not park it as a router condition.
 */
export function normalizeSpans(spans: readonly RawSpan[], dims: PageDims): NormalizedSpans {
  const convention = detectConvention(spans);

  let sx = 1;
  let sy = 1;
  let overshoot = false;

  if (convention === 'thousandths') {
    sx = 1000;
    sy = 1000;
  } else if (convention === 'pixel') {
    if (!(dims.widthPx > 1) || !(dims.heightPx > 1)) {
      throw new Error(
        `layout pass returned pixel coordinates but page dimensions are unknown (${dims.widthPx}×${dims.heightPx})`,
      );
    }
    sx = dims.widthPx;
    sy = dims.heightPx;
    for (const s of spans) {
      if (Math.max(s.x0, s.x1) > dims.widthPx * 1.05 || Math.max(s.y0, s.y1) > dims.heightPx * 1.05) {
        overshoot = true;
        break;
      }
    }
  }

  const clamp = (v: number): number => Math.min(1, Math.max(0, v));

  const normalized = spans.map((span) => {
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
  });

  return { spans: normalized, convention, overshoot };
}

const PROMPT =
  'You are a document OCR engine. Transcribe every text span visible on this page of a US ' +
  'tax form and report its bounding box. Report each box as x0, y0, x1, y1 on a 0–1000 ' +
  'scale, where 0 is the left or top edge of the page and 1000 is the right or bottom edge. ' +
  'Use the same scale for every span. Transcribe exactly what is printed, including currency ' +
  'formatting and any dashes used to denote a printed zero. Do not interpret, summarize, ' +
  'total, or correct anything. An empty box has no span. Return JSON only; do not include ' +
  'markdown or commentary.';

/**
 * Second-attempt instruction for a page whose full transcription overran the output budget.
 * Back-page IRS instruction text is what blows the budget, and the binder never needs it.
 */
const DENSE_PAGE_PROMPT =
  ' This page is dense. Transcribe only spans that carry a box number or label, a dollar ' +
  'amount, a name, an identifier, a date, or a checkbox state. Skip paragraphs of printed ' +
  'instructions.';

export interface LayoutResult {
  spanCount: number;
  model: string;
  requestId: string;
  convention: CoordConvention;
}

function isTruncation(err: unknown): boolean {
  if (!(err instanceof RouterCallError)) return false;
  const f = err.failure;
  if (f.code === 'output_truncated') return true;
  return f.kind === 'permanent' && f.code === 'invalid_response' && f.reason === 'json_truncated';
}

/**
 * Run the layout pass for one page image and persist the spans.
 *
 * One page per request (§3). The image goes inline as a base64 data URI — never a URL,
 * which would mean a provider reaching back into our storage.
 *
 * On truncation, one retry with the dense-page instruction. A second truncation rethrows
 * and parks the page as `failed` with the router's reason, so an operator sees "page too
 * dense" rather than a generic failure.
 */
export async function runLayoutPass(
  pageId: string,
  imageJpeg: Buffer,
  dims: PageDims,
  ctx: { bundleId: string; userId?: string },
): Promise<LayoutResult> {
  const dataUri = `data:image/jpeg;base64,${imageJpeg.toString('base64')}`;

  const request = (systemPrompt: string) =>
    completeJson<z.infer<typeof layoutResponse>>(
      TASK_CLASS.LAYOUT,
      [
        { role: 'system', content: systemPrompt },
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

  let response;
  try {
    response = await request(PROMPT);
  } catch (err) {
    if (!isTruncation(err)) throw err;
    console.warn(
      `[layout] page ${pageId}: full transcription overran the output budget; retrying values-only`,
    );
    response = await request(PROMPT + DENSE_PAGE_PROMPT);
  }

  const { data, model, requestId } = response;
  const parsed = layoutResponse.parse(data);
  const { spans: normalized, convention, overshoot } = normalizeSpans(parsed.spans, dims);

  if (convention !== 'thousandths') {
    console.warn(
      `[layout] page ${pageId}: model ${model} returned ${convention} coordinates, not the requested 0–1000 scale`,
    );
  }
  if (overshoot) {
    console.warn(
      `[layout] page ${pageId}: model ${model} returned pixel coordinates beyond the ${dims.widthPx}×${dims.heightPx} raster; boxes were clamped`,
    );
  }

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

  await db.update(pages).set({ layoutCoordConvention: convention }).where(eq(pages.id, pageId));

  return { spanCount: normalized.length, model, requestId, convention };
}
