/**
 * Deleting a bundle outright (§11).
 *
 * Separate from the retention job because the trigger is different — a person decided, rather
 * than a policy matured — but the disposal mechanics are deliberately the same. Every blob is
 * removed from object storage and every removal is written to `purge_log`, so a bundle that a
 * reviewer deleted and a bundle that aged out leave the same evidence. GLBA asks for a
 * documented disposal schedule with an enforcing job; it also asks that disposal be recorded,
 * and an ad-hoc delete that skipped the log would be a hole in exactly that record.
 *
 * Blobs first, rows second. A crash between the two leaves orphaned rows pointing at storage
 * that is already gone, which is visible and fixable. The reverse leaves taxpayer documents on
 * disk with nothing referencing them, which is neither.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { bundles, pages, purgeLog, sourceFiles, worksheets } from '../db/schema.ts';
import { blobs } from '../storage/index.ts';

export interface DeleteSummary {
  bundleId: string;
  label: string;
  blobsDeleted: number;
  errors: { key: string; message: string }[];
}

/**
 * `purge_log` records what was disposed of, not who asked. The audit log is the authority on
 * the actor, and the route writes a `bundle.delete` entry naming the user before calling this.
 */
export async function deleteBundle(bundleId: string): Promise<DeleteSummary> {
  const [bundle] = await db.select().from(bundles).where(eq(bundles.id, bundleId)).limit(1);
  if (!bundle) throw new Error(`bundle ${bundleId} not found`);

  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - bundle.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
  );

  const targets: { key: string; entityType: string; entityId: string; kind: string }[] = [];

  for (const file of await db.select().from(sourceFiles).where(eq(sourceFiles.bundleId, bundleId))) {
    targets.push({ key: file.storageKey, entityType: 'source_file', entityId: file.id, kind: 'source_document' });
  }
  for (const page of await db.select().from(pages).where(eq(pages.bundleId, bundleId))) {
    if (page.rasterStorageKey) {
      targets.push({ key: page.rasterStorageKey, entityType: 'page', entityId: page.id, kind: 'raster' });
    }
  }
  if (bundle.sortedPdfStorageKey) {
    targets.push({ key: bundle.sortedPdfStorageKey, entityType: 'bundle', entityId: bundleId, kind: 'sorted_pdf' });
  }
  for (const sheet of await db.select().from(worksheets).where(eq(worksheets.bundleId, bundleId))) {
    for (const key of [sheet.xlsxStorageKey, sheet.pdfStorageKey]) {
      if (key) targets.push({ key, entityType: 'worksheet', entityId: sheet.id, kind: 'worksheet' });
    }
  }

  const errors: { key: string; message: string }[] = [];
  let blobsDeleted = 0;

  for (const target of targets) {
    try {
      await blobs.delete(target.key);
      blobsDeleted += 1;
    } catch (err) {
      // Record and continue. A key already gone is the common case on a retry, and refusing
      // to finish would leave the bundle half-deleted forever.
      errors.push({ key: target.key, message: (err as Error).message });
    }
    await db.insert(purgeLog).values({
      kind: target.kind,
      entityType: target.entityType,
      entityId: target.entityId,
      bundleId,
      // Not policy-driven: a person asked. Zero says "no policy window applied" rather than
      // implying this aged out.
      policyDays: 0,
      ageDays,
      storageKey: target.key,
      dryRun: false,
    });
  }

  // Rows last. Every child table cascades from the bundle.
  await db.delete(bundles).where(eq(bundles.id, bundleId));

  return { bundleId, label: bundle.label, blobsDeleted, errors };
}
