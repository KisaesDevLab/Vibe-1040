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
    required: ['form_type', 'confidence', 'continues_previous', 'corrected', 'void', 'is_summary', 'is_supplemental'],
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
      payer_name: { type: ['string', 'null'] },
      tax_year: { type: ['integer', 'null'] },
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
  payer_name: z.string().nullable().optional(),
  tax_year: z.number().int().nullable().optional(),
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
    'Use "1099-CONSOLIDATED" only for the cover or summary of a consolidated brokerage package.',
    'Sub-forms inside such a package (1099-INT, 1099-DIV, 1099-B sections) get their own type.',
    '',
    'Report what is printed. Do not infer a form type from context you cannot see on this page.',
    'If the page is not a recognizable tax form, return null for form_type and set',
    'is_supplemental true.',
  ].join('\n');
}

export async function classifyPage(
  pageId: string,
  imageJpeg: Buffer,
  formTypes: readonly string[],
  ctx: { bundleId: string; userId?: string; previousFormType?: string | null },
): Promise<PageClassification> {
  const dataUri = `data:image/jpeg;base64,${imageJpeg.toString('base64')}`;
  const previous = ctx.previousFormType
    ? `The previous page was classified as ${ctx.previousFormType}.`
    : 'This is the first page of the bundle.';

  const { data, model, requestId } = await completeJson<z.infer<typeof classifyResponse>>(
    TASK_CLASS.PAGE_CLASSIFY,
    [
      { role: 'system', content: systemPrompt(formTypes) },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${previous}\nClassify this page.` },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
    CLASSIFY_RESPONSE_SCHEMA,
    { bundleId: ctx.bundleId, ...(ctx.userId ? { userId: ctx.userId } : {}), temperature: 0 },
  );

  return { ...classifyResponse.parse(data), pageId, model, requestId };
}

// ── grouping ─────────────────────────────────────────────────────────────────

export interface DocumentGroup {
  formType: string | null;
  pageIds: string[];
  corrected: boolean;
  void: boolean;
  isSummary: boolean;
  isSupplemental: boolean;
  payerName: string | null;
  taxYear: number | null;
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
    const continues = page.continues_previous && sameForm && previous !== undefined;

    if (continues && previous) {
      previous.pageIds.push(page.pageId);
      previous.corrected ||= page.corrected;
      previous.void ||= page.void;
      previous.isSummary ||= page.is_summary;
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
      payerName: page.payer_name ?? null,
      taxYear: page.tax_year ?? null,
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
