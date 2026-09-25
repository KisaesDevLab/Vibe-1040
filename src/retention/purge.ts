/**
 * Retention and disposal (P13, §11).
 *
 * Two schedules, deliberately independent:
 *  - **Rasterized page images** are derived PII. They purge first and on their own clock,
 *    because they are the largest and most sensitive derivative and nothing downstream
 *    needs them once review is done.
 *  - **Source documents** follow the workpaper schedule.
 *
 * Nothing purges without a policy match, and every disposal is audited — that audit trail
 * is what substantiates the "documented retention and disposal schedule" obligation.
 */
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { audit } from '../audit/log.ts';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import {
  bundles,
  draftInputActivities,
  draftInputDependents,
  draftInputScheduleA,
  draftInputs,
  draftReturns,
  pages,
  purgeLog,
  sourceFiles,
} from '../db/schema.ts';
import { setting } from '../settings/store.ts';
import { blobs } from '../storage/index.ts';

export interface PurgeSummary {
  rastersPurged: number;
  sourcesPurged: number;
  /** Preparer-supplied draft inputs (P18). On the document schedule — they are not derived. */
  inputsPurged: number;
  dryRun: boolean;
  errors: { key: string; message: string }[];
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

export async function runRetention(): Promise<PurgeSummary> {
  // Retention policy is firm policy: edited in the admin UI, seeded from the environment.
  const dryRun = await setting<boolean>('retention.dry_run');
  const rasterDays = await setting<number>('retention.raster_days');
  const documentDays = await setting<number>('retention.document_days');
  const errors: PurgeSummary['errors'] = [];

  // ── rasters ────────────────────────────────────────────────────────────────
  const rasterCutoff = daysAgo(rasterDays);
  const staleRasters = await db
    .select({
      id: pages.id,
      bundleId: pages.bundleId,
      key: pages.rasterStorageKey,
      createdAt: pages.createdAt,
    })
    .from(pages)
    .where(
      and(
        isNotNull(pages.rasterStorageKey),
        isNull(pages.rasterPurgedAt),
        lt(pages.createdAt, rasterCutoff),
      ),
    );

  let rastersPurged = 0;

  // The return-ordered PDF is source pages re-bound; it goes on the raster schedule (§11).
  const staleSorted = await db
    .select({ id: bundles.id, key: bundles.sortedPdfStorageKey, at: bundles.sortedPdfAt })
    .from(bundles)
    .where(and(isNotNull(bundles.sortedPdfStorageKey), lt(bundles.sortedPdfAt, rasterCutoff)));
  for (const bundle of staleSorted) {
    const ageDays = Math.floor((Date.now() - (bundle.at?.getTime() ?? Date.now())) / 86_400_000);
    try {
      if (!dryRun) {
        await blobs.delete(bundle.key!);
        await db.update(bundles).set({ sortedPdfStorageKey: null, sortedPdfAt: null }).where(eq(bundles.id, bundle.id));
      }
      await db.insert(purgeLog).values({
        kind: 'sorted_pdf',
        entityType: 'bundle',
        entityId: bundle.id,
        bundleId: bundle.id,
        policyDays: rasterDays,
        ageDays,
        storageKey: bundle.key,
        dryRun,
      });
      rastersPurged += 1;
    } catch (err) {
      errors.push({ key: bundle.key!, message: (err as Error).message });
    }
  }

  // A draft return holds computed taxpayer amounts and no blob — it is derived data that is
  // regenerable while the documents live, so it goes on the raster schedule too (§11, §14).
  // Its lines, omissions and diagnostics cascade with the row.
  const staleDrafts = await db
    .select({ id: draftReturns.id, bundleId: draftReturns.bundleId, at: draftReturns.createdAt })
    .from(draftReturns)
    .where(lt(draftReturns.createdAt, rasterCutoff));
  for (const draft of staleDrafts) {
    const ageDays = Math.floor((Date.now() - draft.at.getTime()) / 86_400_000);
    try {
      if (!dryRun) await db.delete(draftReturns).where(eq(draftReturns.id, draft.id));
      await db.insert(purgeLog).values({
        kind: 'draft_return',
        entityType: 'draft_return',
        entityId: draft.id,
        bundleId: draft.bundleId,
        policyDays: rasterDays,
        ageDays,
        storageKey: null,
        dryRun,
      });
      rastersPurged += 1;
    } catch (err) {
      errors.push({ key: `draft_return:${draft.id}`, message: (err as Error).message });
    }
  }

  for (const page of staleRasters) {
    const ageDays = Math.floor((Date.now() - page.createdAt.getTime()) / 86_400_000);
    try {
      if (!dryRun) {
        await blobs.delete(page.key!);
        await db
          .update(pages)
          .set({ rasterPurgedAt: new Date(), rasterStorageKey: null })
          .where(eq(pages.id, page.id));
      }
      await db.insert(purgeLog).values({
        kind: 'raster',
        entityType: 'page',
        entityId: page.id,
        bundleId: page.bundleId,
        policyDays: rasterDays,
        ageDays,
        storageKey: page.key,
        dryRun,
      });
      rastersPurged += 1;
    } catch (err) {
      errors.push({ key: page.key!, message: (err as Error).message });
    }
  }

  /**
   * Preparer-supplied draft inputs (P18) go on the **document** schedule, not the raster one.
   *
   * The distinction matters and is the reason this is its own block. A draft return is derived:
   * it can be recomputed from the documents, so purging it at 90 days costs nothing but a
   * recompute. These were **typed by a person** and cannot be regenerated from anything — a
   * preparer's Schedule C summary, a list of dependents. Putting them on the raster schedule
   * would quietly delete somebody's work while the bundle they belong to is still open.
   *
   * They are still taxpayer data (names, dates of birth) and must not outlive the sources they
   * were entered against, so they go when the source documents do. They also cascade with the
   * bundle, which is what covers an ad-hoc delete.
   */
  const inputCutoff = daysAgo(documentDays);
  let inputsPurged = 0;
  const staleInputs = await db
    .select({ id: draftInputs.id, bundleId: draftInputs.bundleId, at: draftInputs.createdAt })
    .from(draftInputs)
    .where(lt(draftInputs.createdAt, inputCutoff));
  for (const row of staleInputs) {
    const ageDays = Math.floor((Date.now() - row.at.getTime()) / 86_400_000);
    try {
      if (!dryRun) {
        // Siblings do not cascade off `draft_inputs` — they hang off the bundle — so each is
        // deleted explicitly. Missing one would leave a dependent's name behind.
        await db.delete(draftInputDependents).where(eq(draftInputDependents.bundleId, row.bundleId));
        await db.delete(draftInputScheduleA).where(eq(draftInputScheduleA.bundleId, row.bundleId));
        await db.delete(draftInputActivities).where(eq(draftInputActivities.bundleId, row.bundleId));
        await db.delete(draftInputs).where(eq(draftInputs.id, row.id));
      }
      await db.insert(purgeLog).values({
        kind: 'draft_input',
        entityType: 'draft_input',
        entityId: row.id,
        bundleId: row.bundleId,
        policyDays: documentDays,
        ageDays,
        storageKey: null,
        dryRun,
      });
      inputsPurged += 1;
    } catch (err) {
      errors.push({ key: `draft_input:${row.id}`, message: (err as Error).message });
    }
  }

  // ── source documents ───────────────────────────────────────────────────────
  const sourceCutoff = daysAgo(documentDays);
  const staleSources = await db
    .select({
      id: sourceFiles.id,
      bundleId: sourceFiles.bundleId,
      key: sourceFiles.storageKey,
      createdAt: sourceFiles.createdAt,
    })
    .from(sourceFiles)
    .where(and(isNull(sourceFiles.purgedAt), lt(sourceFiles.createdAt, sourceCutoff)));

  let sourcesPurged = 0;
  for (const file of staleSources) {
    const ageDays = Math.floor((Date.now() - file.createdAt.getTime()) / 86_400_000);
    try {
      if (!dryRun) {
        await blobs.delete(file.key);
        await db.update(sourceFiles).set({ purgedAt: new Date() }).where(eq(sourceFiles.id, file.id));
      }
      await db.insert(purgeLog).values({
        kind: 'source_document',
        entityType: 'source_file',
        entityId: file.id,
        bundleId: file.bundleId,
        policyDays: documentDays,
        ageDays,
        storageKey: file.key,
        dryRun,
      });
      sourcesPurged += 1;
    } catch (err) {
      errors.push({ key: file.key, message: (err as Error).message });
    }
  }

  await audit({
    action: 'retention.purge',
    detail: {
      rastersPurged,
      sourcesPurged,
      inputsPurged,
      dryRun,
      rasterPolicyDays: rasterDays,
      documentPolicyDays: documentDays,
      errors: errors.length,
    },
  });

  return { rastersPurged, sourcesPurged, inputsPurged, dryRun, errors };
}

/** Operator-facing view of what the next run would do. */
export async function retentionForecast(): Promise<{ rastersDue: number; sourcesDue: number }> {
  const rasterDays = await setting<number>('retention.raster_days');
  const documentDays = await setting<number>('retention.document_days');
  const [rasters] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pages)
    .where(
      and(
        isNotNull(pages.rasterStorageKey),
        isNull(pages.rasterPurgedAt),
        lt(pages.createdAt, daysAgo(rasterDays)),
      ),
    );
  const [sources] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sourceFiles)
    .where(and(isNull(sourceFiles.purgedAt), lt(sourceFiles.createdAt, daysAgo(documentDays))));

  return { rastersDue: rasters?.n ?? 0, sourcesDue: sources?.n ?? 0 };
}
