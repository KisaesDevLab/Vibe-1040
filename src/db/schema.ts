/**
 * Postgres schema (P0–P13).
 *
 * Two invariants run through the whole thing and must not be softened:
 *
 *  1. **Blank is not zero (§5).** Every extracted money column is nullable. There are no
 *     `.default(0)` and no `NOT NULL` on a value that could legitimately be an empty box.
 *     A null means "the box was empty"; a 0 means "the form printed a zero".
 *  2. **No plaintext TIN (§7).** Only `tinHash` (salted) and `tinLast4` exist. There is
 *     deliberately no column a full SSN could be written to.
 *
 * Money is stored as integer **cents** (bigint). Never float.
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ── enums ────────────────────────────────────────────────────────────────────

export const userRole = pgEnum('user_role', ['admin', 'partner', 'staff']);

export const bundleStatus = pgEnum('bundle_status', [
  'uploaded',
  'triaging',
  'classifying',
  'identifying',
  'awaiting_identity_confirmation',
  'extracting',
  'reconciling',
  'blocked',
  'in_review',
  'ready',
  'failed',
]);

export const pageRoute = pgEnum('page_route', ['text_layer', 'raster']);

export const documentStatus = pgEnum('document_status', [
  'pending',
  'classified',
  'extracted',
  'reconciled',
  'needs_review',
  'accepted',
]);

/** Why a field or document was routed to a human. */
export const reviewReason = pgEnum('review_reason', [
  'no_span',
  'pass_disagreement',
  'hard_failure',
  'soft_failure',
  'judgment_required',
  'unmapped',
]);

export const checkSeverity = pgEnum('check_severity', ['hard', 'soft']);
export const checkOutcome = pgEnum('check_outcome', ['pass', 'fail', 'not_applicable']);
export const dispositionKind = pgEnum('disposition_kind', [
  'accepted_as_is',
  'corrected',
  'document_excluded',
]);

export const jobState = pgEnum('job_state', ['queued', 'running', 'parked', 'done', 'failed']);

/** Second-factor delivery channels. TOTP is the strongest; email and SMS are conveniences. */
export const mfaMethod = pgEnum('mfa_method', ['totp', 'email', 'sms']);
export const otpPurpose = pgEnum('otp_purpose', ['mfa', 'password_reset', 'phone_verify']);

// ── staff, auth, audit (P0) ──────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: userRole('role').notNull().default('staff'),
  passwordHash: text('password_hash').notNull(),
  /** GLBA Safeguards: MFA is required, not optional. Enforced at login (§11). */
  totpSecret: text('totp_secret'),
  totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
  phone: text('phone'),
  phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
  /** WHICH factor this user completes. Never whether one is required — it always is (§11). */
  mfaMethod: mfaMethod('mfa_method').notNull().default('totp'),
  mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestamps,
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    /** A session is only usable after the TOTP step completes. */
    mfaSatisfiedAt: timestamp('mfa_satisfied_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/**
 * Access log (§11). Every route that touches taxpayer data writes here, and P14 audits
 * that claim route by route. Append-only by convention — nothing updates or deletes rows.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    bundleId: uuid('bundle_id'),
    ip: text('ip'),
    /** before/after for corrections; request metadata otherwise. Never raw PII. */
    detail: jsonb('detail').notNull().default({}),
  },
  (t) => [
    index('audit_at_idx').on(t.at),
    index('audit_bundle_idx').on(t.bundleId),
    index('audit_entity_idx').on(t.entityType, t.entityId),
  ],
);

// ── clients and bundles (P1, P5) ─────────────────────────────────────────────

/**
 * Identity is derived from the bundle and confirmed by a reviewer (§7). This is not a
 * client master — it is a join surface. Kept behind `src/identity/` so a later version can
 * bind to Vibe T&B or the Filer sentinel instead (§13).
 */
export const taxpayers = pgTable(
  'taxpayers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Salted hash of the TIN. THE join key. Plaintext TINs are never stored. */
    tinHash: text('tin_hash').notNull().unique(),
    /** Display only. Four digits is the entire plaintext surface. */
    tinLast4: text('tin_last4').notNull(),
    /** Best-known name. A tiebreaker for matching, never the key. */
    displayName: text('display_name'),
    ...timestamps,
  },
  (t) => [index('taxpayers_last4_idx').on(t.tinLast4)],
);

export const bundles = pgTable(
  'bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    status: bundleStatus('status').notNull().default('uploaded'),
    /** Majority tax year across documents; per-document mismatches are flagged (§7). */
    taxYear: integer('tax_year'),
    /** Confirmed by a human before extraction results commit. Null until then. */
    identityConfirmedAt: timestamp('identity_confirmed_at', { withTimezone: true }),
    identityConfirmedBy: uuid('identity_confirmed_by').references(() => users.id),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    /** Content hash of the whole upload set — duplicate-bundle detection is hash-only (§7). */
    contentHash: text('content_hash').notNull(),
    duplicateOfBundleId: uuid('duplicate_of_bundle_id'),
    ...timestamps,
  },
  (t) => [index('bundles_hash_idx').on(t.contentHash), index('bundles_status_idx').on(t.status)],
);

/** A bundle can carry several TINs — joint returns, trusts, dependents (§7). */
export const bundleTaxpayers = pgTable(
  'bundle_taxpayers',
  {
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => bundles.id, { onDelete: 'cascade' }),
    taxpayerId: uuid('taxpayer_id')
      .notNull()
      .references(() => taxpayers.id),
    /** 'primary' | 'spouse' | 'other' — proposed, then confirmed. */
    role: text('role').notNull().default('other'),
    proposed: boolean('proposed').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('bundle_taxpayer_uq').on(t.bundleId, t.taxpayerId)],
);

// ── source files, documents, pages (P1, P2, P4) ──────────────────────────────

/** Immutable once written (P1). Nothing updates `storageKey` or `sha256`. */
export const sourceFiles = pgTable(
  'source_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => bundles.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    pageCount: integer('page_count'),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('source_files_bundle_idx').on(t.bundleId), index('source_files_sha_idx').on(t.sha256)],
);

/**
 * A logical document: contiguous pages that make up one form (P4). Consolidated 1099
 * packages are containers — sub-forms are their own documents with `parentDocumentId` set.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => bundles.id, { onDelete: 'cascade' }),
    parentDocumentId: uuid('parent_document_id'),
    /** Registry key, e.g. 'W-2', '1099-B'. Null until classified. */
    formType: text('form_type'),
    formSchemaVersion: text('form_schema_version'),
    taxYear: integer('tax_year'),
    /** True when this document's year differs from the bundle majority (§7). */
    taxYearMismatch: boolean('tax_year_mismatch').notNull().default(false),
    taxpayerId: uuid('taxpayer_id').references(() => taxpayers.id),
    status: documentStatus('status').notNull().default('pending'),
    /** First-class at classification time, not buried in extraction (P4). */
    corrected: boolean('corrected').notNull().default(false),
    void: boolean('void').notNull().default(false),
    /** Summary page of a consolidated package, or a non-form supplemental page. */
    isSummary: boolean('is_summary').notNull().default(false),
    isSupplemental: boolean('is_supplemental').notNull().default(false),
    /** Payer/issuer as printed. Display and tiebreaking only. */
    payerName: text('payer_name'),
    classifierConfidence: real('classifier_confidence'),
    /** Which model classified the first page — makes a mid-season policy swap detectable. */
    classifierModel: text('classifier_model'),
    classifierRequestId: text('classifier_request_id'),
    ...timestamps,
  },
  (t) => [
    index('documents_bundle_idx').on(t.bundleId),
    index('documents_parent_idx').on(t.parentDocumentId),
    index('documents_type_idx').on(t.formType),
  ],
);

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => bundles.id, { onDelete: 'cascade' }),
    sourceFileId: uuid('source_file_id')
      .notNull()
      .references(() => sourceFiles.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id),
    /** 1-based, within the source file. */
    pageNumber: integer('page_number').notNull(),
    route: pageRoute('route'),
    hasTextLayer: boolean('has_text_layer'),
    textLayerGarbled: boolean('text_layer_garbled'),
    /** Kept for footing checks alongside the raster (P2). */
    textLayer: text('text_layer'),
    dpi: integer('dpi'),
    encoding: text('encoding'),
    widthPx: integer('width_px'),
    heightPx: integer('height_px'),
    encodedBytes: integer('encoded_bytes'),
    /** 'fraction' | 'thousandths' | 'pixel' — what scale the layout model actually returned (P7). */
    layoutCoordConvention: text('layout_coord_convention'),
    /** Derived PII. Purges on its own earlier schedule (§11, P13). */
    rasterStorageKey: text('raster_storage_key'),
    rasterPurgedAt: timestamp('raster_purged_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('pages_file_number_uq').on(t.sourceFileId, t.pageNumber),
    index('pages_bundle_idx').on(t.bundleId),
    index('pages_document_idx').on(t.documentId),
  ],
);

// ── layout spans (P7) ────────────────────────────────────────────────────────

/**
 * The provenance substrate (§4). Written verbatim from the layout pass and **immutable**.
 * Every number on the worksheet traces back through `extractedFields.spanIds` to rows here,
 * so a coordinate is never something a model invented for a value.
 */
export const layoutSpans = pgTable(
  'layout_spans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** Stable within a page; what extracted fields reference. */
    spanIndex: integer('span_index').notNull(),
    text: text('text').notNull(),
    /** Page-relative, normalized 0..1 on receipt so a provider swap cannot drift (P7). */
    x0: real('x0').notNull(),
    y0: real('y0').notNull(),
    x1: real('x1').notNull(),
    y1: real('y1').notNull(),
    /** Which model produced this span set — makes a mid-season provider swap detectable. */
    producedByModel: text('produced_by_model').notNull(),
    routerRequestId: text('router_request_id'),
    ...timestamps,
  },
  (t) => [uniqueIndex('layout_spans_page_index_uq').on(t.pageId, t.spanIndex)],
);

// ── extraction (P8) ──────────────────────────────────────────────────────────

/**
 * One row per schema field per document.
 *
 * `valueCents` / `valueText` / `valueBool` are ALL nullable, and that is load-bearing:
 * null means the box was blank, and a printed zero is `valueCents = 0`. Collapsing the two
 * destroys the tool's main value (§5).
 */
export const extractedFields = pgTable(
  'extracted_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** Schema field key, e.g. 'box_1', 'box_12a_code'. */
    fieldKey: text('field_key').notNull(),
    valueCents: bigint('value_cents', { mode: 'number' }),
    valueText: text('value_text'),
    valueBool: boolean('value_bool'),
    /** Empty array = the binder could not tie this to pixels → forced to review (§4, P8). */
    spanIds: uuid('span_ids').array().notNull().default([]),
    pageId: uuid('page_id').references(() => pages.id),
    /** Multi-pass agreement is the ONLY confidence signal available (Q4). */
    passCount: integer('pass_count').notNull().default(1),
    passAgreement: real('pass_agreement'),
    disagreed: boolean('disagreed').notNull().default(false),
    needsReview: boolean('needs_review').notNull().default(false),
    reviewReason: reviewReason('review_reason'),
    producedByModel: text('produced_by_model'),
    routerRequestId: text('router_request_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('extracted_fields_doc_key_uq').on(t.documentId, t.fieldKey),
    index('extracted_fields_review_idx').on(t.needsReview),
  ],
);

/**
 * Human corrections **layer over** model output, never overwrite it (P11). The original
 * `extractedFields` row stays exactly as the model produced it, so it remains recoverable
 * after any number of corrections.
 */
export const fieldCorrections = pgTable(
  'field_corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => extractedFields.id, { onDelete: 'cascade' }),
    /** Nullable on purpose: a correction can legitimately set a field back to blank. */
    valueCents: bigint('value_cents', { mode: 'number' }),
    valueText: text('value_text'),
    valueBool: boolean('value_bool'),
    /** Explicit, because null value + null flag is ambiguous. */
    setToNull: boolean('set_to_null').notNull().default(false),
    correctedBy: uuid('corrected_by')
      .notNull()
      .references(() => users.id),
    note: text('note'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('field_corrections_field_idx').on(t.fieldId)],
);

// ── reconciliation (P9) ──────────────────────────────────────────────────────

export const checkResults = pgTable(
  'check_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => bundles.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    checkKey: text('check_key').notNull(),
    severity: checkSeverity('severity').notNull(),
    outcome: checkOutcome('outcome').notNull(),
    message: text('message').notNull(),
    expectedCents: bigint('expected_cents', { mode: 'number' }),
    actualCents: bigint('actual_cents', { mode: 'number' }),
    toleranceCents: bigint('tolerance_cents', { mode: 'number' }),
    detail: jsonb('detail').notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index('check_results_bundle_idx').on(t.bundleId),
    index('check_results_outcome_idx').on(t.outcome, t.severity),
  ],
);

/** A hard failure blocks the worksheet until a human dispositions it (§6). */
export const dispositions = pgTable(
  'dispositions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkResultId: uuid('check_result_id')
      .notNull()
      .references(() => checkResults.id, { onDelete: 'cascade' })
      .unique(),
    kind: dispositionKind('kind').notNull(),
    note: text('note').notNull(),
    dispositionedBy: uuid('dispositioned_by')
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
);

// ── worksheet (P10, P12) ─────────────────────────────────────────────────────

export const worksheets = pgTable(
  'worksheets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => bundles.id, { onDelete: 'cascade' }),
    taxYear: integer('tax_year').notNull(),
    mappingVersion: text('mapping_version').notNull(),
    generatedBy: uuid('generated_by')
      .notNull()
      .references(() => users.id),
    xlsxStorageKey: text('xlsx_storage_key'),
    pdfStorageKey: text('pdf_storage_key'),
    ...timestamps,
  },
  (t) => [index('worksheets_bundle_idx').on(t.bundleId)],
);

export const worksheetLines = pgTable(
  'worksheet_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worksheetId: uuid('worksheet_id')
      .notNull()
      .references(() => worksheets.id, { onDelete: 'cascade' }),
    /** e.g. '1040:1z', '1040:2b', 'SCH1A:13b', 'JUDGMENT'. */
    lineRef: text('line_ref').notNull(),
    lineLabel: text('line_label').notNull(),
    sortOrder: integer('sort_order').notNull(),
    /** Sum of NON-NULL contributors only. Null when nothing contributed (§5). */
    totalCents: bigint('total_cents', { mode: 'number' }),
    /** Reported separately and never folded into the total — that is the whole point. */
    nullContributorCount: integer('null_contributor_count').notNull().default(0),
    contributorCount: integer('contributor_count').notNull().default(0),
    isJudgmentRequired: boolean('is_judgment_required').notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex('worksheet_lines_uq').on(t.worksheetId, t.lineRef)],
);

export const worksheetContributions = pgTable(
  'worksheet_contributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worksheetLineId: uuid('worksheet_line_id')
      .notNull()
      .references(() => worksheetLines.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id').references(() => extractedFields.id),
    fieldKey: text('field_key').notNull(),
    /** Null = the source box was blank. Counted in nullContributorCount, not as zero. */
    valueCents: bigint('value_cents', { mode: 'number' }),
    wasCorrected: boolean('was_corrected').notNull().default(false),
    judgmentReason: text('judgment_reason'),
    ...timestamps,
  },
  (t) => [index('worksheet_contributions_line_idx').on(t.worksheetLineId)],
);

// ── jobs (P3) ────────────────────────────────────────────────────────────────

/**
 * Router-facing work parks here when the router is unreachable rather than failing the
 * bundle (§3). The UI reads this to say "the Router is down" instead of "extraction failed".
 */
export const routerJobs = pgTable(
  'router_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id').references(() => bundles.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    taskClass: text('task_class').notNull(),
    state: jobState('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    retryAfter: timestamp('retry_after', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('router_jobs_state_idx').on(t.state), index('router_jobs_bundle_idx').on(t.bundleId)],
);

// ── retention (P13) ──────────────────────────────────────────────────────────

/** Documented disposal with an audit trail (§11). Nothing purges without a policy match. */
export const purgeLog = pgTable(
  'purge_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** 'raster' | 'source_document' */
    kind: text('kind').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    bundleId: uuid('bundle_id'),
    policyDays: integer('policy_days').notNull(),
    ageDays: integer('age_days').notNull(),
    storageKey: text('storage_key'),
    dryRun: boolean('dry_run').notNull().default(false),
  },
  (t) => [index('purge_log_at_idx').on(t.at), index('purge_log_bundle_idx').on(t.bundleId)],
);

// ── firm settings and notifications (0002) ───────────────────────────────────

/**
 * Firm-policy configuration, editable by an admin without shell access and audited on every
 * change (§13: firm-specific configuration lives in config, not code).
 *
 * Secrets stored here — an SMTP password, an SMS auth token — are sealed with the same
 * AES-256-GCM envelope as blob storage before they land in `value`. Infrastructure and key
 * material stay in the environment and are deliberately NOT represented here.
 */
export const firmSettings = pgTable('firm_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  isSecret: boolean('is_secret').notNull().default(false),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One-time codes. The code is never stored, only its hash — a database read must not let
 * anyone complete a second factor or reset a password.
 */
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: otpPurpose('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    /** Redacted for display: "j***@example.com", "***-***-1234". */
    destination: text('destination').notNull(),
    channel: mfaMethod('channel').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('otp_user_purpose_idx').on(t.userId, t.purpose), index('otp_expires_idx').on(t.expiresAt)],
);

/** Delivery attempts — a factor that silently fails to send looks like a user ignoring it. */
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id),
    channel: mfaMethod('channel').notNull(),
    purpose: otpPurpose('purpose').notNull(),
    destination: text('destination').notNull(),
    succeeded: boolean('succeeded').notNull(),
    error: text('error'),
  },
  (t) => [index('notification_log_at_idx').on(t.at)],
);
