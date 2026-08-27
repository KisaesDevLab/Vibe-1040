export interface Bundle {
  id: string;
  label: string;
  status: string;
  taxYear: number | null;
  identityConfirmedAt: string | null;
  duplicateOfBundleId: string | null;
  createdAt: string;
}

export interface DocumentRow {
  id: string;
  formType: string | null;
  payerName: string | null;
  taxYear: number | null;
  taxYearMismatch: boolean;
  corrected: boolean;
  void: boolean;
  isSummary: boolean;
  isSupplemental: boolean;
  parentDocumentId: string | null;
  status: string;
}

export interface CheckRow {
  id: string;
  documentId: string | null;
  checkKey: string;
  severity: 'hard' | 'soft';
  outcome: 'pass' | 'fail' | 'not_applicable';
  message: string;
  expectedCents: number | null;
  actualCents: number | null;
}

export interface FieldRow {
  fieldKey: string;
  fieldId: string;
  cents: number | null;
  text: string | null;
  bool: boolean | null;
  present: boolean;
  spanIds: string[];
  pageId: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  disagreed: boolean;
  wasCorrected: boolean;
  original: { cents: number | null; text: string | null; bool: boolean | null };
}

export interface SpanRow {
  id: string;
  pageId: string;
  spanIndex: number;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageRow {
  id: string;
  pageNumber: number;
  widthPx: number | null;
  heightPx: number | null;
  rasterAvailable: boolean;
}

export interface WorksheetLine {
  lineRef: string;
  label: string;
  totalCents: number | null;
  contributorCount: number;
  nullContributorCount: number;
  isJudgmentRequired: boolean;
  notComputed: boolean;
  notComputedReason?: string;
  contributions: {
    documentId: string;
    formType: string;
    fieldKey: string;
    fieldLabel: string;
    valueCents: number | null;
    informational: boolean;
    wasCorrected: boolean;
    judgmentReason?: string;
  }[];
}
