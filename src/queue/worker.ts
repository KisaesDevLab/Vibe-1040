/**
 * Pipeline worker entrypoint.
 *
 * Runs as its own container so a long extraction never blocks the review UI, and so the
 * queue depth is the thing an operator watches during filing season.
 */
import { Worker } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.ts';
import { sourceFiles, users } from '../db/schema.ts';
import {
  advanceAfterExtraction,
  advanceAfterLayout,
  classifyBundle,
  extractDocument,
  layoutPage,
  queueExtractionForPage,
  reconcileBundle,
  recordRasterOutput,
} from './pipeline.ts';
import {
  QUEUE_NAMES,
  closeQueues,
  connection,
  pipelineQueue,
  rasterEvents,
  rasterQueue,
  type PageMetadata,
  type PipelineJob,
} from './queues.ts';

const log = (msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
};

/**
 * True once every source file in the bundle has had its pages recorded. Rasterization fans
 * out one job per file, so the last one to finish is what advances the bundle.
 */
async function rasterComplete(bundleId: string): Promise<boolean> {
  const [row] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(sourceFiles)
    .where(and(eq(sourceFiles.bundleId, bundleId), isNull(sourceFiles.pageCount)));
  return (row?.pending ?? 0) === 0;
}

/** Fallback actor when a job carries no user — the raster queue is machine-driven. */
async function systemUserId(): Promise<string> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  if (!row) throw new Error('no users exist; run db:seed');
  return row.id;
}

const worker = new Worker<PipelineJob>(
  QUEUE_NAMES.PIPELINE,
  async (job) => {
    const data = job.data;
    log('job.start', { kind: data.kind, id: job.id });

    switch (data.kind) {
      case 'classify_bundle':
        await classifyBundle(data.bundleId, data.userId);
        return;

      case 'layout_page': {
        await layoutPage(data.bundleId, data.pageId, data.userId);
        // The last page to record a layout outcome fans out the binding stage, once (0007,
        // 0008). A page laid out after that — a requeue — re-binds only its own document.
        const advance = await advanceAfterLayout(data.bundleId, data.userId);
        if (advance === 'fanned_out') log('layout.complete', { bundleId: data.bundleId });
        if (advance === 'already' && (await queueExtractionForPage(data.bundleId, data.pageId, data.userId))) {
          log('layout.requeued_page', { bundleId: data.bundleId, pageId: data.pageId });
        }
        return;
      }

      case 'extract_document': {
        await extractDocument(data.bundleId, data.documentId, data.userId);
        // The last document to record an outcome queues reconcile, once (0007, 0008).
        if ((await advanceAfterExtraction(data.bundleId, data.userId)) === 'fanned_out') {
          log('extraction.complete', { bundleId: data.bundleId });
        }
        return;
      }

      case 'reconcile_bundle': {
        const summary = await reconcileBundle(data.bundleId);
        log('reconcile.complete', { bundleId: data.bundleId, ...summary });
        return;
      }
    }
  },
  { connection, concurrency: 4 },
);

/**
 * The language boundary (§12).
 *
 * The Python sidecar consumes `v1040.raster` and returns page metadata as its job result.
 * Something on this side has to pick that up and write the `pages` rows — without this
 * listener the sidecar rasterizes happily, stores the images, and the bundle then sits in
 * `triaging` forever with no pages recorded.
 */
rasterEvents.on('completed', ({ jobId, returnvalue }) => {
  void (async () => {
    try {
      const job = await rasterQueue.getJob(jobId);
      if (!job) return;
      const result =
        typeof returnvalue === 'string'
          ? (JSON.parse(returnvalue) as { kind?: string; sourceFileId: string; pages: PageMetadata[] })
          : (returnvalue as unknown as { kind?: string; sourceFileId: string; pages: PageMetadata[] });
      // The sidecar also assembles sorted PDFs on this queue; those results carry no pages.
      if (result?.kind === 'assemble' || !result?.pages) return;

      await recordRasterOutput(job.data.bundleId, result.sourceFileId, result.pages);
      log('raster.recorded', {
        bundleId: job.data.bundleId,
        sourceFileId: result.sourceFileId,
        pages: result.pages.length,
      });

      if (await rasterComplete(job.data.bundleId)) {
        await pipelineQueue.add('classify_bundle', {
          kind: 'classify_bundle',
          bundleId: job.data.bundleId,
          userId: job.data.userId ?? (await systemUserId()),
        });
        log('raster.complete', { bundleId: job.data.bundleId });
      }
    } catch (err) {
      log('raster.record_failed', { jobId, error: (err as Error).message });
    }
  })();
});

worker.on('failed', (job, err) => {
  log('job.failed', { id: job?.id, kind: job?.data.kind, error: err.message });
});
worker.on('completed', (job) => {
  log('job.completed', { id: job.id, kind: job.data.kind });
});

log('worker.listening', { queue: QUEUE_NAMES.PIPELINE });

const shutdown = async (): Promise<void> => {
  log('worker.shutdown');
  await worker.close();
  await closeQueues();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
