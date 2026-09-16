ALTER TABLE extracted_fields DROP CONSTRAINT extracted_fields_span_or_review;
ALTER TABLE extracted_fields ADD CONSTRAINT extracted_fields_span_or_review CHECK (
  cardinality(span_ids) > 0
  OR needs_review = true
  OR (value_cents IS NULL AND value_text IS NULL AND value_bool IS NULL)
);
ALTER TABLE bundles DROP COLUMN IF EXISTS reconcile_fanout_at;
ALTER TABLE bundles DROP COLUMN IF EXISTS extraction_fanout_at;
