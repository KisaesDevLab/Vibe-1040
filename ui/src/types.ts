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
  /** Masked or unhashable TINs seen on the documents: last four and a name. Never a full TIN. */
  identityHints?: { last4: string; name: string | null; formType: string | null; source: string }[] | null;
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

// ── draft return (P17, §14) ──────────────────────────────────────────────────

export type DraftVerdict =
  | 'agrees'
  | 'differs'
  | 'engine_silent'
  | 'worksheet_silent'
  | 'both_blank'
  | 'computed_only';

export interface DraftComparedLine {
  lineRef: string;
  label: string;
  sortOrder: number;
  engineForm: string;
  engineLine: string;
  reportedCents: number | null;
  computedCents: number | null;
  deltaCents: number | null;
  verdict: DraftVerdict;
  /** Why a disagreement on this line may be expected rather than a defect. */
  note?: string;
}

export interface DraftComputedOnly {
  engineForm: string;
  engineLine: string;
  label: string;
  computedCents: number | null;
  /** How to read this figure when it is confident and still misleading. Shown, never hidden. */
  note?: string;
}

export interface DraftOmission {
  documentId: string | null;
  formType: string | null;
  fieldKey: string | null;
  reason: string;
  detail: string;
}

/** What `POST /api/bundles/:id/draft-return` returns. */
export interface DraftReturn {
  draftReturnId: string;
  taxYear: number;
  engineVersion: string;
  nodeMapVersion: string;
  complete: boolean;
  documentsIncluded: number;
  documentsWithheld: number;
  comparison: {
    toleranceCents: number;
    lines: DraftComparedLine[];
    computedOnly: DraftComputedOnly[];
    counts: Record<DraftVerdict, number>;
    differing: DraftComparedLine[];
  };
  omissions: DraftOmission[];
  validation: { hard: { code: string; message: string }[]; soft: { code: string; message: string }[] };
  engineSummary: Record<string, number>;
}

/** What `GET /api/bundles/:id/draft-return` returns — the stored rows, as stored. */
export interface StoredDraftReturn {
  draftReturn: {
    id: string;
    taxYear: number;
    engineVersion: string;
    nodeMapVersion: string;
    mappingVersion: string;
    filingStatus: string | null;
    complete: boolean;
    documentsIncluded: number;
    documentsWithheld: number;
    createdAt: string;
  };
  lines: {
    lineRef: string | null;
    lineLabel: string;
    sortOrder: number;
    engineForm: string;
    engineLine: string;
    reportedCents: number | null;
    computedCents: number | null;
    verdict: string;
    note: string | null;
  }[];
  omissions: { formType: string | null; fieldKey: string | null; reason: string; detail: string }[];
  validations: { severity: string; code: string; message: string }[];
}

// ── draft-return engine readiness (P17, Admin -> Draft engine) ───────────────

export type CatalogFindingKind =
  | 'node_type_absent'
  | 'field_unknown'
  | 'required_field_unmapped'
  | 'required_flag_stale';

export interface CatalogFinding {
  severity: 'blocking' | 'advisory';
  kind: CatalogFindingKind;
  formType: string;
  nodeType: string;
  engineField?: string;
  detail: string;
}

export interface CatalogCheck {
  engineVersion: string;
  nodeTypes: string[];
  findings: CatalogFinding[];
  blocking: CatalogFinding[];
  ok: boolean;
}

/**
 * What `GET /api/admin/draft-engine` reports. Read-only by design: the version is pinned and
 * checksum-verified when the sidecar image is built, so nothing here can replace the binary.
 */
export interface DraftEngineReadiness {
  enabled: boolean;
  engine: { ok: boolean; version: string | null; reason?: string };
  pins: { environment: string; nodeMap: string | null; nodeMapVersion: string | null };
  versionsAgree: boolean;
  check: CatalogCheck | null;
  error: string | null;
}

