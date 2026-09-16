-- 0007 — explicit stage completion, extraction outcomes, 1099-B sections, span cross-check.
--
-- Stage hand-offs used to be inferred from row existence: "layout is done when every page
-- has a span row", "extraction is done when no document is still `classified`". Both
-- inferences were wrong in ordinary cases. A blank page stores zero spans, so it never
-- looked done and the bundle sat at `extracting`. A cover letter is never extracted, so it
-- stayed `classified` and reconcile never ran. Every real client packet has at least one of
-- each. Completion is now recorded, never inferred.

-- Layout completion is a fact on the page row. Zero spans is a valid outcome.
ALTER TABLE pages ADD COLUMN layout_completed_at timestamptz;
ALTER TABLE pages ADD COLUMN span_count integer;
-- 'text_layer' when the sidecar measured exact word boxes from the PDF; 'model' when a
-- vision model estimated them. A reviewer should know which kind of box they are looking at.
ALTER TABLE pages ADD COLUMN layout_source text;

-- Backfill: a page that already has spans was laid out by a model.
UPDATE pages p
   SET layout_completed_at = now(),
       layout_source = 'model',
       span_count = s.n
  FROM (SELECT page_id, count(*)::int AS n FROM layout_spans GROUP BY page_id) s
 WHERE s.page_id = p.id;

-- Extraction outcome is a fact on the document row. Every exit path from extraction writes
-- one, including the paths that extract nothing, so "nothing left to do" is answerable.
--   extracted | skipped_supplemental | skipped_unclassified | no_schema | no_spans
ALTER TABLE documents ADD COLUMN extraction_outcome text;
ALTER TABLE documents ADD COLUMN extraction_completed_at timestamptz;

UPDATE documents SET extraction_outcome = 'extracted', extraction_completed_at = now()
 WHERE status = 'extracted';
UPDATE documents SET extraction_outcome = 'skipped_supplemental', extraction_completed_at = now()
 WHERE extraction_outcome IS NULL AND is_supplemental;
UPDATE documents SET extraction_outcome = 'skipped_unclassified', extraction_completed_at = now()
 WHERE extraction_outcome IS NULL AND form_type IS NULL;

-- 1099-B pages are split into one document per Form 8949 section (A–F) at classification,
-- so section subtotals can foot to the package summary (§6). The letter is recorded here.
ALTER TABLE documents ADD COLUMN section_code text;

-- A bound value that does not appear in the spans it cites is a misread, not a confidence
-- question. New review reason for it. (Enum values cannot be removed on rollback; the
-- leftover value is harmless.)
ALTER TYPE review_reason ADD VALUE IF NOT EXISTS 'span_mismatch';

-- A parked or failed router job that an operator sent back to the queue.
ALTER TYPE job_state ADD VALUE IF NOT EXISTS 'requeued';

-- The §4 constraint was written as "no span means review" but read as "every row needs a
-- span or a review flag", which a blank box — null value, no span, nothing to review —
-- also violates. The first real extraction would have failed on its first empty box. A
-- blank is allowed to cite nothing; a *value* still may not.
ALTER TABLE extracted_fields DROP CONSTRAINT extracted_fields_span_or_review;
ALTER TABLE extracted_fields ADD CONSTRAINT extracted_fields_span_or_review CHECK (
  cardinality(span_ids) > 0
  OR needs_review = true
  OR (value_cents IS NULL AND value_text IS NULL AND value_bool IS NULL)
);
