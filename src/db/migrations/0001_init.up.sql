-- 0001_init — P0 scaffolding through P13 retention.
-- Money is integer cents (bigint). Every extracted value column is nullable (§5).
-- No column here can hold a plaintext TIN (§7).

CREATE TYPE user_role        AS ENUM ('admin', 'partner', 'staff');
CREATE TYPE bundle_status    AS ENUM ('uploaded','triaging','classifying','identifying',
                                      'awaiting_identity_confirmation','extracting','reconciling',
                                      'blocked','in_review','ready','failed');
CREATE TYPE page_route       AS ENUM ('text_layer','raster');
CREATE TYPE document_status  AS ENUM ('pending','classified','extracted','reconciled','needs_review','accepted');
CREATE TYPE review_reason    AS ENUM ('no_span','pass_disagreement','hard_failure','soft_failure',
                                      'judgment_required','unmapped');
CREATE TYPE check_severity   AS ENUM ('hard','soft');
CREATE TYPE check_outcome    AS ENUM ('pass','fail','not_applicable');
CREATE TYPE disposition_kind AS ENUM ('accepted_as_is','corrected','document_excluded');
CREATE TYPE job_state        AS ENUM ('queued','running','parked','done','failed');

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL UNIQUE,
  display_name      text NOT NULL,
  role              user_role NOT NULL DEFAULT 'staff',
  password_hash     text NOT NULL,
  totp_secret       text,
  totp_confirmed_at timestamptz,
  disabled_at       timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  token_hash       text NOT NULL UNIQUE,
  mfa_satisfied_at timestamptz,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users(id),
  action      text NOT NULL,
  entity_type text,
  entity_id   uuid,
  bundle_id   uuid,
  ip          text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_at_idx     ON audit_log(at);
CREATE INDEX audit_bundle_idx ON audit_log(bundle_id);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);

CREATE TABLE taxpayers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tin_hash     text NOT NULL UNIQUE,
  tin_last4    text NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX taxpayers_last4_idx ON taxpayers(tin_last4);
-- Belt and braces on §7: four digits, nothing longer, ever.
ALTER TABLE taxpayers ADD CONSTRAINT taxpayers_last4_len CHECK (tin_last4 ~ '^[0-9]{4}$');

CREATE TABLE bundles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                    text NOT NULL,
  status                   bundle_status NOT NULL DEFAULT 'uploaded',
  tax_year                 integer,
  identity_confirmed_at    timestamptz,
  identity_confirmed_by    uuid REFERENCES users(id),
  uploaded_by              uuid NOT NULL REFERENCES users(id),
  content_hash             text NOT NULL,
  duplicate_of_bundle_id   uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bundles_hash_idx   ON bundles(content_hash);
CREATE INDEX bundles_status_idx ON bundles(status);

CREATE TABLE bundle_taxpayers (
  bundle_id   uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  taxpayer_id uuid NOT NULL REFERENCES taxpayers(id),
  role        text NOT NULL DEFAULT 'other',
  proposed    boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bundle_taxpayer_uq ON bundle_taxpayers(bundle_id, taxpayer_id);

CREATE TABLE source_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id   uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  media_type  text NOT NULL,
  byte_size   bigint NOT NULL,
  sha256      text NOT NULL,
  storage_key text NOT NULL,
  page_count  integer,
  purged_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_files_bundle_idx ON source_files(bundle_id);
CREATE INDEX source_files_sha_idx    ON source_files(sha256);

CREATE TABLE documents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id              uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  parent_document_id     uuid REFERENCES documents(id) ON DELETE CASCADE,
  form_type              text,
  form_schema_version    text,
  tax_year               integer,
  tax_year_mismatch      boolean NOT NULL DEFAULT false,
  taxpayer_id            uuid REFERENCES taxpayers(id),
  status                 document_status NOT NULL DEFAULT 'pending',
  corrected              boolean NOT NULL DEFAULT false,
  void                   boolean NOT NULL DEFAULT false,
  is_summary             boolean NOT NULL DEFAULT false,
  is_supplemental        boolean NOT NULL DEFAULT false,
  payer_name             text,
  classifier_confidence  real,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_bundle_idx ON documents(bundle_id);
CREATE INDEX documents_parent_idx ON documents(parent_document_id);
CREATE INDEX documents_type_idx   ON documents(form_type);

CREATE TABLE pages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id           uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  source_file_id      uuid NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  document_id         uuid REFERENCES documents(id),
  page_number         integer NOT NULL,
  route               page_route,
  has_text_layer      boolean,
  text_layer_garbled  boolean,
  text_layer          text,
  dpi                 integer,
  encoding            text,
  width_px            integer,
  height_px           integer,
  encoded_bytes       integer,
  raster_storage_key  text,
  raster_purged_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pages_file_number_uq ON pages(source_file_id, page_number);
CREATE INDEX pages_bundle_idx   ON pages(bundle_id);
CREATE INDEX pages_document_idx ON pages(document_id);

CREATE TABLE layout_spans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id            uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  span_index         integer NOT NULL,
  text               text NOT NULL,
  x0                 real NOT NULL,
  y0                 real NOT NULL,
  x1                 real NOT NULL,
  y1                 real NOT NULL,
  produced_by_model  text NOT NULL,
  router_request_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX layout_spans_page_index_uq ON layout_spans(page_id, span_index);
-- Normalized page-relative coordinates (P7). Out-of-range means an adapter changed
-- convention on us, which must fail loudly rather than drift.
ALTER TABLE layout_spans ADD CONSTRAINT layout_spans_norm CHECK (
  x0 >= 0 AND y0 >= 0 AND x1 <= 1 AND y1 <= 1 AND x1 >= x0 AND y1 >= y0
);

CREATE TABLE extracted_fields (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id        uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_key          text NOT NULL,
  value_cents        bigint,
  value_text         text,
  value_bool         boolean,
  span_ids           uuid[] NOT NULL DEFAULT '{}',
  page_id            uuid REFERENCES pages(id),
  pass_count         integer NOT NULL DEFAULT 1,
  pass_agreement     real,
  disagreed          boolean NOT NULL DEFAULT false,
  needs_review       boolean NOT NULL DEFAULT false,
  review_reason      review_reason,
  produced_by_model  text,
  router_request_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX extracted_fields_doc_key_uq ON extracted_fields(document_id, field_key);
CREATE INDEX extracted_fields_review_idx ON extracted_fields(needs_review);
-- §4: a field with no span is force-routed to review regardless of confidence. Enforced
-- here so no code path can write an unreviewable orphan value.
ALTER TABLE extracted_fields ADD CONSTRAINT extracted_fields_span_or_review CHECK (
  cardinality(span_ids) > 0 OR needs_review = true
);

CREATE TABLE field_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id      uuid NOT NULL REFERENCES extracted_fields(id) ON DELETE CASCADE,
  value_cents   bigint,
  value_text    text,
  value_bool    boolean,
  set_to_null   boolean NOT NULL DEFAULT false,
  corrected_by  uuid NOT NULL REFERENCES users(id),
  note          text,
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_corrections_field_idx ON field_corrections(field_id);

CREATE TABLE check_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id        uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  document_id      uuid REFERENCES documents(id) ON DELETE CASCADE,
  check_key        text NOT NULL,
  severity         check_severity NOT NULL,
  outcome          check_outcome NOT NULL,
  message          text NOT NULL,
  expected_cents   bigint,
  actual_cents     bigint,
  tolerance_cents  bigint,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX check_results_bundle_idx  ON check_results(bundle_id);
CREATE INDEX check_results_outcome_idx ON check_results(outcome, severity);

CREATE TABLE dispositions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_result_id   uuid NOT NULL UNIQUE REFERENCES check_results(id) ON DELETE CASCADE,
  kind              disposition_kind NOT NULL,
  note              text NOT NULL,
  dispositioned_by  uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worksheets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id         uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  tax_year          integer NOT NULL,
  mapping_version   text NOT NULL,
  generated_by      uuid NOT NULL REFERENCES users(id),
  xlsx_storage_key  text,
  pdf_storage_key   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worksheets_bundle_idx ON worksheets(bundle_id);

CREATE TABLE worksheet_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worksheet_id             uuid NOT NULL REFERENCES worksheets(id) ON DELETE CASCADE,
  line_ref                 text NOT NULL,
  line_label               text NOT NULL,
  sort_order               integer NOT NULL,
  total_cents              bigint,
  null_contributor_count   integer NOT NULL DEFAULT 0,
  contributor_count        integer NOT NULL DEFAULT 0,
  is_judgment_required     boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX worksheet_lines_uq ON worksheet_lines(worksheet_id, line_ref);

CREATE TABLE worksheet_contributions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worksheet_line_id  uuid NOT NULL REFERENCES worksheet_lines(id) ON DELETE CASCADE,
  document_id        uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_id           uuid REFERENCES extracted_fields(id),
  field_key          text NOT NULL,
  value_cents        bigint,
  was_corrected      boolean NOT NULL DEFAULT false,
  judgment_reason    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worksheet_contributions_line_idx ON worksheet_contributions(worksheet_line_id);

CREATE TABLE router_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id           uuid REFERENCES bundles(id) ON DELETE CASCADE,
  document_id         uuid REFERENCES documents(id) ON DELETE CASCADE,
  page_id             uuid REFERENCES pages(id) ON DELETE CASCADE,
  task_class          text NOT NULL,
  state               job_state NOT NULL DEFAULT 'queued',
  attempts            integer NOT NULL DEFAULT 0,
  last_error_code     text,
  last_error_message  text,
  retry_after         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX router_jobs_state_idx  ON router_jobs(state);
CREATE INDEX router_jobs_bundle_idx ON router_jobs(bundle_id);

CREATE TABLE purge_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  bundle_id    uuid,
  policy_days  integer NOT NULL,
  age_days     integer NOT NULL,
  storage_key  text,
  dry_run      boolean NOT NULL DEFAULT false
);
CREATE INDEX purge_log_at_idx     ON purge_log(at);
CREATE INDEX purge_log_bundle_idx ON purge_log(bundle_id);
