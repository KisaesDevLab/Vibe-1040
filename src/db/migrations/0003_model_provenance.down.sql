-- 0003 rollback.

ALTER TABLE pages DROP COLUMN IF EXISTS layout_coord_convention;
ALTER TABLE documents DROP COLUMN IF EXISTS classifier_request_id;
ALTER TABLE documents DROP COLUMN IF EXISTS classifier_model;
