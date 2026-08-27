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

export async function ingestBundle(
  label: string,
  files: readonly IncomingFile[],
  uploadedBy: string,
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

  return { bundleId, fileCount: files.length, duplicateOfBundleId: existing?.id ?? null };
}
