/**
 * Field-binding pass (P8).
 *
 * Takes the stored layout spans plus the registered schema and asks the model to bind
 * schema fields to span indices. The model selects from spans it was given; it never
 * produces a coordinate. A field it cannot tie to a span comes back with `span_ids: []`
 * and is force-routed to review regardless of anything else (§4).
 *
 * The spans are presented **with their position**. A tax form is a grid: the only thing
 * that ties "85,000.00" to box 1 rather than box 3 is where it sits relative to the label,
 * and a flat list of span text throws that away. Spans are grouped into rows by vertical
 * overlap and listed left to right with their coordinates in thousandths of the page, so
 * the model can read the grid the way a person does. Optionally the page image goes along
 * too (`EXTRACT_ATTACH_PAGE_IMAGE`), in which case the class is registered as a vision class
 * and the model reads the form directly while still only *selecting* span ids.
 *
 * Confidence. The router surfaces no logprobs (resolved Q4), and running the same prompt
 * twice at temperature 0 against the same model measures nothing — the outputs agree
 * whether or not they are right. The signal used instead is verification: every bound
 * value is checked against the text of the spans it cites, and a value that does not
 * appear in its own evidence is flagged `span_mismatch`. A second pass, when configured,
 * runs at a non-zero temperature and optionally against a different model so that
 * agreement means something.
 */
import { z } from 'zod';
import { parseMoney } from '../lib/money.ts';
import { setting } from '../settings/store.ts';
import { completeJson, type CallOptions } from '../router/client.ts';
import { TASK_CLASS } from '../router/task-classes.ts';
import type { FormSchema } from '../schemas/registry.ts';

export interface StoredSpan {
  id: string;
  spanIndex: number;
  text: string;
  pageId: string;
  /** Page-relative 0..1 geometry, as stored. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A page image to show the binder alongside the spans (optional, §4). */
export interface PageImage {
  pageId: string;
  jpeg: Buffer;
}

const boundField = z.object({
  field_key: z.string(),
  /** Verbatim text as printed. Null means the box is blank — NOT zero (§5). */
  value: z.string().nullable(),
  /** Indices into the span list we supplied. Empty means "could not locate". */
  span_indices: z.array(z.number().int().nonnegative()),
});

const bindResponse = z.object({ fields: z.array(boundField) });

export interface BoundValue {
  fieldKey: string;
  /** Raw printed text, before money parsing. */
  raw: string | null;
  spanIds: string[];
  pageId: string | null;
  /** The value does not appear in the text of the spans it cites. */
  spanMismatch: boolean;
}

export interface BindResult {
  values: Map<string, BoundValue>;
  passCount: number;
  disagreements: Set<string>;
  /** Fields whose winning value is not supported by the spans it cites. */
  mismatches: Set<string>;
  model: string;
  requestId: string;
}

function responseSchemaFor(schema: FormSchema): { name: string; schema: unknown } {
  return {
    name: `bind_${schema.formType.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['field_key', 'value', 'span_indices'],
            properties: {
              // Deliberately not an `enum`. The router validates forced-JSON responses
              // against this schema and fails the whole response on one violation, so a
              // single invented key would cost a router retry and fallback and then park the
              // document. Unknown keys are dropped app-side instead (see singlePass).
              field_key: {
                type: 'string',
                description: `One of: ${schema.fields.map((f) => f.key).join(', ')}.`,
              },
              value: {
                type: ['string', 'null'],
                description:
                  'Exactly as printed. null if the box is empty. A printed zero (including "-0-") is "0", not null.',
              },
              span_indices: { type: 'array', items: { type: 'integer' } },
            },
          },
        },
      },
    },
  };
}

const SYSTEM = [
  'You bind fields of a US tax form to text spans that were already extracted from the page.',
  '',
  'The spans are listed one page at a time, grouped into rows from top to bottom and ordered',
  'left to right within a row. Each span shows its index, its left edge x and top edge y in',
  'thousandths of the page, and its text. A box on a tax form prints its number and label',
  'first and its value below or to the right of the label, inside the same box; use the',
  'coordinates to tell which label a value belongs to. Values in the next column belong to',
  'the next box, not to this one.',
  '',
  'Rules you must not break:',
  '1. Report every field in the schema, even when the box is empty.',
  '2. An empty box is null. A box that prints a zero (including "-0-") is "0". These are',
  '   different and the distinction matters more than anything else in this task. A box',
  '   that shows only a pre-printed "$" and nothing after it is EMPTY: report null, never 0.',
  '   Report "0" only when you can cite the span that prints the zero.',
  '2b. A checkbox that is not marked is "false" with span_indices []. A marked checkbox is',
  '   "true" and cites the span of the mark or of the box label next to it.',
  '3. Copy values exactly as printed. Do not compute, total, convert, or correct anything.',
  '4. span_indices must reference the spans you were given, and the value must be the text of',
  '   those spans (or a part of one span, when a label and its value share a span). If you',
  '   cannot locate a value on the page, return an empty span_indices array rather than',
  '   guessing an index.',
  '5. Never invent a value that is not visible in the spans.',
  '6. A page may print several copies of the same form (Copy B, Copy C, Copy 2). The copies',
  '   carry identical values. Bind the top-most copy and cite its spans only.',
  '7. When a page image is supplied, it is the same page the spans came from. Read it to',
  '   resolve layout, but still cite the span indices for every value.',
].join('\n');

/** Two spans share a row when their vertical extents overlap by at least this fraction. */
const ROW_OVERLAP = 0.4;

interface Row {
  y0: number;
  y1: number;
  spans: StoredSpan[];
}

/** Group one page's spans into visual rows, top to bottom, left to right. */
export function groupIntoRows(spans: readonly StoredSpan[]): Row[] {
  const sorted = [...spans].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows: Row[] = [];
  for (const span of sorted) {
    const last = rows[rows.length - 1];
    if (last) {
      const overlap = Math.min(last.y1, span.y1) - Math.max(last.y0, span.y0);
      const height = Math.min(last.y1 - last.y0, span.y1 - span.y0) || 1e-6;
      if (overlap / height >= ROW_OVERLAP) {
        last.spans.push(span);
        last.y0 = Math.min(last.y0, span.y0);
        last.y1 = Math.max(last.y1, span.y1);
        continue;
      }
    }
    rows.push({ y0: span.y0, y1: span.y1, spans: [span] });
  }
  for (const row of rows) row.spans.sort((a, b) => a.x0 - b.x0);
  return rows;
}

const thousandths = (v: number): string => String(Math.round(v * 1000)).padStart(3, '0');

/**
 * Serialize spans with geometry, one page at a time.
 *
 * Format per row: `y=213: [12]@x=050 "1 Wages, tips, other compensation" | [13]@x=300 "85,000.00"`.
 * Compact enough that a dense consolidated page still fits, explicit enough that a label
 * and the value under it are visibly related.
 */
export function serializeSpans(spans: readonly StoredSpan[]): string {
  const byPage = new Map<string, StoredSpan[]>();
  for (const span of spans) {
    const list = byPage.get(span.pageId) ?? [];
    list.push(span);
    byPage.set(span.pageId, list);
  }
  const out: string[] = [];
  let pageNumber = 0;
  for (const pageSpans of byPage.values()) {
    pageNumber += 1;
    out.push(`--- page ${pageNumber} of ${byPage.size} ---`);
    for (const row of groupIntoRows(pageSpans)) {
      const cells = row.spans.map(
        (s) => `[${s.spanIndex}]@x=${thousandths(s.x0)} ${JSON.stringify(s.text)}`,
      );
      out.push(`y=${thousandths(row.y0)}: ${cells.join(' | ')}`);
    }
  }
  return out.join('\n');
}

export function buildUserMessage(schema: FormSchema, spans: readonly StoredSpan[]): string {
  const fieldList = schema.fields
    .map((f) => `  ${f.key}${f.box ? ` (box ${f.box})` : ''}: ${f.label} [${f.type}]`)
    .join('\n');
  return [
    `Form type: ${schema.formType} (tax year ${schema.taxYear})`,
    '',
    'Fields to bind:',
    fieldList,
    '',
    'Spans extracted from the page, with position (x and y in thousandths of the page):',
    serializeSpans(spans),
  ].join('\n');
}

// ── de-identification placeholders ───────────────────────────────────────────

/**
 * The router's scrubber rewrites text content parts for a `cloud_deidentified` class, so
 * the binder sees "[EIN]" or "[SSN]" where the span list said 47-2918453, and faithfully
 * copies the placeholder back. The spans stored on this side are the unscrubbed originals
 * and the model still cites them, so the real value is recoverable here without another
 * call: an identifier-shaped token from the cited span text, or the whole span when the
 * placeholder stood for all of it.
 */
const PLACEHOLDER = /\[[A-Z][A-Z0-9_ -]*\]/;

const IDENTIFIER_SHAPES: [RegExp, RegExp][] = [
  [/\[(?:EIN|TIN|PAYER'?S? TIN|FEDERAL ID)\]/i, /\b\d{2}-\d{7}\b/],
  [/\[(?:SSN|ITIN|TIN|RECIPIENT'?S? TIN)\]/i, /\b\d{3}[- ]\d{2}[- ]\d{4}\b|\b\d{9}\b/],
  [/\[(?:PHONE|TEL)[A-Z ]*\]/i, /\(?\d{3}\)?[ -]?\d{3}-\d{4}/],
];

export function recoverPlaceholder(raw: string | null, cited: readonly StoredSpan[]): string | null {
  if (raw === null || !PLACEHOLDER.test(raw) || !cited.length) return raw;
  const joined = cited.map((s) => s.text).join(' ');
  for (const [tag, shape] of IDENTIFIER_SHAPES) {
    if (!tag.test(raw)) continue;
    const m = joined.match(shape);
    if (m) return m[0];
  }
  // The placeholder replaced the whole value (a name, an address): take the span text.
  return raw.trim().replace(PLACEHOLDER, '').trim() === '' ? joined : raw;
}

// ── verification against cited spans ─────────────────────────────────────────

const normalizeText = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Does the bound value appear in the spans it cites?
 *
 * Money compares in cents, so "$1,234.00" cites "1,234" happily; a value the cited spans
 * do not contain is a misread even when it looks plausible. Text compares normalized and
 * accepts either direction of containment, because a name may be one span of several or
 * one span may hold a label and its value together.
 */
export function valueSupportedBySpans(
  raw: string | null,
  cited: readonly StoredSpan[],
  isMoney: boolean,
): boolean {
  if (raw === null || raw.trim() === '') return true; // a blank cites nothing to check
  if (!cited.length) return false;
  const joined = cited.map((s) => s.text).join(' ');

  if (isMoney) {
    const wanted = parseMoney(raw);
    if (wanted.kind !== 'amount') return normalizeText(joined).includes(normalizeText(raw));
    for (const span of cited) {
      const got = parseMoney(span.text);
      if (got.kind === 'amount' && got.cents === wanted.cents) return true;
      // A label and its value in one span: "1 Wages ... 85,000.00". Take the last money-like token.
      const tokens = span.text.match(/\(?-?\$?[\d,]+(?:\.\d{1,2})?\)?/g) ?? [];
      for (const token of tokens) {
        const t = parseMoney(token);
        if (t.kind === 'amount' && t.cents === wanted.cents) return true;
      }
    }
    return false;
  }

  const a = normalizeText(raw);
  const b = normalizeText(joined);
  if (!a) return true;
  return b.includes(a) || a.includes(b);
}

// ── passes ───────────────────────────────────────────────────────────────────

interface PassOptions extends CallOptions {
  images?: readonly PageImage[];
}

async function singlePass(
  schema: FormSchema,
  spans: readonly StoredSpan[],
  options: PassOptions,
): Promise<{ values: Map<string, BoundValue>; model: string; requestId: string }> {
  const byIndex = new Map(spans.map((s) => [s.spanIndex, s]));
  const moneyKeys = new Set(schema.fields.filter((f) => f.type === 'money').map((f) => f.key));
  const { images, ...callOptions } = options;

  const userContent = images?.length
    ? [
        { type: 'text' as const, text: buildUserMessage(schema, spans) },
        ...images.map((img) => ({
          type: 'image_url' as const,
          image_url: { url: `data:image/jpeg;base64,${img.jpeg.toString('base64')}` },
        })),
      ]
    : buildUserMessage(schema, spans);

  const { data, model, requestId } = await completeJson<z.infer<typeof bindResponse>>(
    TASK_CLASS.FIELD_EXTRACT,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userContent },
    ],
    responseSchemaFor(schema),
    callOptions,
  );

  const parsed = bindResponse.parse(data);
  const values = new Map<string, BoundValue>();
  const known = new Set(schema.fields.map((f) => f.key));

  for (const field of parsed.fields) {
    if (!known.has(field.field_key)) continue; // hallucinated key; drop it
    const resolved = field.span_indices.map((i) => byIndex.get(i)).filter((s): s is StoredSpan => !!s);
    const raw = recoverPlaceholder(field.value, resolved);
    values.set(field.field_key, {
      fieldKey: field.field_key,
      raw,
      spanIds: resolved.map((s) => s.id),
      pageId: resolved[0]?.pageId ?? null,
      spanMismatch: !valueSupportedBySpans(raw, resolved, moneyKeys.has(field.field_key)),
    });
  }
  return { values, model, requestId };
}

/** Compare two passes on the value that will actually be stored, not on raw formatting. */
function comparable(raw: string | null, isMoney: boolean): string {
  if (raw === null) return ' null';
  if (!isMoney) return raw.trim();
  const parsed = parseMoney(raw);
  return parsed.kind === 'amount' ? String(parsed.cents) : ` ${parsed.kind}`;
}

/**
 * Bind a document's fields.
 *
 * Pass 1 runs at temperature 0. Further passes (`EXTRACT_PASSES` ≥ 2) run at
 * `EXTRACT_SECOND_PASS_TEMPERATURE` and, when `EXTRACT_SECOND_PASS_MODEL` names one, ask
 * policy for a different model; disagreement between *different* readings is the flag.
 * Escalation to `EXTRACT_PASSES_ON_DISAGREEMENT` happens only when passes disagree.
 *
 * On a majority the winner is the value most passes produced, preferring a candidate that
 * is supported by its own spans. A three-way split keeps the first pass's value and stays
 * flagged, because there is nothing to break the tie with.
 */
export async function bindFields(
  schema: FormSchema,
  spans: readonly StoredSpan[],
  ctx: { bundleId: string; userId?: string; images?: readonly PageImage[] },
): Promise<BindResult> {
  const moneyKeys = new Set(schema.fields.filter((f) => f.type === 'money').map((f) => f.key));
  const base: PassOptions = {
    bundleId: ctx.bundleId,
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...(ctx.images?.length ? { images: ctx.images } : {}),
  };
  const firstPass = { ...base, temperature: 0 };
  // Firm settings, editable in the admin UI without a restart; each seeds from its env var.
  const passCount = await setting<number>('extract.passes');
  const passesOnDisagreement = await setting<number>('extract.passes_on_disagreement');
  const secondPassModel = (await setting<string>('extract.second_pass_model')).trim();
  const laterPass: PassOptions = {
    ...base,
    temperature: await setting<number>('extract.second_pass_temperature'),
    ...(secondPassModel ? { model: secondPassModel } : {}),
  };

  const passes = [await singlePass(schema, spans, firstPass)];
  for (let i = 1; i < passCount; i += 1) {
    passes.push(await singlePass(schema, spans, laterPass));
  }

  const disagreements = new Set<string>();
  const allKeys = new Set(passes.flatMap((p) => [...p.values.keys()]));

  for (const key of allKeys) {
    const seen = passes.map((p) => comparable(p.values.get(key)?.raw ?? null, moneyKeys.has(key)));
    if (new Set(seen).size > 1) disagreements.add(key);
  }

  if (disagreements.size > 0 && passes.length < passesOnDisagreement) {
    while (passes.length < passesOnDisagreement) {
      passes.push(await singlePass(schema, spans, laterPass));
    }
  }

  const values = new Map<string, BoundValue>();
  const stillDisagreeing = new Set<string>();
  const mismatches = new Set<string>();

  for (const key of allKeys) {
    const candidates = passes
      .map((p) => p.values.get(key))
      .filter((v): v is BoundValue => v !== undefined);
    if (!candidates.length) continue;

    const tally = new Map<string, { count: number; value: BoundValue }>();
    for (const candidate of candidates) {
      const signature = comparable(candidate.raw, moneyKeys.has(key));
      const entry = tally.get(signature);
      if (entry) {
        entry.count += 1;
        // Prefer the reading that is supported by its own spans as the representative.
        if (entry.value.spanMismatch && !candidate.spanMismatch) entry.value = candidate;
      } else tally.set(signature, { count: 1, value: candidate });
    }

    const ranked = [...tally.values()].sort(
      (a, b) => b.count - a.count || Number(a.value.spanMismatch) - Number(b.value.spanMismatch),
    );
    const winner = ranked[0]!;
    values.set(key, winner.value);

    if (tally.size > 1) stillDisagreeing.add(key);
    if (winner.value.spanMismatch) mismatches.add(key);
  }

  return {
    values,
    passCount: passes.length,
    disagreements: stillDisagreeing,
    mismatches,
    model: passes[0]!.model,
    requestId: passes[0]!.requestId,
  };
}
