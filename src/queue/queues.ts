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

export interface RasterizeJob {
  kind?: 'rasterize';
  bundleId: string;
  sourceFileId: string;
  storageKey: string;
  mediaType: string;
  /** Carried through so the classify job that follows is attributed to the uploader. */
  userId?: string;
}

/**
 * Assemble the bookmarked, return-ordered PDF from the stored source files. Same queue,
 * same sidecar: it already holds the blob key and PyMuPDF, and it makes no AI calls.
 */
export interface AssembleJob {
  kind: 'assemble';
  bundleId: string;
  outputKey: string;
  sections: {
    label: string;
    entries: { title: string; pages: { storageKey: string; mediaType: string; pageNumber: number }[] }[];
  }[];
  userId?: string;
}

export interface AssembleResult {
  kind: 'assemble';
  bundleId: string;
  pageCount: number;
  bytes: number;
}

export type RasterJob = RasterizeJob | AssembleJob;

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
  /**
   * Exact text spans with page-relative 0..1 boxes, measured by the sidecar from the PDF's
   * own text layer. Present only for `text_layer` pages; such a page needs no vision
   * layout pass (§4, decision 2026-09-16).
   */
  layoutSpans?: { text: string; x0: number; y0: number; x1: number; y1: number }[] | null;
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
