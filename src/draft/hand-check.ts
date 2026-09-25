/**
 * The hand-check sheet (P17 exit criterion).
 *
 * P17 cannot exit until a person has checked a draft return line by line against a known
 * packet. Everything else about the draft return has been measured by machine — the harness
 * scores 13 lines against the real engine, the catalogue check compares field names, the
 * translator's withholding rules are mutation-checked — and none of that is the same as
 * somebody holding the forms and agreeing.
 *
 * This exists to make that check a ticking exercise rather than a hunting one. For every line
 * it puts three things on one row:
 *
 *   1. what the documents report, which is the worksheet's own total;
 *   2. what the engine computed from the same documents;
 *   3. **which box on which document each contributing figure came from**, so the checker can
 *      go straight to the paper instead of working backwards from a total.
 *
 * (3) is the part that makes it worth generating. `worksheet_contributions` already records
 * it — per line, the document, the field and the amount — and it is otherwise only visible
 * expanded in the review UI, one line at a time.
 *
 * **The omissions come first**, as everywhere else (§14). A checker reconciling figures that
 * are wrong by a withheld pension, without being told a pension was withheld, would be
 * checking the wrong thing carefully.
 */
import { buildWorksheetModel } from '../mapping/engine.ts';
import { loadMappedDocuments } from '../worksheet/generate.ts';
import type {
  DraftSheetOmission,
  HandCheckModel,
  HandCheckRow,
  HandCheckSource,
} from '../worksheet/draft-sheet.ts';
import { latestDraftReturn } from './generate.ts';

/**
 * Build the sheet for a bundle's most recent draft return, or null when none exists.
 *
 * Reads the stored draft rather than recomputing one: the point is to check the draft the
 * preparer is looking at, and a freshly computed one could differ if a field was corrected in
 * between. The contributions are rebuilt from the documents because they are the *current*
 * provenance — if those have moved under the stored draft, the checker should see that rather
 * than have it hidden.
 */
export async function handCheckForBundle(bundleId: string): Promise<HandCheckModel | null> {
  const stored = await latestDraftReturn(bundleId);
  if (!stored) return null;

  const { taxYear, mapped, documentLabels } = await loadMappedDocuments(bundleId);
  const worksheet = await buildWorksheetModel(taxYear, mapped);

  const sourcesByRef = new Map<string, HandCheckSource[]>();
  for (const line of worksheet.lines) {
    if (line.contributions.length === 0) continue;
    sourcesByRef.set(
      line.lineRef,
      line.contributions.map((c) => ({
        document: documentLabels.get(c.documentId) ?? c.formType,
        // The box number as well as its name. A checker with the form in hand looks for
        // "box 1", not for "Wages, tips, other compensation" — and the field key already
        // carries it, so no schema lookup is needed to say both.
        fieldLabel: `${c.fieldKey.replace(/_/g, ' ')} · ${c.fieldLabel}`,
        valueCents: c.valueCents,
        wasCorrected: c.wasCorrected,
        judgmentReason: c.judgmentReason,
      })),
    );
  }

  const rows: HandCheckRow[] = stored.lines
    // Engine-only figures (AGI, total tax, the refund) have no line ref and nothing on the
    // documents to trace to, so there is nothing for a checker to tick them against. They are
    // on the Draft Return sheet already; repeating them here would be a column of blanks.
    .filter((l) => l.lineRef !== null && l.verdict !== 'both_blank')
    .map((l) => ({
      lineRef: l.lineRef!,
      label: l.lineLabel,
      reportedCents: l.reportedCents,
      computedCents: l.computedCents,
      verdict: l.verdict,
      note: l.note,
      sources: sourcesByRef.get(l.lineRef!) ?? [],
    }));

  return {
    taxYear: stored.draftReturn.taxYear,
    engineVersion: stored.draftReturn.engineVersion,
    nodeMapVersion: stored.draftReturn.nodeMapVersion,
    mappingVersion: stored.draftReturn.mappingVersion,
    filingStatus: stored.draftReturn.filingStatus,
    complete: stored.draftReturn.complete,
    documentsIncluded: stored.draftReturn.documentsIncluded,
    documentsWithheld: stored.draftReturn.documentsWithheld,
    generatedAt: stored.draftReturn.createdAt,
    omissions: [...stored.omissions]
      .sort((a, b) => Number(a.reason === 'not_in_bundle') - Number(b.reason === 'not_in_bundle'))
      .map((o) => ({
        formType: o.formType,
        fieldKey: o.fieldKey,
        reason: o.reason,
        detail: o.detail,
      })),
    rows,
  };
}
