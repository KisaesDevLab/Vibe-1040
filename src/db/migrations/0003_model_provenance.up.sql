-- 0003 — provenance for the two model decisions that had none (P4, P7).
--
-- Spans and extracted fields already record which model produced them. The classifier is
-- the one model decision with no trace, and it is the decision that selects the schema for
-- everything downstream. The layout pass records which coordinate convention the serving
-- model actually returned, so a policy swap that changes convention is visible in the data
-- rather than discovered in the overlay.

ALTER TABLE documents ADD COLUMN classifier_model text;
ALTER TABLE documents ADD COLUMN classifier_request_id text;

-- 'fraction' | 'thousandths' | 'pixel'. Null until the layout pass runs for the page.
ALTER TABLE pages ADD COLUMN layout_coord_convention text;
