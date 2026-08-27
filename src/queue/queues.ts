/**
 * Queue topology (P0).
 *
 * `v1040.raster` is the language boundary: TypeScript enqueues, the Python sidecar
 * consumes. Everything else stays on the TS side.
 */
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.ts';

export const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE_NAMES = {
  /** Consumed by the Python sidecar. */
  RASTER: 'v1040.raster',
  /** Consumed by this app's worker. */
  PIPELINE: 'v1040.pipeline',
} as const;

export interface RasterJob {
  bundleId: string;
  sourceFileId: string;
  storageKey: string;
  mediaType: string;
}

export interface PageMetadata {
  pageNumber: number;
  route: 'text_layer' | 'raster';
  hasTextLayer: boolean;
  textLayerGarbled: boolean;
  textLayer: string | null;
  dpi: number;
  encoding: string;
  widthPx: number;
  heightPx: number;
  encodedBytes: number;
  rasterStorageKey: string;
  triageReason: string;
}

export type PipelineJob =
  | { kind: 'classify_bundle'; bundleId: string; userId: string }
  | { kind: 'layout_page'; bundleId: string; pageId: string; userId: string }
  | { kind: 'extract_document'; bundleId: string; documentId: string; userId: string }
  | { kind: 'reconcile_bundle'; bundleId: string; userId: string };

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export const rasterQueue = new Queue<RasterJob>(QUEUE_NAMES.RASTER, {
  connection,
  defaultJobOptions,
});

export const pipelineQueue = new Queue<PipelineJob>(QUEUE_NAMES.PIPELINE, {
  connection,
  defaultJobOptions,
});

export const rasterEvents = new QueueEvents(QUEUE_NAMES.RASTER, { connection: connection.duplicate() });

export async function closeQueues(): Promise<void> {
  await Promise.all([rasterQueue.close(), pipelineQueue.close(), rasterEvents.close()]);
  connection.disconnect();
}
