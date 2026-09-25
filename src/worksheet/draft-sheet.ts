/**
 * What the workbook's `Draft Return` sheet needs (P17, §14).
 *
 * A flat shape, deliberately: it is built either from a freshly computed draft return or from
 * a stored one, and the renderer must not care which. Keeping it separate from
 * `src/draft/model.ts` also keeps `src/worksheet/` from importing the engine client, so a
 * workbook can still be built on a deployment where the draft return is switched off.
 */

export interface DraftSheetLine {
  /** Null for an engine figure the worksheet has no counterpart for — AGI, total tax. */
  lineRef: string | null;
  label: string;
  reportedCents: number | null;
  computedCents: number | null;
  verdict: string;
  note: string | null;
}

export interface DraftSheetOmission {
  formType: string | null;
  fieldKey: string | null;
  reason: string;
  detail: string;
}

export interface DraftSheetValidation {
  severity: string;
  code: string;
  message: string;
}

export interface DraftSheetModel {
  engineVersion: string;
  nodeMapVersion: string;
  complete: boolean;
  documentsIncluded: number;
  documentsWithheld: number;
  lines: DraftSheetLine[];
  omissions: DraftSheetOmission[];
  validations: DraftSheetValidation[];
}
