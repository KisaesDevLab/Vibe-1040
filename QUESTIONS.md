# Vibe 1040 — QUESTIONS.md

Open items that must be answered rather than guessed. Blocking questions halt the phase
they gate. Non-blocking questions get a documented working assumption that can proceed,
but the assumption must be recorded so it can be revisited.

Answer format: append `**A:**` under the question with the date. Move resolved questions
to the Resolved section.

---

## Blocking

### Q1 — Primary stack confirmation
**Gates:** P0.

CLAUDE.md §12 assumes TypeScript for the API and review UI with BullMQ, matching Vibe
Filer, plus a Python sidecar worker for PyMuPDF, pdfplumber, and pypdfium2, with the queue
as the boundary between them.

Is that right for this repo, or is there a reason to go Python-primary given how much of
the pipeline is document processing? The split adds a language boundary at the most
active seam in the system, which is a real cost. Going Python-primary loses consistency
with the rest of the suite and the BullMQ pattern.

**A:**

---

### Q2 — Does `document.classify` accept page images?
**Gates:** P4.

The existing task class was built for T&B document naming, which suggests it takes a
filename and possibly extracted text, not a rasterized page. P4 needs page-image
classification.

If it is filename- or text-only, this becomes either a new task class
(`document.classify.page`) or an extension of the existing one — Router work either way,
and it needs to be added to the Router addendum before P4.

Check: the task class's request schema, and whether its provider adapters pass image
content blocks through.

**A:**

---

### Q3 — Is the Router's OpenAPI spec published and stable?
**Gates:** P3.

P3 generates the client from the spec. If no spec is published, either the Router needs to
emit one or this app hand-writes a client against documented endpoints — the latter being
worse, because the calling convention then drifts silently.

**A:**

---

### Q4 — What does the Router surface for per-field confidence?
**Gates:** P8 exit criteria, P11 confidence highlighting.

The review UI highlights low-confidence fields. That requires the Router to pass through
something usable — token logprobs, a provider-reported score, or nothing at all.

If nothing is available, P8 falls back entirely to multi-pass agreement as the confidence
signal, which works but costs N× inference per document and needs to be budgeted. Confirm
before P8 so the cost model is right.

**A:**

---

## Non-blocking, working assumption recorded

### Q5 — Retention windows
**Working assumption:** rasterized page images purge at 90 days, source documents and
extracted data at seven years, matching typical workpaper retention.

Both are configurable. Confirm against actual firm policy before P13, and confirm whether
Missouri imposes anything beyond the federal baseline.

**A:**

---

### Q6 — Storage backend default
**Working assumption:** local encrypted volume by default, B2 available by config
following the Filer pattern.

Given the on-prem Monett infrastructure and no cloud edge, local is probably right. B2
matters only if bundles need to survive host loss.

**A:**

---

### Q7 — Tolerance default
**Working assumption:** $1 per document for rounding on arithmetic checks.

Configurable per firm. The question is whether $1 is too tight for consolidated 1099
footing, where a package can accumulate rounding across many sections. May need a
per-check tolerance rather than a global one.

**A:**

---

### Q8 — Multi-pass count for agreement checking
**Working assumption:** N=2, escalating to N=3 only on disagreement.

Cheaper than a flat N=3. Depends on Q4 — if real confidence scores exist, multi-pass may
only be needed for fields below a threshold rather than universally.

**A:**

---

### Q9 — Does the worksheet need a state-tax section?
**Working assumption:** no, federal only in v1. W-2 box 17 and 1099 state withholding are
captured and reported as detail but do not roll up to state line references.

Missouri returns are the obvious next step. Confirm whether that belongs in v1 or a later
version — it changes the mapping table structure if it lands later.

**A:**

---

### Q10 — Bundle-level vs document-level review workflow
**Working assumption:** reviewer works a bundle start to finish in one session, with
progress saved.

The alternative is a work queue of individual flagged documents across all bundles, which
is more efficient at volume but loses the context of seeing a client's whole picture.
Probably a season-two question once real volume exists.

**A:**

---

## Resolved

_(empty)_
