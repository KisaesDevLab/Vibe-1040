/**
 * Page classification and bundle splitting (P4).
 *
 * Classifies each rasterized page as a form type, then groups contiguous pages into logical
 * documents. CORRECTED and VOID are detected here as first-class fields rather than being
 * buried in extraction, because a CORRECTED 1099 sitting unnoticed in a pile is exactly the
 * preparer error this tool is meant to surface.
 *
 * Consolidated brokerage packages get container treatment: the package is one document,
 * each internal sub-form becomes its own document with a parent link, and the summary and
 * supplemental pages are marked as such.
 */
import { z } from 'zod';
import { completeJson } from '../router/client.ts';
import { TASK_CLASS } from '../router/task-classes.ts';

export const CLASSIFY_RESPONSE_SCHEMA = {
  name: 'page_classification',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'form_type',
      'confidence',
      'continues_previous',
      'corrected',
      'void',
      'is_summary',
      'is_supplemental',
      'unrecognised_form',
    ],
    properties: {
      form_type: {
        type: ['string', 'null'],
        description: 'Registry form type, e.g. "W-2", "1099-INT". null if not a recognizable tax form.',
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      continues_previous: {
        type: 'boolean',
        description: 'True if this page continues the same document as the previous page.',
      },
      corrected: { type: 'boolean', description: 'The CORRECTED box is checked.' },
      void: { type: 'boolean', description: 'The VOID box is checked.' },
      is_summary: { type: 'boolean', description: 'A summary/totals page of a consolidated package.' },
      is_supplemental: {
        type: 'boolean',
        description: 'A non-form page: cover letter, instructions, supplemental detail.',
      },
      unrecognised_form: {
        type: 'boolean',
        description:
          'This page IS a tax document reporting amounts, but it matches none of the valid ' +
          'form types. Never true for a cover letter, instructions, or a detail page.',
      },
      payer_name: { type: ['string', 'null'] },
      tax_year: { type: ['integer', 'null'] },
      section_code: {
        type: ['string', 'null'],
        description:
          'For a 1099-B page only: the Form 8949 box letter printed in the section heading ' +
          '("Box A", "Short-term, basis reported to the IRS" → "A"; "Box D", "Long-term, ' +
          'basis reported" → "D", and so on through "F"). null for every other page and ' +
          'for a 1099-B page whose section heading is not visible.',
      },
    },
  },
} as const;

const classifyResponse = z.object({
  form_type: z.string().nullable(),
  confidence: z.number(),
  continues_previous: z.boolean(),
  corrected: z.boolean(),
  void: z.boolean(),
  is_summary: z.boolean(),
  is_supplemental: z.boolean(),
  // Older bindings predate this field; absent means "not flagged" rather than a parse error,
  // because a model that omits it must not park the page.
  unrecognised_form: z.boolean().optional().default(false),
  payer_name: z.string().nullable().optional(),
  tax_year: z.number().int().nullable().optional(),
  section_code: z.string().nullable().optional(),
});

export type PageClassification = z.infer<typeof classifyResponse> & {
  pageId: string;
  /** Which model classified the page — recorded on the document so a policy swap is visible. */
  model: string;
  requestId: string;
};

function systemPrompt(formTypes: readonly string[]): string {
  return [
    'You classify one page of a US individual tax-return source-document bundle.',
    '',
    `Valid form types: ${formTypes.join(', ')}.`,
    'Return form_type exactly as spelled in that list.',
    'Use "1099-CONSOLIDATED" only for the cover or summary of a consolidated brokerage package.',
    'Sub-forms inside such a package (1099-INT, 1099-DIV, 1099-B sections) get their own type.',
    'A 1099-B is split by Form 8949 section: report the section letter (A–F) printed in the',
    'heading as section_code, and set continues_previous false when a new section starts.',
    'A page may print several copies of one form (Copy B, Copy C, Copy 2). That is still one',
    'page of one form type.',
    '',
    'When the exact text layer of the page is supplied, it came from the PDF itself and is',
    'more reliable than your reading of the image for names, years, and form numbers.',
    '',
    'Report what is printed. Do not infer a form type from context you cannot see on this page.',
    '',
    'When form_type is null, say WHICH kind of null it is. These are different pages and the',
    'app treats them differently:',
    '  - a cover letter, instruction sheet, blank page, or a detail/continuation page that',
    '    belongs to a form above it: set is_supplemental true, unrecognised_form false.',
    '  - a page that IS a tax document reporting amounts, but whose form is not in the valid',
    '    list above or cannot be read: set unrecognised_form true.',
    'A page a preparer would need to look at is never merely supplemental. If you are unsure',
    'which of the two it is, set unrecognised_form true — a page wrongly surfaced costs a',
    'reviewer seconds, and a tax document wrongly filed as a cover letter is money missing',
    'from the worksheet with nothing on screen to say so.',
  ].join('\n');
}

/** How much of a page's text layer goes to the classifier. Enough for any form header. */
const TEXT_LAYER_HINT_CHARS = 4000;

export async function classifyPage(
  pageId: string,
  imageJpeg: Buffer,
  formTypes: readonly string[],
  ctx: {
    bundleId: string;
    userId?: string;
    previousFormType?: string | null;
    /** Exact text the PDF carried, when the page has a usable text layer. */
    textLayer?: string | null;
  },
): Promise<PageClassification> {
  const dataUri = `data:image/jpeg;base64,${imageJpeg.toString('base64')}`;
  const previous = ctx.previousFormType
    ? `The previous page was classified as ${ctx.previousFormType}.`
    : 'This is the first page of the bundle.';

  const hint = ctx.textLayer
    ? `\n\nExact text layer of this page (from the PDF, truncated):\n${ctx.textLayer.slice(0, TEXT_LAYER_HINT_CHARS)}`
    : '';

  const { data, model, requestId } = await completeJson<z.infer<typeof classifyResponse>>(
    TASK_CLASS.PAGE_CLASSIFY,
    [
      { role: 'system', content: systemPrompt(formTypes) },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${previous}\nClassify this page.${hint}` },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
    CLASSIFY_RESPONSE_SCHEMA,
    { bundleId: ctx.bundleId, ...(ctx.userId ? { userId: ctx.userId } : {}), temperature: 0 },
  );

  const parsed = classifyResponse.parse(data);
  return {
    ...parsed,
    form_type: normalizeFormType(parsed.form_type, formTypes),
    section_code: normalizeSectionCode(parsed.section_code),
    pageId,
    model,
    requestId,
  };
}

// ── form-type normalization ──────────────────────────────────────────────────

/**
 * Map whatever spelling the model used onto a registry key.
 *
 * The response schema cannot carry an `enum` — the router validates forced-JSON output
 * against the schema and fails the whole response on one violation, so one creative spelling
 * would park the page. Instead the spelling is normalized here: "Form W2", "1099 INT",
 * "Schedule K-1 (Form 1065)" and "SSA 1042-S" all resolve to their registry keys. A string
 * that resolves to nothing is returned trimmed so it lands as `no_registered_schema` with the
 * model's own words visible, never silently dropped.
 */
export function normalizeFormType(raw: string | null, known: readonly string[]): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const knownByKey = new Map(known.map((k) => [k.toUpperCase(), k]));
  const direct = knownByKey.get(trimmed.toUpperCase());
  if (direct) return direct;

  let u = trimmed
    .toUpperCase()
    .replace(/[()]/g, ' ')
    .replace(/\bFORMS?\b/g, ' ')
    .replace(/\bSCHEDULE\b/g, ' ')
    .replace(/\bIRS\b/g, ' ')
    .replace(/[\s_/.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // "W2" → "W-2", "1099INT" → "1099-INT", "K1" → "K-1", "SSA1099" → "SSA-1099".
  u = u
    .replace(/^W2(G?)$/, 'W-2$1')
    .replace(/^(\d{4})([A-Z]+)$/, '$1-$2')
    .replace(/^K1\b/, 'K-1')
    .replace(/^(SSA|RRB)(\d{4}S?)$/, '$1-$2')
    .replace(/^(SSA|RRB)-(\d{4})-S$/, '$1-$2S')
    .replace(/^1099-(SSA|RRB)$/, '$1-1099')
    .replace(/^CONSOLIDATED-1099$/, '1099-CONSOLIDATED')
    .replace(/^1099-COMPOSITE$/, '1099-CONSOLIDATED')
    .replace(/^K-1-1120-S$/, 'K-1-1120S');

  // "SCHEDULE K-1 (FORM 1065)" arrives as "K-1-1065" by now; "1065-K-1" also appears.
  const k1 = u.match(/^(1065|1120S|1041)-K-1$/);
  if (k1) u = `K-1-${k1[1]}`;

  const exact = knownByKey.get(u);
  if (exact) return exact;

  // Last resort: compare with every separator removed.
  const squash = (v: string): string => v.replace(/[^A-Z0-9]/g, '');
  const squashed = squash(u);
  for (const [key, original] of knownByKey) {
    if (squash(key) === squashed) return original;
  }
  return trimmed;
}

/** A Form 8949 section letter, or null. Tolerates "Box A", "Section D", "a". */
export function normalizeSectionCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.toUpperCase().match(/\b([A-F])\b/);
  return m ? m[1]! : null;
}

// ── text-layer pre-classification ────────────────────────────────────────────

export interface TextLayerHint {
  formType: string;
  taxYear: number | null;
  evidence: string;
}

/**
 * Read the form number off an exact text layer, without a model.
 *
 * Native digital forms print their own name — "Form W-2", "Form 1099-INT", "Schedule K-1
 * (Form 1065)". This is not a classifier on its own: instruction sheets and cover letters
 * mention form names too. It is a cross-check that is logged when it disagrees with the
 * model, and it promotes a page the model could not name to `unrecognised_form` when the
 * text plainly says a tax form is present.
 */
export function preclassifyFromText(text: string | null, known: readonly string[]): TextLayerHint | null {
  if (!text) return null;
  const upper = text.toUpperCase();

  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/SCHEDULE\s+K-?1\s*\(?\s*FORM\s+(1065|1120-?S|1041)\s*\)?/, (m) => `K-1-${m[1]!.replace('-', '')}`],
    [/FORM\s+(SSA|RRB)[-\s]?(1099|1042-?S)\b/, (m) => `${m[1]}-${m[2]!.replace('-', '')}`],
    [/FORM\s+(W-?2G?)\b/, (m) => m[1]!.replace(/^W2/, 'W-2')],
    [/FORM\s+(1099)[-\s]?([A-Z]{1,4})\b/, (m) => `1099-${m[2]}`],
    [/FORM\s+(1098)(?:[-\s]?([ET]))?\b/, (m) => (m[2] ? `1098-${m[2]}` : '1098')],
    [/FORM\s+(1095-?A)\b/, () => '1095-A'],
    [/FORM\s+(5498)(?:[-\s]?(SA))?\b/, (m) => (m[2] ? '5498-SA' : '5498')],
  ];

  for (const [pattern, toKey] of patterns) {
    const m = upper.match(pattern);
    if (!m) continue;
    const formType = normalizeFormType(toKey(m), known);
    if (!formType || !known.includes(formType)) continue;
    return { formType, taxYear: dominantYear(upper), evidence: m[0] };
  }
  return null;
}

/** Most frequent plausible tax year printed on the page, or null. */
function dominantYear(upper: string): number | null {
  const counts = new Map<number, number>();
  for (const m of upper.matchAll(/\b(20[0-9]{2})\b/g)) {
    const year = Number(m[1]);
    if (year < 2015 || year > 2035) continue;
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
}

// ── grouping ─────────────────────────────────────────────────────────────────

export interface DocumentGroup {
  /** A tax document whose form type is not registered — surfaced, never dropped (§6, §9). */
  unrecognisedForm?: boolean;
  formType: string | null;
  pageIds: string[];
  corrected: boolean;
  void: boolean;
  isSummary: boolean;
  isSupplemental: boolean;
  payerName: string | null;
  taxYear: number | null;
  /** Form 8949 section letter for a 1099-B document; one document per section. */
  sectionCode: string | null;
  confidence: number;
  /** Model that classified the group's first page. */
  classifierModel: string;
  classifierRequestId: string;
  /** Index into the returned array; set for sub-forms of a consolidated package. */
  parentIndex?: number;
}

/**
 * Group classified pages into logical documents.
 *
 * A page joins the previous document when the model says it continues it *and* the form
 * type agrees. Requiring both is deliberate: `continues_previous` alone will happily weld
 * a 1099-DIV onto the 1099-INT above it inside a consolidated package.
 *
 * Once a consolidated package is open, subsequent sub-form documents are parented to it
 * until a page appears that is neither a sub-form nor supplemental.
 */
export function groupPages(classifications: readonly PageClassification[]): DocumentGroup[] {
  const groups: DocumentGroup[] = [];
  let openContainerIndex: number | null = null;

  const SUBFORM_TYPES = new Set(['1099-INT', '1099-DIV', '1099-B', '1099-OID', '1099-MISC']);

  for (const page of classifications) {
    const previous = groups[groups.length - 1];
    const sameForm = previous?.formType === page.form_type;
    // A 1099-B page that prints a new section heading starts a new document even when the
    // model says it continues: section subtotals only foot when each section is its own
    // document (§6). A page with no heading visible inherits the open section.
    const sectionCode = page.section_code ?? null;
    const sectionBreak =
      sectionCode !== null && previous !== undefined && previous.sectionCode !== sectionCode;
    const continues = page.continues_previous && sameForm && !sectionBreak && previous !== undefined;

    if (continues && previous) {
      previous.pageIds.push(page.pageId);
      previous.corrected ||= page.corrected;
      previous.void ||= page.void;
      previous.isSummary ||= page.is_summary;
      previous.unrecognisedForm ||= page.unrecognised_form;
      previous.payerName ??= page.payer_name ?? null;
      previous.taxYear ??= page.tax_year ?? null;
      previous.confidence = Math.min(previous.confidence, page.confidence);
      continue;
    }

    const group: DocumentGroup = {
      formType: page.form_type,
      pageIds: [page.pageId],
      corrected: page.corrected,
      void: page.void,
      isSummary: page.is_summary,
      isSupplemental: page.is_supplemental,
      unrecognisedForm: page.unrecognised_form,
      payerName: page.payer_name ?? null,
      taxYear: page.tax_year ?? null,
      sectionCode: page.form_type === '1099-B' ? sectionCode : null,
      confidence: page.confidence,
      classifierModel: page.model,
      classifierRequestId: page.requestId,
    };

    if (page.form_type === '1099-CONSOLIDATED') {
      groups.push(group);
      openContainerIndex = groups.length - 1;
      continue;
    }

    if (
      openContainerIndex !== null &&
      page.form_type !== null &&
      SUBFORM_TYPES.has(page.form_type)
    ) {
      group.parentIndex = openContainerIndex;
    } else if (page.form_type !== null && !page.is_supplemental) {
      // A standalone form ends the package.
      openContainerIndex = null;
    }

    groups.push(group);
  }

  return groups;
}

/** Bundle majority tax year; per-document mismatches are flagged against this (§7). */
export function majorityTaxYear(groups: readonly DocumentGroup[]): number | null {
  const counts = new Map<number, number>();
  for (const g of groups) {
    if (g.taxYear === null) continue;
    counts.set(g.taxYear, (counts.get(g.taxYear) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
}
