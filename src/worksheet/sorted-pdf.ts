/**
 * The bookmarked, return-ordered PDF of a bundle's source pages (added 2026-09-16).
 *
 * A preparer wants the packet the way the return is laid out — wages first, then interest,
 * dividends, retirement, and on down — with a bookmark per document naming the form and the
 * issuer. The sidecar assembles it from the stored source files (PyMuPDF `insert_pdf` keeps
 * each page's own text layer intact), sets the outline, and writes it to the blob store. This
 * side decides the order and the names; it never touches PDF bytes.
 *
 * The result is derived taxpayer data made of the source pages themselves. It is recorded on
 * the bundle and purged with the rasters (§11); it can be rebuilt while the sources exist.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { bundles, documents, pages, sourceFiles } from '../db/schema.ts';
import { keys } from '../storage/index.ts';
import { rasterEvents, rasterQueue, type AssembleJob, type AssembleResult } from '../queue/queues.ts';
import { loadFormOrder, placementOf, sortDocuments } from './form-order.ts';

export interface SortedPdfSummary {
  storageKey: string;
  pageCount: number;
  bookmarks: number;
}

/** Bookmark text for one document. */
export function bookmarkTitle(doc: {
  formType: string | null;
  payerName: string | null;
  sectionCode: string | null;
  corrected: boolean;
  void: boolean;
  isSupplemental: boolean;
  unrecognisedForm: boolean;
}): string {
  if (!doc.formType) {
    return doc.unrecognisedForm ? 'Unrecognised tax document' : doc.isSupplemental ? 'Other page' : 'Unclassified page';
  }
  const parts = [doc.formType];
  if (doc.sectionCode) parts.push(`section ${doc.sectionCode}`);
  if (doc.payerName) parts.push(doc.payerName);
  if (doc.corrected) parts.push('[CORRECTED]');
  if (doc.void) parts.push('[VOID]');
  return parts.join(' — ');
}

/** Sections in return order, each with its documents and their source pages. */
export async function planSortedPdf(bundleId: string): Promise<AssembleJob['sections']> {
  const order = loadFormOrder();
  const docs = sortDocuments(await db.select().from(documents).where(eq(documents.bundleId, bundleId)), order);
  const pageRows = await db
    .select({
      documentId: pages.documentId,
      pageNumber: pages.pageNumber,
      storageKey: sourceFiles.storageKey,
      mediaType: sourceFiles.mediaType,
      purgedAt: sourceFiles.purgedAt,
      filename: sourceFiles.filename,
    })
    .from(pages)
    .innerJoin(sourceFiles, eq(sourceFiles.id, pages.sourceFileId))
    .where(eq(pages.bundleId, bundleId))
    .orderBy(asc(sourceFiles.filename), asc(pages.pageNumber));

  const sections: AssembleJob['sections'] = [];
  for (const doc of docs) {
    const placement = placementOf(doc, order);
    const group = order.groups[placement.groupIndex];
    const label = group ? (group.line ? `${group.label} — ${group.line}` : group.label) : placement.groupLabel;
    let section = sections[sections.length - 1];
    if (!section || section.label !== label) {
      section = { label, entries: [] };
      sections.push(section);
    }
    const docPages = pageRows
      .filter((p) => p.documentId === doc.id && !p.purgedAt)
      .map((p) => ({ storageKey: p.storageKey, mediaType: p.mediaType, pageNumber: p.pageNumber }));
    if (!docPages.length) continue;
    section.entries.push({ title: bookmarkTitle(doc), pages: docPages });
  }

  // Pages nobody classified into a document still belong to the client; keep them at the end.
  const orphaned = pageRows.filter((p) => p.documentId === null && !p.purgedAt);
  if (orphaned.length) {
    sections.push({
      label: 'Other pages',
      entries: [{ title: 'Pages not assigned to a document', pages: orphaned.map((p) => ({ storageKey: p.storageKey, mediaType: p.mediaType, pageNumber: p.pageNumber })) }],
    });
  }
  return sections.filter((s) => s.entries.length);
}

/** Ask the sidecar to assemble the PDF, wait for it, and record the key on the bundle. */
export async function buildSortedPdf(bundleId: string, userId?: string): Promise<SortedPdfSummary> {
  const sections = await planSortedPdf(bundleId);
  if (!sections.length) throw new Error('nothing to assemble: no source pages remain for this bundle');

  const outputKey = keys.sortedPdf(bundleId);
  const job = await rasterQueue.add('assemble', {
    kind: 'assemble',
    bundleId,
    outputKey,
    sections,
    ...(userId ? { userId } : {}),
  });
  const result = (await job.waitUntilFinished(rasterEvents, 180_000)) as AssembleResult;

  await db
    .update(bundles)
    .set({ sortedPdfStorageKey: outputKey, sortedPdfAt: new Date(), updatedAt: new Date() })
    .where(eq(bundles.id, bundleId));

  return { storageKey: outputKey, pageCount: result.pageCount, bookmarks: sections.reduce((n, s) => n + s.entries.length, 0) };
}
