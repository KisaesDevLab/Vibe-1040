/**
 * Bundle pipeline (P2 → P9).
 *
 * The stages are separate jobs rather than one long function so that a router outage parks
 * a page rather than failing a bundle (§3), and so a bundle can resume from where it
 * stopped after the router comes back.
 *
 * Order: rasterize → classify + split → propose identity → layout → bind fields → reconcile.
 * The reviewer confirms identity before a **worksheet**, not before extraction (§7).
 *
 * Stage completion is **recorded, never inferred** (0007). "Layout is done when every page
 * has a span row" stalled on any blank page, and "extraction is done when no document is
 * still `classified`" stalled on any cover letter. Every stage now writes a completion
 * fact on the row it worked on, including the paths that produce nothing, and the
 * `advanceAfter*` functions are the only place a bundle moves from one stage to the next.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  bundles,
  checkResults,
  dispositions,
  documents,
  layoutSpans,
  pages,
  routerJobs,
  sourceFiles,
} from '../db/schema.ts';
import {
  classifyPage,
  groupPages,
  majorityTaxYear,
  preclassifyFromText,
  type PageClassification,
} from '../classify/pass.ts';
import { env } from '../config/env.ts';
import { bindFields, type PageImage, type StoredSpan } from '../extract/binder.ts';
import { persistBoundFields } from '../extract/persist.ts';
import { resolveDocumentFields } from '../extract/resolve.ts';
import { harvestIdentityFromText } from '../identity/harvest.ts';
import { proposeIdentity, saveProposal, type TinObservation } from '../identity/resolve.ts';
import { runLayoutPass } from '../layout/pass.ts';
import {
  excessSocialSecurityWithheld,
  noLayoutSpansResult,
  noRegisteredSchemaResult,
  runChecks,
  schemaYearSubstitutedResult,
  unrecognisedFormResult,
  type BundleCheckContext,
  type CheckContext,
  type CheckResult,
  type FieldValue,
} from '../reconcile/checks.ts';
import { taxTableFor } from '../reconcile/tax-tables.ts';
import { shouldTranscribe, transcribePage } from '../ocr/transcribe.ts';
import { RouterCallError } from '../router/client.ts';
import { TASK_CLASS } from '../router/task-classes.ts';
import { registry } from '../schemas/registry.ts';
import { blobs } from '../storage/index.ts';
import { pipelineQueue, type PageMetadata } from './queues.ts';

/** Producer recorded on spans the sidecar measured from the PDF text layer. */
export const TEXT_LAYER_SPAN_PRODUCER = 'pymupdf';

/** Every exit from extraction writes one of these on the document (0007). */
export type ExtractionOutcome =
  | 'extracted'
  | 'skipped_supplemental'
  | 'skipped_unclassified'
  | 'no_schema'
  | 'no_spans';

/** Record a router-facing unit of work so the UI can say "the router is down" (§3). */
async function parkJob(
  taskClass: string,
  ids: { bundleId: string; documentId?: string; pageId?: string },
  err: RouterCallError,
): Promise<void> {
  await db.insert(routerJobs).values({
    bundleId: ids.bundleId,
    documentId: ids.documentId ?? null,
    pageId: ids.pageId ?? null,
    taskClass,
    state: err.failure.kind === 'permanent' ? 'failed' : 'parked',
    lastErrorCode: err.failure.code,
    lastErrorMessage:
      err.failure.kind === 'permanent' && err.failure.reason
        ? `${err.failure.message} (${err.failure.reason})`
        : err.failure.message,
    retryAfter:
      err.failure.kind === 'retry' ? new Date(Date.now() + err.failure.afterSeconds * 1000) : null,
  });
}

// ── P2 → persist sidecar output ──────────────────────────────────────────────

export async function recordRasterOutput(
  bundleId: string,
  sourceFileId: string,
  metadata: readonly PageMetadata[],
): Promise<void> {
  if (!metadata.length) return;
  const inserted = await db
    .insert(pages)
    .values(
      metadata.map((p) => ({
        bundleId,
        sourceFileId,
        pageNumber: p.pageNumber,
        route: p.route,
        hasTextLayer: p.hasTextLayer,
        textLayerGarbled: p.textLayerGarbled,
        textLayer: p.textLayer,
        dpi: p.dpi,
        encoding: p.encoding,
        widthPx: p.widthPx,
        heightPx: p.heightPx,
        encodedBytes: p.encodedBytes,
        rasterStorageKey: p.rasterStorageKey,
      })),
    )
    .returning({ id: pages.id, pageNumber: pages.pageNumber });

  /**
   * Exact geometry from the text layer (§4, decision 2026-09-16).
   *
   * A native digital page arrives with word boxes the sidecar measured from the PDF itself.
   * They are stored as this page's layout spans, produced by `pymupdf`, and the page is
   * marked laid out. No vision model estimates a box for a page whose PDF already knows
   * where every word is, and no pixel leaves the appliance to find out.
   */
  const idByNumber = new Map(inserted.map((row) => [row.pageNumber, row.id]));
  for (const p of metadata) {
    if (!p.layoutSpans) continue;
    const pageId = idByNumber.get(p.pageNumber);
    if (!pageId) continue;
    if (p.layoutSpans.length) {
      await db.insert(layoutSpans).values(
        p.layoutSpans.map((s, i) => ({
          pageId,
          spanIndex: i,
          text: s.text,
          x0: s.x0,
          y0: s.y0,
          x1: s.x1,
          y1: s.y1,
          producedByModel: TEXT_LAYER_SPAN_PRODUCER,
          routerRequestId: null,
        })),
      );
    }
    await db
      .update(pages)
      .set({
        layoutCoordConvention: 'fraction',
        layoutCompletedAt: new Date(),
        spanCount: p.layoutSpans.length,
        layoutSource: 'text_layer',
      })
      .where(eq(pages.id, pageId));
  }

  await db
    .update(sourceFiles)
    .set({ pageCount: metadata.length })
    .where(eq(sourceFiles.id, sourceFileId));
}

// ── P4/P5 → classify, split, propose identity ────────────────────────────────

export async function classifyBundle(bundleId: string, userId: string): Promise<void> {
  await db.update(bundles).set({ status: 'classifying' }).where(eq(bundles.id, bundleId));

  const forms = await registry();
  const bundleRow = (await db.select().from(bundles).where(eq(bundles.id, bundleId)).limit(1))[0];
  const knownTypes = forms.formTypes(bundleRow?.taxYear ?? 2025);

  /**
   * A re-run regroups pages into new documents. The old documents (and, by cascade, their
   * extracted fields and corrections) go first, otherwise every reprocess doubled the
   * document list. The reprocess route warns before discarding corrections.
   */
  await db.update(pages).set({ documentId: null }).where(eq(pages.bundleId, bundleId));
  await db.delete(documents).where(eq(documents.bundleId, bundleId));

  const pageRows = await db
    .select({ id: pages.id, key: pages.rasterStorageKey, textLayer: pages.textLayer, route: pages.route })
    .from(pages)
    .where(and(eq(pages.bundleId, bundleId), isNotNull(pages.rasterStorageKey)))
    .orderBy(asc(pages.sourceFileId), asc(pages.pageNumber));

  const classifications: PageClassification[] = [];
  let previousFormType: string | null = null;

  for (const page of pageRows) {
    try {
      const image = await blobs.get(page.key!);
      const textLayer = page.route === 'text_layer' ? page.textLayer : null;
      const result = await classifyPage(page.id, image, knownTypes, {
        bundleId,
        userId,
        previousFormType,
        textLayer,
      });

      /**
       * Cross-check against the exact text. The text layer is not a classifier on its own
       * (instruction sheets name forms too), but a disagreement is worth a log line, and a
       * page the model could not name that plainly says "Form 1099-INT" is a tax document
       * that must surface rather than file as a cover letter (§6).
       */
      const hint = preclassifyFromText(textLayer, knownTypes);
      if (hint) {
        if (result.form_type === null && !result.is_supplemental && !result.unrecognised_form) {
          console.warn(
            `[classify] page ${page.id}: model returned no form type but the text layer says "${hint.evidence}"; surfacing as unrecognised`,
          );
          result.unrecognised_form = true;
        } else if (result.form_type !== null && result.form_type !== hint.formType) {
          console.warn(
            `[classify] page ${page.id}: model said ${result.form_type}, text layer says ${hint.formType} ("${hint.evidence}")`,
          );
        }
        // The exact text wins on the year. Models read "(Rev. January 2024)" as the tax
        // year on a continuous-use 1099 whose big printed year says 2025; the text-layer
        // reader ignores revision dates and prefers "For calendar year".
        if (hint.taxYear !== null && result.tax_year !== hint.taxYear) {
          if (result.tax_year != null) {
            console.warn(
              `[classify] page ${page.id}: model said tax year ${result.tax_year}, text layer says ${hint.taxYear}; using the text layer`,
            );
          }
          result.tax_year = hint.taxYear;
        }
      }

      classifications.push(result);
      previousFormType = result.form_type;
    } catch (err) {
      if (err instanceof RouterCallError) {
        await parkJob(TASK_CLASS.PAGE_CLASSIFY, { bundleId, pageId: page.id }, err);
        await db.update(bundles).set({ status: 'blocked' }).where(eq(bundles.id, bundleId));
        return;
      }
      throw err;
    }
  }

  const groups = groupPages(classifications);
  const bundleYear = majorityTaxYear(groups);
  const createdIds: string[] = [];

  for (const group of groups) {
    const parentId = group.parentIndex !== undefined ? createdIds[group.parentIndex] : null;
    const [doc] = await db
      .insert(documents)
      .values({
        bundleId,
        parentDocumentId: parentId ?? null,
        formType: group.formType,
        taxYear: group.taxYear,
        taxYearMismatch: group.taxYear !== null && bundleYear !== null && group.taxYear !== bundleYear,
        corrected: group.corrected,
        void: group.void,
        isSummary: group.isSummary,
        isSupplemental: group.isSupplemental,
        unrecognisedForm: group.unrecognisedForm ?? false,
        sectionCode: group.sectionCode,
        payerName: group.payerName,
        classifierConfidence: group.confidence,
        classifierModel: group.classifierModel,
        classifierRequestId: group.classifierRequestId,
        status: 'classified',
      })
      .returning({ id: documents.id });

    createdIds.push(doc!.id);
    for (const pageId of group.pageIds) {
      await db.update(pages).set({ documentId: doc!.id }).where(eq(pages.id, pageId));
    }
  }

  /**
   * Propose identity now, from the page text layer, so the §7 gate has something to show
   * before extraction finishes. The post-extraction proposal refines it.
   */
  const identityPages = await db
    .select({ documentId: pages.documentId, textLayer: pages.textLayer })
    .from(pages)
    .where(eq(pages.bundleId, bundleId));

  const docFormTypes = new Map<string, { formType: string | null; taxYear: number | null }>();
  for (const [index, group] of groups.entries()) {
    const id = createdIds[index];
    if (id) docFormTypes.set(id, { formType: group.formType, taxYear: group.taxYear });
  }

  const observations: TinObservation[] = [];
  for (const page of identityPages) {
    if (!page.documentId) continue;
    const { tins, name } = harvestIdentityFromText(page.textLayer);
    for (const rawTin of tins) {
      observations.push({
        documentId: page.documentId,
        rawTin,
        name,
        formType: docFormTypes.get(page.documentId)?.formType ?? null,
      });
    }
  }

  if (observations.length) {
    const documentYears = [...docFormTypes.entries()].map(([documentId, meta]) => ({
      documentId,
      taxYear: meta.taxYear,
    }));
    await saveProposal(bundleId, proposeIdentity(observations, documentYears));
  }

  await db.update(bundles).set({ taxYear: bundleYear }).where(eq(bundles.id, bundleId));

  await startExtraction(bundleId, userId);
}

// ── P7 → layout ──────────────────────────────────────────────────────────────

export async function layoutPage(bundleId: string, pageId: string, userId: string): Promise<void> {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page?.rasterStorageKey) return;

  // Done already — by the sidecar for a text-layer page, or by a previous model pass.
  // Spans are immutable once written (§4); re-running must not duplicate them.
  if (page.layoutCompletedAt) return;

  /**
   * Optional OCR transcription first, for a page with no text layer. Failure here is never
   * fatal: the job is recorded and layout proceeds exactly as it would have without it.
   */
  if (shouldTranscribe(page)) {
    try {
      await transcribePage(bundleId, pageId, userId);
    } catch (err) {
      if (err instanceof RouterCallError) {
        await parkJob(TASK_CLASS.OCR_TRANSCRIBE, { bundleId, pageId }, err);
      } else {
        throw err;
      }
    }
  }

  try {
    const image = await blobs.get(page.rasterStorageKey);
    await runLayoutPass(
      pageId,
      image,
      { widthPx: page.widthPx ?? 1, heightPx: page.heightPx ?? 1 },
      { bundleId, userId },
    );
  } catch (err) {
    if (err instanceof RouterCallError) {
      await parkJob(TASK_CLASS.LAYOUT, { bundleId, pageId }, err);
      return;
    }
    throw err;
  }
}

// ── P8 → bind fields ─────────────────────────────────────────────────────────

async function finishDocument(
  documentId: string,
  outcome: ExtractionOutcome,
  extra: Partial<typeof documents.$inferInsert> = {},
): Promise<void> {
  await db
    .update(documents)
    .set({ ...extra, extractionOutcome: outcome, extractionCompletedAt: new Date() })
    .where(eq(documents.id, documentId));
}

export async function extractDocument(
  bundleId: string,
  documentId: string,
  userId: string,
): Promise<void> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) return;

  if (doc.isSupplemental) return finishDocument(documentId, 'skipped_supplemental');
  if (!doc.formType) return finishDocument(documentId, 'skipped_unclassified');

  const forms = await registry();
  const resolved = forms.resolve(doc.formType, doc.taxYear ?? 2025);

  if (!resolved) {
    /**
     * No registered schema for this form type in any year. This must not be a silent skip:
     * the outcome is recorded here and reconcile raises the hard failure from it, so the
     * failure survives the check-result reset (it used to be written here and deleted there).
     */
    return finishDocument(documentId, 'no_schema', { status: 'needs_review' });
  }

  const spanRows = await db
    .select({
      id: layoutSpans.id,
      spanIndex: layoutSpans.spanIndex,
      text: layoutSpans.text,
      pageId: layoutSpans.pageId,
      x0: layoutSpans.x0,
      y0: layoutSpans.y0,
      x1: layoutSpans.x1,
      y1: layoutSpans.y1,
    })
    .from(layoutSpans)
    .innerJoin(pages, eq(pages.id, layoutSpans.pageId))
    .where(eq(pages.documentId, documentId))
    .orderBy(asc(pages.pageNumber), asc(layoutSpans.spanIndex));

  if (!spanRows.length) return finishDocument(documentId, 'no_spans', { status: 'needs_review' });

  // Span indices are per page; renumber across the document so the binder sees one list.
  const spans: StoredSpan[] = spanRows.map((s, i) => ({ ...s, spanIndex: i }));

  let images: PageImage[] | undefined;
  if (env.EXTRACT_ATTACH_PAGE_IMAGE) {
    const docPages = await db
      .select({ id: pages.id, key: pages.rasterStorageKey })
      .from(pages)
      .where(and(eq(pages.documentId, documentId), isNotNull(pages.rasterStorageKey)))
      .orderBy(asc(pages.pageNumber))
      .limit(4);
    images = [];
    for (const p of docPages) images.push({ pageId: p.id, jpeg: await blobs.get(p.key!) });
  }

  try {
    const bound = await bindFields(resolved.schema, spans, {
      bundleId,
      userId,
      ...(images ? { images } : {}),
    });
    const persisted = await persistBoundFields(documentId, resolved.schema, bound);

    // §7: the plaintext TIN never lands in a column. It is hashed here and discarded.
    if (persisted.sensitiveValues.size) {
      const observations: TinObservation[] = [...persisted.sensitiveValues.values()].map((raw) => ({
        documentId,
        rawTin: raw,
        name: doc.payerName,
        formType: doc.formType,
      }));
      const proposal = proposeIdentity(observations, [{ documentId, taxYear: doc.taxYear }]);
      await saveProposal(bundleId, proposal);
    }

    await finishDocument(documentId, 'extracted', {
      status: 'extracted',
      formSchemaVersion: resolved.schema.version,
    });
  } catch (err) {
    if (err instanceof RouterCallError) {
      // Outcome stays null: the document is not finished until a requeue completes it.
      await parkJob(TASK_CLASS.FIELD_EXTRACT, { bundleId, documentId }, err);
      return;
    }
    throw err;
  }
}

// ── P9 → reconcile ───────────────────────────────────────────────────────────

/**
 * Re-attach a carried-forward disposition to its recomputed check result.
 *
 * `createdAt` is copied from the original so the record still says when the decision was
 * actually made, not when the bundle was last reprocessed.
 */
async function carryDisposition(
  carryable: Map<
    string,
    {
      kind: (typeof dispositions.kind.enumValues)[number];
      note: string;
      dispositionedBy: string;
      createdAt: Date;
    }
  >,
  key: string,
  checkResultId: string,
): Promise<void> {
  const prior = carryable.get(key);
  if (!prior) return;
  await db.insert(dispositions).values({
    checkResultId,
    kind: prior.kind,
    note: prior.note,
    dispositionedBy: prior.dispositionedBy,
    createdAt: prior.createdAt,
  });
}

export async function reconcileBundle(bundleId: string): Promise<{ hardFailures: number; softFailures: number }> {
  await db.update(bundles).set({ status: 'reconciling' }).where(eq(bundles.id, bundleId));

  const [bundle] = await db.select().from(bundles).where(eq(bundles.id, bundleId)).limit(1);
  const forms = await registry();
  const docs = await db.select().from(documents).where(eq(documents.bundleId, bundleId));

  /**
   * Carry human dispositions across a re-run. A disposition is carried forward only when
   * the finding is materially the same: same document, same check, same actual amount.
   */
  const priorDispositions = await db
    .select({
      documentId: checkResults.documentId,
      checkKey: checkResults.checkKey,
      actualCents: checkResults.actualCents,
      kind: dispositions.kind,
      note: dispositions.note,
      dispositionedBy: dispositions.dispositionedBy,
      createdAt: dispositions.createdAt,
    })
    .from(dispositions)
    .innerJoin(checkResults, eq(checkResults.id, dispositions.checkResultId))
    .where(eq(checkResults.bundleId, bundleId));

  const carryKey = (documentId: string | null, checkKey: string, actualCents: number | null): string =>
    `${documentId ?? '-'}|${checkKey}|${actualCents ?? '-'}`;
  const carryable = new Map(
    priorDispositions.map((d) => [carryKey(d.documentId, d.checkKey, d.actualCents), d]),
  );

  // Clear prior results so a re-run after corrections does not accumulate stale failures.
  await db.delete(checkResults).where(eq(checkResults.bundleId, bundleId));

  let hardFailures = 0;
  let softFailures = 0;

  const record = async (documentId: string | null, result: CheckResult): Promise<void> => {
    if (result.outcome === 'fail') {
      if (result.severity === 'hard') hardFailures += 1;
      else softFailures += 1;
    }
    const [row] = await db
      .insert(checkResults)
      .values({
        bundleId,
        documentId,
        checkKey: result.checkKey,
        severity: result.severity,
        outcome: result.outcome,
        message: result.message,
        expectedCents: result.expectedCents ?? null,
        actualCents: result.actualCents ?? null,
        toleranceCents: result.toleranceCents ?? null,
        detail: result.detail ?? {},
      })
      .returning({ id: checkResults.id });
    if (result.outcome === 'fail') {
      await carryDisposition(carryable, carryKey(documentId, result.checkKey, result.actualCents ?? null), row!.id);
    }
  };

  const resolvedByDoc = new Map<string, Map<string, FieldValue>>();
  for (const doc of docs) {
    resolvedByDoc.set(doc.id, (await resolveDocumentFields(doc.id)).fields);
  }

  /**
   * Document-state failures come first. These are recomputed from what the document row
   * says happened to it, so they survive the reset above — a page nobody could read must be
   * louder than one they could, not quieter (§6, §9).
   */
  for (const doc of docs) {
    if (doc.unrecognisedForm) await record(doc.id, unrecognisedFormResult());
    if (doc.extractionOutcome === 'no_schema' && doc.formType) {
      await record(doc.id, noRegisteredSchemaResult(doc.formType, doc.taxYear));
    }
    if (doc.extractionOutcome === 'no_spans' && doc.formType) {
      await record(doc.id, noLayoutSpansResult(doc.formType));
    }
  }

  for (const doc of docs) {
    if (!doc.formType || doc.isSupplemental) continue;
    if (doc.extractionOutcome !== 'extracted') continue;
    const docYear = doc.taxYear ?? bundle?.taxYear ?? 2025;
    const resolved = forms.resolve(doc.formType, docYear);
    if (!resolved) continue;
    if (doc.taxYear !== null && resolved.resolvedYear !== doc.taxYear) {
      await record(doc.id, schemaYearSubstitutedResult(doc.formType, doc.taxYear, resolved.resolvedYear));
    }

    const table = await tableForYearOrBundle(docYear, bundle?.taxYear ?? 2025);
    const children = docs
      .filter((d) => d.parentDocumentId === doc.id && d.formType)
      .map((d) => ({ formType: d.formType!, fields: resolvedByDoc.get(d.id) ?? new Map() }));

    const ctx: CheckContext = {
      formType: doc.formType,
      taxYear: docYear,
      toleranceCents: env.RECONCILE_TOLERANCE_CENTS,
      table,
      fields: resolvedByDoc.get(doc.id) ?? new Map(),
      children,
      bundleTaxYear: bundle?.taxYear ?? null,
    };

    for (const result of runChecks(ctx, resolved.schema.checks)) {
      await record(doc.id, result);
    }
  }

  // ── bundle-level checks ────────────────────────────────────────────────────
  const bundleTaxYear = bundle?.taxYear ?? 2025;
  const w2Docs = docs.filter((d) => d.formType === 'W-2' && d.extractionOutcome === 'extracted');
  const groups = new Map<string, BundleCheckContext['w2sByTaxpayer'][number]>();

  for (const doc of w2Docs) {
    const fields = resolvedByDoc.get(doc.id) ?? new Map();
    const key = doc.taxpayerId ?? 'unassigned';
    const group = groups.get(key) ?? {
      taxpayerId: doc.taxpayerId,
      taxpayerLabel: doc.taxpayerId ? `Taxpayer …${doc.taxpayerId.slice(-4)}` : 'Unassigned W-2s',
      w2s: [],
    };
    group.w2s.push({
      documentId: doc.id,
      employer: fields.get('employer_name')?.text ?? doc.payerName,
      box3: fields.get('box_3')?.cents ?? null,
      box4: fields.get('box_4')?.cents ?? null,
    });
    groups.set(key, group);
  }

  if (groups.size > 0) {
    const results = excessSocialSecurityWithheld({
      taxYear: bundleTaxYear,
      toleranceCents: env.RECONCILE_TOLERANCE_CENTS,
      table: await taxTableFor(bundleTaxYear),
      w2sByTaxpayer: [...groups.values()],
    });
    for (const result of results) await record(null, result);
  }

  await db
    .update(bundles)
    .set({
      status:
        hardFailures > 0
          ? 'blocked'
          : bundle?.identityConfirmedAt
            ? 'in_review'
            : 'awaiting_identity_confirmation',
      updatedAt: new Date(),
    })
    .where(eq(bundles.id, bundleId));

  return { hardFailures, softFailures };
}

/**
 * A document's own year's table, or the bundle's when none is registered for that year.
 *
 * A stray prior-year document (§7) must be checked, not crash the bundle's reconcile. The
 * substitution is logged; the document already carries `schema_year_substituted` or
 * `tax_year_matches_bundle` so the reviewer knows it is off-year.
 */
async function tableForYearOrBundle(year: number, bundleYear: number) {
  try {
    return await taxTableFor(year);
  } catch (err) {
    if (year === bundleYear) throw err;
    console.warn(`[reconcile] no tax table for ${year}; using the bundle year ${bundleYear} table`);
    return taxTableFor(bundleYear);
  }
}

// ── stage completion and hand-off ────────────────────────────────────────────

/** True once every rasterized page in the bundle has recorded a layout outcome. */
export async function layoutComplete(bundleId: string): Promise<boolean> {
  const [row] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(eq(pages.bundleId, bundleId), isNotNull(pages.rasterStorageKey), isNull(pages.layoutCompletedAt)));
  return (row?.remaining ?? 0) === 0;
}

/** True once every document in the bundle has recorded an extraction outcome. */
export async function extractionComplete(bundleId: string): Promise<boolean> {
  const [row] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(eq(documents.bundleId, bundleId), isNull(documents.extractionCompletedAt)));
  return (row?.remaining ?? 0) === 0;
}

/** Fan out one layout job per page that still needs one. Runs straight after classification. */
export async function startExtraction(bundleId: string, userId: string): Promise<number> {
  await db
    .update(bundles)
    .set({ status: 'extracting', extractionFanoutAt: null, reconcileFanoutAt: null })
    .where(eq(bundles.id, bundleId));

  const pending = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.bundleId, bundleId), isNotNull(pages.rasterStorageKey), isNull(pages.layoutCompletedAt)));

  for (const page of pending) {
    await pipelineQueue.add('layout_page', { kind: 'layout_page', bundleId, pageId: page.id, userId });
  }

  // Every page may already be laid out (an all-native bundle). Nobody else would advance it.
  if (!pending.length) await advanceAfterLayout(bundleId, userId);
  return pending.length;
}

export type Advance = 'waiting' | 'fanned_out' | 'already';

/**
 * Called after each layout job. The last page to finish fans out the binding stage —
 * exactly once. The claim is one conditional UPDATE, so concurrent layout jobs that all see
 * "complete" cannot each fan out (0008).
 */
export async function advanceAfterLayout(bundleId: string, userId: string): Promise<Advance> {
  if (!(await layoutComplete(bundleId))) return 'waiting';
  const claimed = await db
    .update(bundles)
    .set({ extractionFanoutAt: new Date() })
    .where(and(eq(bundles.id, bundleId), isNull(bundles.extractionFanoutAt)))
    .returning({ id: bundles.id });
  if (!claimed.length) return 'already';
  await queueExtractionForDocuments(bundleId, userId);
  return 'fanned_out';
}

/** Called after each extraction job. The last document to finish queues reconcile, once. */
export async function advanceAfterExtraction(bundleId: string, userId: string): Promise<Advance> {
  if (!(await extractionComplete(bundleId))) return 'waiting';
  const claimed = await db
    .update(bundles)
    .set({ reconcileFanoutAt: new Date() })
    .where(and(eq(bundles.id, bundleId), isNull(bundles.reconcileFanoutAt)))
    .returning({ id: bundles.id });
  if (!claimed.length) return 'already';
  await pipelineQueue.add('reconcile_bundle', { kind: 'reconcile_bundle', bundleId, userId });
  return 'fanned_out';
}

/**
 * Re-extract only the document a page belongs to. Used when a page is laid out *after* the
 * bundle already fanned extraction out — a requeued layout page — so the one affected
 * document is re-bound rather than the whole bundle.
 */
export async function queueExtractionForPage(bundleId: string, pageId: string, userId: string): Promise<boolean> {
  const [page] = await db.select({ documentId: pages.documentId }).from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page?.documentId) return false;
  await db
    .update(documents)
    .set({ extractionOutcome: null, extractionCompletedAt: null })
    .where(eq(documents.id, page.documentId));
  await db.update(bundles).set({ reconcileFanoutAt: null }).where(eq(bundles.id, bundleId));
  await pipelineQueue.add('extract_document', { kind: 'extract_document', bundleId, documentId: page.documentId, userId });
  return true;
}

/** Queue one binding job per document. A re-run clears every outcome first. */
export async function queueExtractionForDocuments(bundleId: string, userId: string): Promise<number> {
  await db
    .update(documents)
    .set({ extractionOutcome: null, extractionCompletedAt: null })
    .where(eq(documents.bundleId, bundleId));
  await db.update(bundles).set({ reconcileFanoutAt: null }).where(eq(bundles.id, bundleId));

  const all = await db.select({ id: documents.id }).from(documents).where(eq(documents.bundleId, bundleId));

  for (const doc of all) {
    await pipelineQueue.add('extract_document', {
      kind: 'extract_document',
      bundleId,
      documentId: doc.id,
      userId,
    });
  }

  // A bundle with no documents at all still needs a reconcile to reach a terminal status.
  if (!all.length) await advanceAfterExtraction(bundleId, userId);
  return all.length;
}

// ── requeue parked and failed router work ────────────────────────────────────

/**
 * Send every parked or failed router job for a bundle back to the queue.
 *
 * Until this existed, "re-queue" was a word in the runbook with nothing behind it: a parked
 * layout page kept the bundle at `extracting` forever, and the only way out was a full
 * reprocess. Each job is re-created at the stage it failed in, and the recorded row is
 * marked `requeued` so the history of the failure is kept.
 */
export async function requeueRouterJobs(
  bundleId: string,
  userId: string,
): Promise<{ requeued: number; classify: boolean; pages: number; documents: number }> {
  const rows = await db
    .select()
    .from(routerJobs)
    .where(and(eq(routerJobs.bundleId, bundleId), inArray(routerJobs.state, ['parked', 'failed'])));

  if (!rows.length) return { requeued: 0, classify: false, pages: 0, documents: 0 };

  let classify = false;
  const pageIds = new Set<string>();
  const documentIds = new Set<string>();

  for (const row of rows) {
    if (row.taskClass === TASK_CLASS.PAGE_CLASSIFY) classify = true;
    else if ((row.taskClass === TASK_CLASS.LAYOUT || row.taskClass === TASK_CLASS.OCR_TRANSCRIBE) && row.pageId) {
      pageIds.add(row.pageId);
    } else if (row.taskClass === TASK_CLASS.FIELD_EXTRACT && row.documentId) documentIds.add(row.documentId);
  }

  await db
    .update(routerJobs)
    .set({ state: 'requeued', updatedAt: new Date() })
    .where(inArray(routerJobs.id, rows.map((r) => r.id)));

  if (classify) {
    // Classification runs as one job over the whole bundle and re-derives everything after it.
    await pipelineQueue.add('classify_bundle', { kind: 'classify_bundle', bundleId, userId });
    return { requeued: rows.length, classify, pages: 0, documents: 0 };
  }

  await db
    .update(bundles)
    .set({ status: 'extracting', reconcileFanoutAt: null, updatedAt: new Date() })
    .where(eq(bundles.id, bundleId));
  for (const documentId of documentIds) {
    await db
      .update(documents)
      .set({ extractionOutcome: null, extractionCompletedAt: null })
      .where(eq(documents.id, documentId));
  }
  for (const pageId of pageIds) {
    await pipelineQueue.add('layout_page', { kind: 'layout_page', bundleId, pageId, userId });
  }
  for (const documentId of documentIds) {
    await pipelineQueue.add('extract_document', { kind: 'extract_document', bundleId, documentId, userId });
  }
  return { requeued: rows.length, classify, pages: pageIds.size, documents: documentIds.size };
}
