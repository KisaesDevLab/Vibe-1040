/**
 * Turning a stored draft return into what the workbook sheet needs (P17).
 *
 * Lives here rather than in `src/worksheet/` so that module never imports the engine client:
 * a workbook must still build on a deployment where the draft return is switched off.
 */
import type {
  DraftSheetModel,
  DraftSheetOmission,
} from '../worksheet/draft-sheet.ts';
import { latestDraftReturn } from './generate.ts';

/**
 * The most recent draft return for a bundle, shaped for the workbook — or null when none has
 * been computed, which is the ordinary case and not an error.
 */
export async function draftSheetForBundle(bundleId: string): Promise<DraftSheetModel | null> {
  const stored = await latestDraftReturn(bundleId);
  if (!stored) return null;

  const { draftReturn, lines, omissions, validations } = stored;
  return {
    engineVersion: draftReturn.engineVersion,
    nodeMapVersion: draftReturn.nodeMapVersion,
    complete: draftReturn.complete,
    documentsIncluded: draftReturn.documentsIncluded,
    documentsWithheld: draftReturn.documentsWithheld,
    lines: lines.map((l) => ({
      lineRef: l.lineRef,
      label: l.lineLabel,
      reportedCents: l.reportedCents,
      computedCents: l.computedCents,
      verdict: l.verdict,
      note: l.note,
    })),
    // Whatever no document could carry is listed last: a preparer scanning for a form they
    // are holding should not have to read past "carryovers" to find it.
    omissions: [...omissions]
      .sort((a, b) => Number(a.reason === 'not_in_bundle') - Number(b.reason === 'not_in_bundle'))
      .map(
        (o): DraftSheetOmission => ({
          formType: o.formType,
          fieldKey: o.fieldKey,
          reason: o.reason,
          detail: o.detail,
        }),
      ),
    validations: validations.map((v) => ({
      severity: v.severity,
      code: v.code,
      message: v.message,
    })),
  };
}
