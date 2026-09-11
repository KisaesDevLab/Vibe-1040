-- 0004 — bulk upload, and bundles that name themselves after the taxpayer (P1, P5).
--
-- Bulk upload creates one bundle per file, so a label can no longer be typed per bundle:
-- forty packets would mean forty prompts. The label is derived from the filename at upload
-- and replaced with the primary taxpayer's name once identity is proposed.
--
-- That replacement must never overwrite a label a human chose, which is what this column
-- records. True means "nobody has named this, the app may rename it". Any edit by a person
-- clears it permanently. Existing rows are false: every label already in the table was
-- either typed by a reviewer or is the old date-stamped default, and silently renaming
-- those on the next identity pass would be a surprise.

ALTER TABLE bundles ADD COLUMN label_auto boolean NOT NULL DEFAULT false;
