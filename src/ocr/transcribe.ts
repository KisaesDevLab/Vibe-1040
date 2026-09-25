/**
 * Optional OCR transcription for pages with no text layer (§4, opt-in).
 *
 * A scan or a phone photo carries no text the sidecar can read, so before this the only
 * thing that ever saw such a page's contents was the vision model doing the layout pass.
 * When `OCR_FALLBACK_ENABLED` is on, this transcribes the page first, through a dedicated
 * task class that asks for prose rather than a schema.
 *
 * Why prose. The router pins the `local_ocr` provider kind to `json_schema: false`, and its
 * own note says why: a grammar constraint forces a small OCR model to invent a spans array
 * rather than refuse, which produced confident garbage. Asking a transcription model to
 * transcribe, and parsing the result here, is the honest division of labour.
 *
 * What this does not do is supply geometry. Nothing the `local_ocr` kind can serve returns
 * bounding boxes, so a value read out of a transcription has no span to point at, and §6's
 * rule that such a field blocks the worksheet applies in full. This makes a scanned page
 * readable, not provable, and that distinction is the reviewer's to resolve.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { startupSettings } from '../settings/runtime.ts';
import { db } from '../db/client.ts';
import { pages } from '../db/schema.ts';
import { completeText } from '../router/client.ts';
import { TASK_CLASS } from '../router/task-classes.ts';
import { blobs } from '../storage/index.ts';

/**
 * GLM-OCR documents two prompt modes, `Text Recognition:` and `Table Recognition:`. The
 * first is the general case and the one used here: a tax form is a form, not a table, and
 * asking for a Markdown table of a W-2 loses the box labels that make the text usable.
 *
 * Kept deliberately plain. A transcription model that is also being instructed tends to
 * summarise, and a summary of a W-2 is worse than useless.
 */
const TRANSCRIBE_PROMPT = 'Text Recognition:';

export interface TranscribeResult {
  pageId: string;
  characters: number;
  model: string;
  requestId: string;
}

interface TranscribeCandidate {
  route: string | null;
  textLayer: string | null;
  ocrText: string | null;
  rasterStorageKey: string | null;
}

/** True when this page needs, and is allowed, a transcription. */
export function shouldTranscribe(page: TranscribeCandidate): boolean {
  if (!startupSettings().ocrFallbackEnabled) return false;
  if (!page.rasterStorageKey) return false;
  // Already done. Re-transcribing on a reprocess costs a call and changes nothing.
  if (page.ocrText !== null) return false;
  // A usable text layer is exact and came from no model. Never overwrite that with an
  // estimate, and never spend a call producing a worse copy of what we already hold.
  if (page.route === 'text_layer' && page.textLayer) return false;
  return true;
}

export async function transcribePage(
  bundleId: string,
  pageId: string,
  userId?: string,
): Promise<TranscribeResult | null> {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page || !shouldTranscribe(page)) return null;

  const jpeg = await blobs.get(page.rasterStorageKey!);
  const dataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

  const { content, model, requestId } = await completeText(
    TASK_CLASS.OCR_TRANSCRIBE,
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: TRANSCRIBE_PROMPT },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
    { bundleId, ...(userId ? { userId } : {}), temperature: 0 },
  );

  await db
    .update(pages)
    .set({ ocrText: content, ocrModel: model, ocrRequestId: requestId, ocrAt: new Date() })
    .where(eq(pages.id, pageId));

  return { pageId, characters: content.length, model, requestId };
}

/** Pages in a bundle still awaiting a transcription. */
export async function pagesNeedingTranscription(bundleId: string): Promise<string[]> {
  if (!startupSettings().ocrFallbackEnabled) return [];
  const rows = await db
    .select({
      id: pages.id,
      route: pages.route,
      textLayer: pages.textLayer,
      ocrText: pages.ocrText,
      rasterStorageKey: pages.rasterStorageKey,
    })
    .from(pages)
    .where(and(eq(pages.bundleId, bundleId), isNull(pages.ocrText)));
  return rows.filter((row) => shouldTranscribe(row)).map((row) => row.id);
}
