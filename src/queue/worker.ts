/**
 * Pipeline worker entrypoint.
 *
 * Runs as its own container so a long extraction never blocks the review UI, and so the
 * queue depth is the thing an operator watches during filing season.
 */
import { Worker } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.ts';
import { documents, layoutSpans, pages } from '../db/schema.ts';
import {
  classifyBundle,
  extractDocument,
  layoutPage,
  queueExtractionForDocuments,
  reconcileBundle,
} from './pipeline.ts';
import { QUEUE_NAMES, closeQueues, connection, pipelineQueue, type PipelineJob } from './queues.ts';

const log = (msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
};

/** True once every rasterized page in the bundle has spans. */
async function layoutComplete(bundleId: string): Promise<boolean> {
  const [row] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(pages)
    .leftJoin(layoutSpans, eq(layoutSpans.pageId, pages.id))
    .where(and(eq(pages.bundleId, bundleId), isNull(layoutSpans.id)))
    .groupBy(pages.bundleId);
  return (row?.remaining ?? 0) === 0;
}

async function extractionComplete(bundleId: string): Promise<boolean> {
  const [row] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(eq(documents.bundleId, bundleId), eq(documents.status, 'classified')));
  return (row?.remaining ?? 0) === 0;
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
        // The last page to finish fans out the binding stage.
        if (await layoutComplete(data.bundleId)) {
          const n = await queueExtractionForDocuments(data.bundleId, data.userId);
          log('layout.complete', { bundleId: data.bundleId, documents: n });
        }
        return;
      }

      case 'extract_document': {
        await extractDocument(data.bundleId, data.documentId, data.userId);
        if (await extractionComplete(data.bundleId)) {
          await pipelineQueue.add('reconcile_bundle', {
            kind: 'reconcile_bundle',
            bundleId: data.bundleId,
            userId: data.userId,
          });
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
