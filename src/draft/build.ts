/**
 * Assembling the engine input for a bundle (P17).
 *
 * The database-facing half of the translator. It reuses `loadMappedDocuments` so the draft
 * return and the worksheet can never disagree about which documents a bundle holds or which
 * schema year read them — a disagreement there would produce two numbers with no way to tell
 * which was wrong.
 */
import { loadMappedDocuments } from '../worksheet/generate.ts';
import { loadNodeMap } from './nodes.ts';
import { buildDraftInput, type DraftInput, type DraftParams } from './translate.ts';

export interface BundleDraftInput extends DraftInput {
  bundleId: string;
  bundleLabel: string;
  /** Label per document, so an omission can name the form a preparer is holding. */
  documentLabels: Record<string, string>;
}

export async function buildDraftInputForBundle(
  bundleId: string,
  params: DraftParams = {},
): Promise<BundleDraftInput> {
  const { bundle, taxYear, mapped, documentLabels } = await loadMappedDocuments(bundleId);
  const file = await loadNodeMap(taxYear);
  const input = buildDraftInput(file, mapped, params);

  return {
    ...input,
    bundleId,
    bundleLabel: bundle.label,
    documentLabels: Object.fromEntries(documentLabels),
  };
}
