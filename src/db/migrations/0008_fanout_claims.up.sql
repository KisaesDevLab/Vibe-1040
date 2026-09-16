-- 0008 — stage fan-out claimed once; unchecked checkboxes need no span.
--
-- Under worker concurrency several layout jobs finish together, each observed "layout
-- complete", and each fanned extraction out again: every document re-extracted at full
-- inference cost, and the outcomes a reconcile had already read nulled back to "extracting…"
-- while its check results stayed on screen. The hand-off is now a conditional UPDATE on the
-- bundle, so exactly one job fans out per stage per run.
ALTER TABLE bundles ADD COLUMN extraction_fanout_at timestamptz;
ALTER TABLE bundles ADD COLUMN reconcile_fanout_at timestamptz;

-- An unchecked checkbox is `false` and has nothing on the page to cite: the absence of a
-- mark is not a span. It was a hard `every_field_has_spans` failure on every W-2 (box 13)
-- and every 1099 (CORRECTED). A checked box must still cite the mark or its label.
ALTER TABLE extracted_fields DROP CONSTRAINT extracted_fields_span_or_review;
ALTER TABLE extracted_fields ADD CONSTRAINT extracted_fields_span_or_review CHECK (
  cardinality(span_ids) > 0
  OR needs_review = true
  OR (value_cents IS NULL AND value_text IS NULL AND value_bool IS NULL)
  OR value_bool = false
);
