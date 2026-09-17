export interface Bundle {
  id: string;
  label: string;
  status: string;
  taxYear: number | null;
  identityConfirmedAt: string | null;
  duplicateOfBundleId: string | null;
  createdAt: string;
  /** Bookmarked, return-ordered PDF of the source pages, when built. */
  sortedPdfAt?: string | null;
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
  /** Form 8949 section letter for a 1099-B split per section. */
  sectionCode: string | null;
  /** extracted | skipped_supplemental | skipped_unclassified | no_schema | no_spans, or null while pending. */
  extractionOutcome: string | null;
  /** Return-order group the server sorted this document into ("Wages", "Interest", …). */
  group?: string;
}

export interface BundleProgress {
  pages: number;
  pagesLaidOut: number;
  pagesFromTextLayer: number;
  pagesFromModel: number;
  documents: number;
  documentsDone: number;
  extractionFannedOut: boolean;
  reconcileQueued: boolean;
}

export interface QueueFailure {
  jobId: string;
  kind: string;
  pageId: string | null;
  documentId: string | null;
  attemptsMade: number;
  error: string;
  failedAt: string | null;
}

export interface WorksheetRow {
  id: string;
  taxYear: number;
  createdAt: string;
  generatedByName: string | null;
  hasXlsx: boolean;
  hasPdf: boolean;
}

export interface RouterJobRow {
  id: string;
  taskClass: string;
  state: 'parked' | 'failed';
  pageId: string | null;
  documentId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  retryAfter: string | null;
  createdAt: string;
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
  /** What a reviewer decided about this failure, if anything. */
  disposition: { kind: string; note: string; createdAt: string } | null;
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
  /** Optional OCR fallback output. A model's reading, with no geometry behind it. */
  ocrText: string | null;
  ocrModel: string | null;
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

// ── admin ────────────────────────────────────────────────────────────────────

export interface SettingRow {
  key: string;
  group: string;
  label: string;
  help: string;
  input: 'text' | 'password' | 'number' | 'boolean' | 'select';
  options?: readonly string[];
  value: unknown;
  secret: boolean;
  isSet: boolean;
}

export interface EnvSetting {
  key: string;
  value: string;
  why: string;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'partner' | 'staff';
  mfaMethod: 'totp' | 'email' | 'sms';
  mfaEnrolled: boolean;
  phone: string | null;
  phoneVerified: boolean;
  disabledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  at: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  bundleId: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
  actorEmail: string | null;
}

export interface FactorState {
  method: 'totp' | 'email' | 'sms';
  usable: boolean;
  why: string | null;
  enrolled: boolean;
  needsTotpEnrolment: boolean;
  /** Whether an authenticator is already enrolled, whatever the assigned method is. */
  totpEnrolled: boolean;
  /** The firm permits authenticators, so an undeliverable factor has a way out. */
  totpAvailable: boolean;
}
