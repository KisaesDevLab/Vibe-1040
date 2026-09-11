-- 0006 — optional OCR transcription for pages with no text layer (§4, P7).
--
-- A rasterized page — a scan, a phone photo — carries no text the sidecar can read, so the
-- only thing that ever saw its contents was the vision model doing the layout pass. When the
-- optional OCR fallback is enabled, a dedicated task class transcribes the page first and the
-- result lands here.
--
-- Deliberately NOT stored in `text_layer`. That column means "text the PDF itself carried",
-- which is exact and came from no model. This one means "text a model believed it saw", which
-- is neither. Collapsing them would destroy the distinction at the moment a reviewer most
-- needs it, and would let a footing check treat a transcription as ground truth.
--
-- No geometry. GLM-OCR and every other OCR model the `local_ocr` kind can serve return text
-- or Markdown tables and no boxes, so a field derived from this has no span to point at and
-- §6's provenance rule still applies in full.

ALTER TABLE pages ADD COLUMN ocr_text text;
ALTER TABLE pages ADD COLUMN ocr_model text;
ALTER TABLE pages ADD COLUMN ocr_request_id text;
ALTER TABLE pages ADD COLUMN ocr_at timestamptz;
