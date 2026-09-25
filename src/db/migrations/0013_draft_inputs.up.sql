-- 0013 — what the preparer supplies, because no source document carries it (P18, CLAUDE.md §14).
--
-- §14 rule 5 already says that filing status and the age/blindness flags come from the reviewer
-- rather than from inference over a pile of forms, "which is the preparer making the
-- determination, and that is the right place for it". This extends the same arrangement to the
-- three largest remaining holes in a draft return — dependents, itemised deductions, and
-- business/farm/rental activity — so a draft is worth more than a wages-and-withholding check.
--
-- The app still computes nothing and decides nothing. Every figure here is typed by a person who
-- has already made the determination; nothing on these tables is ever inferred or defaulted.
--
-- Persisted rather than passed per request, which is the change from P17. Filing status used to
-- ride along on each call and land denormalised on draft_returns; a preparer would have had to
-- retype a Schedule C on every recompute. draft_returns.filing_status stays as the record of what
-- a particular run used — these tables are the editable state that produced it.
--
-- Four tables:
--
--   draft_inputs             one per bundle: filing status and the return-level flags
--   draft_input_dependents   one per dependent
--   draft_input_schedule_a   one per bundle: the itemised-deduction figures
--   draft_input_activities   one per business, rental property or farm
--
-- TWO THINGS TO NOTE, both of which are easy to get wrong:
--
-- 1. There is NO SSN COLUMN on dependents, and that is deliberate. The engine's dependents node
--    marks ssn/itin/atin optional, so a draft computes without one, and §7's posture is that a
--    taxpayer identification number is never written to this database in plaintext and never
--    forwarded. A dependent's TIN is no different from the taxpayer's. Do not add one.
--
-- 2. Every money column is a NULLABLE bigint of cents. A blank is not a zero (§5): an itemised
--    deduction line the preparer never touched must reach the engine as absent, not as 0, or the
--    distinction the whole app exists to preserve is destroyed at the last step.

CREATE TABLE IF NOT EXISTS draft_inputs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id              uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  -- single | mfs | mfj | hoh | qss. Text rather than a pg enum: the vocabulary is the engine's
  -- and changes per release, so it is validated against the node map at the boundary instead of
  -- being frozen into the database. Null until the preparer states one.
  filing_status          text,
  -- Determinations the preparer makes. All nullable, and nothing here is ever defaulted to
  -- false: "not stated" and "stated as no" are different answers, and a draft that guessed
  -- would be deciding.
  taxpayer_age_65_or_older  boolean,
  spouse_age_65_or_older    boolean,
  taxpayer_blind            boolean,
  spouse_blind              boolean,
  updated_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draft_inputs_bundle_uq UNIQUE (bundle_id)
);

CREATE TABLE IF NOT EXISTS draft_input_dependents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id              uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  -- Ordering is the preparer's, kept so the list does not reshuffle between edits.
  ordinal                integer NOT NULL DEFAULT 0,
  first_name             text NOT NULL,
  last_name              text NOT NULL,
  middle_initial         text,
  -- The engine requires a date of birth and a relationship; both are determinations about a
  -- real person and neither is derivable from a source document.
  dob                    date NOT NULL,
  -- son | daughter | stepchild | foster | sibling | stepsibling | halfsibling | grandchild |
  -- parent | stepparent | other. Verified by probe against engine 2.0.4, because the listing
  -- truncates the enum: niece, nephew, aunt, uncle and grandparent are REFUSED, though each can
  -- be a qualifying relative in law. Those land on `other`, and the app says so rather than
  -- mapping them silently.
  relationship           text NOT NULL,
  months_in_home         integer NOT NULL,
  -- Determinations the engine will accept but never compute for itself. Nullable, never
  -- defaulted: whether a child qualifies for the credit is exactly the sort of question §9
  -- refuses to answer, so it is asked of the preparer or left unstated.
  qualifying_child_for_ctc          boolean,
  disabled                          boolean,
  full_time_student                 boolean,
  taxpayer_provided_over_half_support boolean,
  dependent_on_another_return       boolean,
  gross_income_cents     bigint,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS draft_input_dependents_bundle_idx ON draft_input_dependents (bundle_id);

CREATE TABLE IF NOT EXISTS draft_input_schedule_a (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id              uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  -- Every one nullable. An untouched line is absent from the payload, not sent as zero (§5).
  medical_cents                  bigint,
  state_income_tax_cents         bigint,
  sales_tax_cents                bigint,
  real_estate_tax_cents          bigint,
  personal_property_tax_cents    bigint,
  other_taxes_cents              bigint,
  mortgage_interest_1098_cents   bigint,
  mortgage_interest_no_1098_cents bigint,
  points_no_1098_cents           bigint,
  investment_interest_cents      bigint,
  cash_contributions_cents       bigint,
  noncash_contributions_cents    bigint,
  contribution_carryover_cents   bigint,
  casualty_theft_loss_cents      bigint,
  other_deductions_cents         bigint,
  -- The preparer forcing a method is a determination, so it is asked rather than inferred. Null
  -- means "let the engine take the larger", which is the ordinary case.
  force_itemized                 boolean,
  force_standard                 boolean,
  updated_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draft_input_schedule_a_bundle_uq UNIQUE (bundle_id)
);

CREATE TABLE IF NOT EXISTS draft_input_activities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id              uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  ordinal                integer NOT NULL DEFAULT 0,
  -- schedule_c | schedule_e | schedule_f. The engine node this activity becomes.
  kind                   text NOT NULL,
  -- Summary entry, by decision: the engine requires only the identifying fields and a gross
  -- figure, so a preparer who already has the net from their own software types two numbers
  -- rather than eighty. Full per-line entry is a separate question if it is ever wanted.
  description            text NOT NULL,
  -- Schedule C wants a business code, F an agricultural activity code; E wants none.
  activity_code          text,
  -- cash | accrual | other. Required by C and F, unused by E.
  accounting_method      text,
  -- A determination, and one with real consequences for passive-loss treatment. Never inferred.
  material_participation boolean,
  -- Schedule E only: what kind of property, and the day counts that decide personal-use
  -- treatment. Text rather than an enum for the same reason as filing status.
  property_type          text,
  fair_rental_days       integer,
  personal_use_days      integer,
  -- Gross receipts (C), rents received (E), or sales (F). Nullable: a preparer part-way through
  -- entering an activity has not said it is zero.
  gross_cents            bigint,
  -- One lump, described. The engine takes an expense line with a description and an amount, so a
  -- summary is a legal payload rather than a workaround.
  expenses_cents         bigint,
  expenses_description   text,
  updated_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS draft_input_activities_bundle_idx ON draft_input_activities (bundle_id);
