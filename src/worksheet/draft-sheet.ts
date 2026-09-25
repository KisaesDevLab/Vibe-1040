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

// ── the hand-check sheet (P17 exit criterion) ────────────────────────────────

/** One contributing figure, traced to the box on the document it was read from. */
export interface HandCheckSource {
  /** `W-2 — ACME MANUFACTURING INC`, as the worksheet labels it. */
  document: string;
  /** The box as a preparer would look for it — `box 1 · Wages, tips, other compensation`. */
  fieldLabel: string;
  valueCents: number | null;
  wasCorrected: boolean;
  /** Set when this figure is reported but deliberately not carried into a total (§9). */
  judgmentReason: string | undefined;
}

export interface HandCheckRow {
  lineRef: string;
  label: string;
  reportedCents: number | null;
  computedCents: number | null;
  verdict: string;
  /** Why a disagreement on this line may be expected rather than a defect. */
  note: string | null;
  /** Blank source boxes are included: a null contributor is a fact about the packet (§5). */
  sources: HandCheckSource[];
}

/**
 * A figure the preparer typed rather than one read off a page (P18).
 *
 * On its own sheet block, and labelled, because the two are checked differently: a document
 * figure is checked against the paper, and this is checked against whatever the preparer worked
 * it out from — which is not in the packet at all. A checker who cannot tell them apart would
 * hunt for a form that was never there.
 */
export interface HandCheckPreparerFigure {
  /** `Filing status`, `Dependents`, `Itemised deductions`, `Businesses and rentals`. */
  group: string;
  label: string;
  /** Null for a statement with no amount — a dependent, a filing status, an election. */
  valueCents: number | null;
  /** The stated value where it is not money: `Married filing jointly`, `Yes`, `Not stated`. */
  stated: string | null;
  /** Set where this figure displaces a document's, naming what it displaced. */
  supersedes: string | null;
}

export interface HandCheckModel {
  taxYear: number;
  engineVersion: string;
  nodeMapVersion: string;
  mappingVersion: string;
  filingStatus: string | null;
  complete: boolean;
  documentsIncluded: number;
  documentsWithheld: number;
  generatedAt: Date;
  omissions: DraftSheetOmission[];
  /** What the preparer stated, because no document carries it (P18). */
  preparerFigures: HandCheckPreparerFigure[];
  rows: HandCheckRow[];
}

