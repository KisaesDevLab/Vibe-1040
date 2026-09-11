-- 0005 — a tax document the classifier cannot name must stay visible (P4, P9, §6, §9).
--
-- `form_type IS NULL` meant two different pages: a cover letter, and a tax form that is not
-- in the registry or could not be read. The reconciliation pass skipped both, so an
-- unregistered form was dropped in silence and nothing on the worksheet said a page had been
-- ignored. That is the failure this product exists to prevent, and it was found in a real
-- client packet: an SSA-1042S sitting at the front of a bundle.
--
-- The classifier now separates the two and this column records the answer. A true here
-- raises a blocking check, so the bundle cannot produce a worksheet until a human has looked
-- at the page and dispositioned it.

ALTER TABLE documents ADD COLUMN unrecognised_form boolean NOT NULL DEFAULT false;
