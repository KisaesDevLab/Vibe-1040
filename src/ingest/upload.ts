/**
 * Bundle ingestion (P1).
 *
 * Staff-only, from inside the firm (§2). Original files are immutable once written — the
 * storage key is derived from the file record's id and nothing updates it.
 *
 * Duplicate detection is content-hash only, which is the accepted v1 consequence of having
 * no client master (§7). Two uploads of the same scan are caught; the same W-2 rescanned at
 * a different DPI is not, and that is a known limit rather than a bug.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { bundles, sourceFiles } from '../db/schema.ts';
import { blobs, keys } from '../storage/index.ts';

export interface IncomingFile {
  filename: string;
  mediaType: string;
  bytes: Buffer;
}

export interface IngestResult {
  bundleId: string;
  fileCount: number;
  duplicateOfBundleId: string | null;
  label: string;
}

export interface IngestOptions {
  /** The label is the app's guess and identity resolution may replace it (§7). */
  labelAuto?: boolean;
}

const ACCEPTED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/heic',
]);

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Order-independent hash of the whole upload set: sort the per-file digests before
 * combining, so the same bundle uploaded with files in a different order is still
 * recognised as the same bundle.
 */
export function bundleContentHash(files: readonly IncomingFile[]): string {
  const digests = files.map((f) => sha256(f.bytes)).sort();
  return createHash('sha256').update(digests.join('\n')).digest('hex');
}

/**
 * A readable provisional label from a filename.
 *
 * Deliberately not an attempt to parse a client name out of it. Firms name files every way
 * imaginable, and a wrong name is worse than an obviously mechanical one because it looks
 * authoritative. This only has to hold until identity resolution proposes the real name
 * (§7); it exists so a bulk upload of forty packets is not forty rows called "Bundle".
 *
 * Strips the extension and any upload-side hash prefix, turns separators into spaces, and
 * collapses whitespace. Everything else in the filename is kept, because the parts a firm
 * chose to put there are the parts that let a reviewer tell two rows apart.
 */
export function labelFromFilename(filename: string): string {
  const base = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const withoutUploadPrefix = base.replace(/^[0-9a-f]{8,}-/i, '');
  const spaced = withoutUploadPrefix.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced || filename;
}

export async function ingestBundle(
  label: string,
  files: readonly IncomingFile[],
  uploadedBy: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  if (!files.length) throw new Error('a bundle needs at least one file');

  for (const file of files) {
    if (!ACCEPTED.has(file.mediaType)) {
      throw new Error(`unsupported media type for ${file.filename}: ${file.mediaType}`);
    }
  }

  const contentHash = bundleContentHash(files);
  const [existing] = await db
    .select({ id: bundles.id })
    .from(bundles)
    .where(eq(bundles.contentHash, contentHash))
    .limit(1);

  const [bundle] = await db
    .insert(bundles)
    .values({
      label,
      labelAuto: options.labelAuto ?? false,
      uploadedBy,
      contentHash,
      // Recorded, not rejected: the reviewer decides whether a duplicate is a mistake or a
      // deliberate re-run.
      duplicateOfBundleId: existing?.id ?? null,
      status: 'uploaded',
    })
    .returning({ id: bundles.id });

  const bundleId = bundle!.id;

  for (const file of files) {
    const fileId = keys.newId();
    const storageKey = keys.source(bundleId, fileId);
    await blobs.put(storageKey, file.bytes);
    await db.insert(sourceFiles).values({
      id: fileId,
      bundleId,
      filename: file.filename,
      mediaType: file.mediaType,
      byteSize: file.bytes.length,
      sha256: sha256(file.bytes),
      storageKey,
    });
  }

  return { bundleId, fileCount: files.length, duplicateOfBundleId: existing?.id ?? null, label };
}

/**
 * Bulk upload: one bundle per file, each named from its own filename.
 *
 * One file per bundle rather than one bundle per upload, because the unit a firm actually
 * drops on this screen is a client packet — five clients is five bundles, not one with five
 * PDFs in it. A packet that genuinely spans several files still goes through the single
 * upload path, where the reviewer says so explicitly.
 *
 * One failure does not sink the batch. A folder of forty packets that contains one
 * unsupported file should ingest thirty-nine and name the one it refused, not reject the
 * lot — which is what a single throwing loop would do.
 */
export async function ingestBundlesPerFile(
  files: readonly IncomingFile[],
  uploadedBy: string,
): Promise<{ ingested: IngestResult[]; rejected: { filename: string; reason: string }[] }> {
  if (!files.length) throw new Error('a bulk upload needs at least one file');

  const ingested: IngestResult[] = [];
  const rejected: { filename: string; reason: string }[] = [];

  for (const file of files) {
    try {
      ingested.push(
        await ingestBundle(labelFromFilename(file.filename), [file], uploadedBy, { labelAuto: true }),
      );
    } catch (err) {
      rejected.push({ filename: file.filename, reason: (err as Error).message });
    }
  }

  return { ingested, rejected };
}
