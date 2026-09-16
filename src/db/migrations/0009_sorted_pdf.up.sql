-- 0009 — the bookmarked, return-ordered PDF of a bundle's source pages.
--
-- Built on demand by the sidecar from the stored source files, one bookmark per document,
-- grouped the way the return is laid out. It is derived taxpayer data made of the source
-- pages themselves, so it is tracked here and purged with the rasters (§11): regenerable
-- while the sources exist, and never left behind after them.
ALTER TABLE bundles ADD COLUMN sorted_pdf_storage_key text;
ALTER TABLE bundles ADD COLUMN sorted_pdf_at timestamptz;
