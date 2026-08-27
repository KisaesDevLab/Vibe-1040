/**
 * Bundle pipeline (P2 → P9).
 *
 * The stages are separate jobs rather than one long function so that a router outage parks
 * a page rather than failing a bundle (§3), and so a bundle can resume from where it
 * stopped after the router comes back.
 *
 * Order: rasterize → classify + split → propose identity → **human confirmation gate** →
 * layout → bind fields → reconcile.
 */
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { bundles, checkResults, documents, layoutSpans, pages, routerJobs, sourceFiles } from '../db/schema.ts';
import { classifyPage, groupPages, majorityTaxYear, type PageClassification } from '../classify/pass.ts';
import { env } from '../config/env.ts';
import { bindFields, type StoredSpan } from '../extract/binder.ts';
import { persistBoundFields } from '../extract/persist.ts';
import { resolveDocumentFields } from '../extract/resolve.ts';
import { proposeIdentity, saveProposal, type TinObservation } from '../identity/resolve.ts';
import { runLayoutPass } from '../layout/pass.ts';
import { runChecks, type CheckContext, type FieldValue } from '../reconcile/checks.ts';
import { taxTableFor } from '../reconcile/tax-tables.ts';
import { RouterCallError } from '../router/client.ts';
import { registry } from '../schemas/registry.ts';
import { blobs } from '../storage/index.ts';
import { pipelineQueue, type PageMetadata } from './queues.ts';

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
    lastErrorMessage: err.failure.message,
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
  await db.insert(pages).values(
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
  );
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

  const pageRows = await db
    .select({ id: pages.id, key: pages.rasterStorageKey })
    .from(pages)
    .where(and(eq(pages.bundleId, bundleId), isNotNull(pages.rasterStorageKey)))
    .orderBy(asc(pages.sourceFileId), asc(pages.pageNumber));

  const classifications: PageClassification[] = [];
  let previousFormType: string | null = null;

  for (const page of pageRows) {
    try {
      const image = await blobs.get(page.key!);
      const result = await classifyPage(page.id, image, knownTypes, {
        bundleId,
        userId,
        previousFormType,
      });
      classifications.push(result);
      previousFormType = result.form_type;
    } catch (err) {
      if (err instanceof RouterCallError) {
        await parkJob('v1040_page_classify', { bundleId, pageId: page.id }, err);
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
        payerName: group.payerName,
        classifierConfidence: group.confidence,
        status: 'classified',
      })
      .returning({ id: documents.id });

    createdIds.push(doc!.id);
    for (const pageId of group.pageIds) {
      await db.update(pages).set({ documentId: doc!.id }).where(eq(pages.id, pageId));
    }
  }

  // Identity is proposed from whatever the layout pass later confirms; at this stage we
  // only have page-level hints, so the proposal is refined after extraction. Tax year is
  // available now and is what the reviewer confirms against.
  await db
    .update(bundles)
    .set({ taxYear: bundleYear, status: 'awaiting_identity_confirmation' })
    .where(eq(bundles.id, bundleId));
}

// ── P7 → layout ──────────────────────────────────────────────────────────────

export async function layoutPage(bundleId: string, pageId: string, userId: string): Promise<void> {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page?.rasterStorageKey) return;

  const existing = await db
    .select({ id: layoutSpans.id })
    .from(layoutSpans)
    .where(eq(layoutSpans.pageId, pageId))
    .limit(1);
  // Spans are immutable once written (§4); re-running must not duplicate them.
  if (existing.length) return;

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
      await parkJob('v1040_layout', { bundleId, pageId }, err);
      return;
    }
    throw err;
  }
}

// ── P8 → bind fields ─────────────────────────────────────────────────────────

export async function extractDocument(
  bundleId: string,
  documentId: string,
  userId: string,
): Promise<void> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc?.formType || doc.isSupplemental) return;

  const forms = await registry();
  const resolved = forms.resolve(doc.formType, doc.taxYear ?? 2025);
  if (!resolved) return;

  const spanRows = await db
    .select({
      id: layoutSpans.id,
      spanIndex: layoutSpans.spanIndex,
      text: layoutSpans.text,
      pageId: layoutSpans.pageId,
    })
    .from(layoutSpans)
    .innerJoin(pages, eq(pages.id, layoutSpans.pageId))
    .where(eq(pages.documentId, documentId))
    .orderBy(asc(layoutSpans.pageId), asc(layoutSpans.spanIndex));

  if (!spanRows.length) return;

  // Span indices are per page; renumber across the document so the binder sees one list.
  const spans: StoredSpan[] = spanRows.map((s, i) => ({ ...s, spanIndex: i }));

  try {
    const bound = await bindFields(resolved.schema, spans, { bundleId, userId });
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

    await db
      .update(documents)
      .set({ status: 'extracted', formSchemaVersion: resolved.schema.version })
      .where(eq(documents.id, documentId));
  } catch (err) {
    if (err instanceof RouterCallError) {
      await parkJob('v1040_field_extract', { bundleId, documentId }, err);
      return;
    }
    throw err;
  }
}

// ── P9 → reconcile ───────────────────────────────────────────────────────────

export async function reconcileBundle(bundleId: string): Promise<{ hardFailures: number; softFailures: number }> {
  await db.update(bundles).set({ status: 'reconciling' }).where(eq(bundles.id, bundleId));

  const [bundle] = await db.select().from(bundles).where(eq(bundles.id, bundleId)).limit(1);
  const forms = await registry();
  const docs = await db.select().from(documents).where(eq(documents.bundleId, bundleId));

  // Clear prior results so a re-run after corrections does not accumulate stale failures.
  await db.delete(checkResults).where(eq(checkResults.bundleId, bundleId));

  let hardFailures = 0;
  let softFailures = 0;

  const resolvedByDoc = new Map<string, Map<string, FieldValue>>();
  for (const doc of docs) {
    resolvedByDoc.set(doc.id, (await resolveDocumentFields(doc.id)).fields);
  }

  for (const doc of docs) {
    if (!doc.formType || doc.isSupplemental) continue;
    const schema = forms.resolve(doc.formType, doc.taxYear ?? bundle?.taxYear ?? 2025)?.schema;
    if (!schema) continue;

    const table = await taxTableFor(doc.taxYear ?? bundle?.taxYear ?? 2025);
    const children = docs
      .filter((d) => d.parentDocumentId === doc.id && d.formType)
      .map((d) => ({ formType: d.formType!, fields: resolvedByDoc.get(d.id) ?? new Map() }));

    const ctx: CheckContext = {
      formType: doc.formType,
      taxYear: doc.taxYear ?? bundle?.taxYear ?? 2025,
      toleranceCents: env.RECONCILE_TOLERANCE_CENTS,
      table,
      fields: resolvedByDoc.get(doc.id) ?? new Map(),
      children,
      bundleTaxYear: bundle?.taxYear ?? null,
    };

    const results = runChecks(ctx, schema.checks);
    for (const result of results) {
      if (result.outcome === 'fail') {
        if (result.severity === 'hard') hardFailures += 1;
        else softFailures += 1;
      }
      await db.insert(checkResults).values({
        bundleId,
        documentId: doc.id,
        checkKey: result.checkKey,
        severity: result.severity,
        outcome: result.outcome,
        message: result.message,
        expectedCents: result.expectedCents ?? null,
        actualCents: result.actualCents ?? null,
        toleranceCents: result.toleranceCents ?? null,
        detail: result.detail ?? {},
      });
    }
  }

  await db
    .update(bundles)
    .set({ status: hardFailures > 0 ? 'blocked' : 'in_review', updatedAt: new Date() })
    .where(eq(bundles.id, bundleId));

  return { hardFailures, softFailures };
}

// ── fan-out helpers ──────────────────────────────────────────────────────────

/** Called after the reviewer confirms identity (§7). Nothing extracts before this. */
export async function startExtraction(bundleId: string, userId: string): Promise<number> {
  const pageRows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.bundleId, bundleId), isNotNull(pages.rasterStorageKey)));

  await db.update(bundles).set({ status: 'extracting' }).where(eq(bundles.id, bundleId));

  for (const page of pageRows) {
    await pipelineQueue.add('layout_page', { kind: 'layout_page', bundleId, pageId: page.id, userId });
  }
  return pageRows.length;
}

/** After every page has spans, fan out one binding job per document. */
export async function queueExtractionForDocuments(bundleId: string, userId: string): Promise<number> {
  const docs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.bundleId, bundleId), isNull(documents.parentDocumentId)));

  const all = await db.select({ id: documents.id }).from(documents).where(eq(documents.bundleId, bundleId));
  void docs;

  for (const doc of all) {
    await pipelineQueue.add('extract_document', {
      kind: 'extract_document',
      bundleId,
      documentId: doc.id,
      userId,
    });
  }
  return all.length;
}
