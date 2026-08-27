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
import { pages, purgeLog, sourceFiles } from '../db/schema.ts';
import { blobs } from '../storage/index.ts';

export interface PurgeSummary {
  rastersPurged: number;
  sourcesPurged: number;
  dryRun: boolean;
  errors: { key: string; message: string }[];
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

export async function runRetention(): Promise<PurgeSummary> {
  const dryRun = env.RETENTION_DRY_RUN;
  const errors: PurgeSummary['errors'] = [];

  // ── rasters ────────────────────────────────────────────────────────────────
  const rasterCutoff = daysAgo(env.RETENTION_RASTER_DAYS);
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
        policyDays: env.RETENTION_RASTER_DAYS,
        ageDays,
        storageKey: page.key,
        dryRun,
      });
      rastersPurged += 1;
    } catch (err) {
      errors.push({ key: page.key!, message: (err as Error).message });
    }
  }

  // ── source documents ───────────────────────────────────────────────────────
  const sourceCutoff = daysAgo(env.RETENTION_DOCUMENT_DAYS);
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
        policyDays: env.RETENTION_DOCUMENT_DAYS,
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
      dryRun,
      rasterPolicyDays: env.RETENTION_RASTER_DAYS,
      documentPolicyDays: env.RETENTION_DOCUMENT_DAYS,
      errors: errors.length,
    },
  });

  return { rastersPurged, sourcesPurged, dryRun, errors };
}

/** Operator-facing view of what the next run would do. */
export async function retentionForecast(): Promise<{ rastersDue: number; sourcesDue: number }> {
  const [rasters] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pages)
    .where(
      and(
        isNotNull(pages.rasterStorageKey),
        isNull(pages.rasterPurgedAt),
        lt(pages.createdAt, daysAgo(env.RETENTION_RASTER_DAYS)),
      ),
    );
  const [sources] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sourceFiles)
    .where(and(isNull(sourceFiles.purgedAt), lt(sourceFiles.createdAt, daysAgo(env.RETENTION_DOCUMENT_DAYS))));

  return { rastersDue: rasters?.n ?? 0, sourcesDue: sources?.n ?? 0 };
}
