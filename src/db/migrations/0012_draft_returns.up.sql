-- 0012 — draft returns computed by the OpenTax engine (P17, CLAUDE.md §14).
--
-- A draft return is derived taxpayer data, like a rasterized page or the sorted PDF: it is
-- regenerable from the documents, it must purge on the retention schedule, and it must never
-- outlive the sources it came from (§11). It is tracked here rather than kept in memory so a
-- reviewer can reopen the one they looked at, and so a purge has something to delete and log.
--
-- Four things are stored, and the reason for each is the reason the feature is defensible:
--
--   draft_returns             the run: which engine, which node map, whether it is complete
--   draft_return_lines        computed beside reported, with the verdict, so a disagreement
--                             is a record rather than a screen a reviewer had open once
--   draft_return_omissions    everything withheld, and why. This is the omissions contract
--                             made durable — an incomplete draft that cannot say what it is
--                             missing is the failure mode the whole design avoids
--   draft_return_validations  the engine's own MeF business-rule diagnostics
--
-- `complete` is deliberately NOT a computed column: it is written by the app from the
-- translator's own verdict, so that a later change to what counts as an omission cannot
-- silently re-characterise a draft somebody already read.

CREATE TABLE IF NOT EXISTS draft_returns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id          uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  tax_year           integer NOT NULL,
  -- Provenance. A draft is only meaningful against the versions that produced it.
  engine_version     text NOT NULL,
  node_map_version   text NOT NULL,
  mapping_version    text NOT NULL,
  -- What the reviewer stated, because no document carries it (§14 rule 5).
  filing_status      text,
  -- False whenever anything at all was withheld. Never presented as a finished return.
  complete           boolean NOT NULL DEFAULT false,
  documents_included integer NOT NULL DEFAULT 0,
  documents_withheld integer NOT NULL DEFAULT 0,
  -- The engine's own summary, kept verbatim so a later reading is not limited to the lines
  -- this app happened to map at the time.
  engine_summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_by       uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_returns_bundle_idx ON draft_returns (bundle_id);

CREATE TABLE IF NOT EXISTS draft_return_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_return_id  uuid NOT NULL REFERENCES draft_returns(id) ON DELETE CASCADE,
  -- This app's worksheet line ref ('1040:1z'), or NULL for an engine figure the worksheet has
  -- no counterpart for at all (AGI, taxable income, total tax, refund).
  line_ref         text,
  line_label       text NOT NULL,
  sort_order       integer NOT NULL DEFAULT 0,
  engine_form      text NOT NULL,
  engine_line      text NOT NULL,
  -- Both sides nullable, and for the same reason every money column in this schema is: a
  -- blank is not a zero (§5). Null here means that side reported nothing.
  reported_cents   bigint,
  computed_cents   bigint,
  -- 'agrees' | 'differs' | 'engine_silent' | 'worksheet_silent' | 'both_blank' |
  -- 'computed_only'. Text rather than an enum: the app's TypeScript cannot use TS enums
  -- (--experimental-strip-types), and a new verdict should not need a migration.
  verdict          text NOT NULL,
  -- Why a disagreement on this line may be expected rather than a defect.
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- A line ref appears at most once per draft; engine-only figures are keyed by engine line.
  CONSTRAINT draft_return_lines_uq UNIQUE (draft_return_id, engine_form, engine_line)
);
CREATE INDEX IF NOT EXISTS draft_return_lines_draft_idx ON draft_return_lines (draft_return_id);

CREATE TABLE IF NOT EXISTS draft_return_omissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_return_id  uuid NOT NULL REFERENCES draft_returns(id) ON DELETE CASCADE,
  -- Null for something no document could carry — filing status, basis, carryovers.
  document_id      uuid REFERENCES documents(id) ON DELETE CASCADE,
  form_type        text,
  field_key        text,
  -- 'judgment_required' | 'all_judgment_required' | 'form_type_unmappable' | 'needs_review'
  -- | 'no_spans' | 'engine_required_field_blank' | 'negative_amount' | 'not_in_bundle'
  -- | 'engine_rejected'
  reason           text NOT NULL,
  detail           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_return_omissions_draft_idx ON draft_return_omissions (draft_return_id);

CREATE TABLE IF NOT EXISTS draft_return_validations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_return_id  uuid NOT NULL REFERENCES draft_returns(id) ON DELETE CASCADE,
  -- 'hard' | 'soft', as the engine's own report separates them. This app reads these; it
  -- never emits MeF XML and never files anything.
  severity         text NOT NULL,
  code             text NOT NULL,
  message          text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_return_validations_draft_idx ON draft_return_validations (draft_return_id);
