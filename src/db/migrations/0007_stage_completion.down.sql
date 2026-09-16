ALTER TABLE extracted_fields DROP CONSTRAINT extracted_fields_span_or_review;
ALTER TABLE extracted_fields ADD CONSTRAINT extracted_fields_span_or_review CHECK (
  cardinality(span_ids) > 0 OR needs_review = true
);
ALTER TABLE documents DROP COLUMN IF EXISTS section_code;
ALTER TABLE documents DROP COLUMN IF EXISTS extraction_completed_at;
ALTER TABLE documents DROP COLUMN IF EXISTS extraction_outcome;
ALTER TABLE pages DROP COLUMN IF EXISTS layout_source;
ALTER TABLE pages DROP COLUMN IF EXISTS span_count;
ALTER TABLE pages DROP COLUMN IF EXISTS layout_completed_at;
-- Postgres cannot drop enum values. 'span_mismatch' and 'requeued' remain unused.
