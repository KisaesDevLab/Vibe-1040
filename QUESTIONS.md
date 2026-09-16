# Vibe 1040 — QUESTIONS.md

Open items that must be answered rather than guessed. Blocking questions halt the phase
they gate. Non-blocking questions get a documented working assumption that can proceed,
but the assumption must be recorded so it can be revisited.

Answer format: append `**A:**` under the question with the date. Move resolved questions
to the Resolved section.

---

## Blocking

### Q11 — When does Router region pinning (R6) land?
**Gates:** P14. **Raised:** 2026-08-26.

§11 requires the app to assert US-region pinning at startup and refuse to start otherwise.
**The Router has no region concept at all** — `grep -i region` across `src/`, `docs/`, and
`db/` in Vibe-AI-Router returns nothing. There is no region column on policy, no
enforcement at routing time, and no policy-reporting endpoint.

Per the 2026-08-26 decision these classes register `cloud_deidentified`, so the
"nothing leaves the box" argument does not apply — cloud binding is possible, and region
enforcement is the only thing standing between this app and non-US inference.

This is Router work, not app work. It must be scheduled in the Router repo and land before
P14 exits. Until it does, P14's exit criterion ("app refuses to start against a Router
reporting a non-US policy") cannot be met, because there is nothing to report.

**Partial answer, 2026-08-26 — the ticket is written and filed.**
`Vibe-AI-Router/docs/ticket-R6-region-pinning.md`, indexed in that repo's
`docs/router-option-addendum.md` backlog (numbered R6; R5 was already taken by the
preprocess-stage ticket). Proposed shape: `providers.region` declared by the operator,
`policies.requiredRegionPrefix` asserted per task class, enforced in `modelViolation`
alongside the existing `local_only` invariant — which means undeclared regions fail closed
and `policy_blocked` is never substituted around. Plus `GET /v1/policy/regions`, the
endpoint `src/router/client.ts` already probes. Estimated 3–4 days router-side, zero
app-side, because the caller is written.

It ships inert — every existing policy is unconstrained — so it can land any time without
disturbing the other appliances.

**Still open: when.** No decision is required, only scheduling. The forcing moment is not
this app's deployment but the moment a firm admin widens the three `v1040_*` classes to
`cloud_deidentified` in the router admin UI. Until then Vibe 1040 runs on local models and
nothing egresses. That widening step should carry a checklist item requiring this to be in
place first.

**Partial answer, 2026-09-02.** The widening happened. Q13 records the interim posture: the
assertion is disabled by decision for the DigitalOcean binding, and DigitalOcean serverless
inference itself offers no region control that R6 could assert against even once it lands.

**A:**

---

### Q12 — Does the WISP amendment cover unscrubbed page-image egress?
**Gates:** live client data. **Raised:** 2026-08-26.

`src/protect/scrub.ts:225` in the Router rewrites `type === 'text'` content parts only —
image parts are copied through verbatim. A `cloud_deidentified` class declaring
`vision: true` therefore egresses page images to a cloud provider with no scrubbing. The
Router records this as accepted exposure for `tb_doc_extract` and `mybooks_receipt_extract`
(Q-087).

Here the pixels are W-2s and 1099s, so the unscrubbed content includes SSNs, EINs, and full
account detail. The 2026-08-26 decision accepts that exposure rather than gating on Router
D7.

The WISP amendment drafted in P14 must therefore name page-image egress explicitly, not
just "inference through the Router." Confirm with whoever owns the WISP that this is
described accurately, and confirm the DigitalOcean DPA covers it.

**A:**

---

## Non-blocking, working assumption recorded

### Q13 — Is running without region enforcement acceptable for DigitalOcean-hosted open models?
**Working assumption:** yes, pending Router R6. **Raised:** 2026-09-02.

The three classes are bound to DigitalOcean-hosted open-source models (`glm-5.3-flash`,
`qwen3.5-397b-a17b`). DigitalOcean publishes no region selection for serverless inference
and the Router has no region report, so `assertUsRegionPinning` cannot pass and
`ROUTER_REQUIRE_US_REGION=false` is set for this deployment by recorded decision.

What DigitalOcean's data-privacy page states for DigitalOcean-hosted models (verified
2026-09-01): inputs and outputs are not stored on DigitalOcean infrastructure; the data is
not used to train, retrain, or fine-tune any model and is not shared with third parties for
that purpose; requests "run entirely within DigitalOcean's infrastructure"; input is never
sent to the original model creator. Anthropic models on DigitalOcean carry a mandatory 30-day
retention for Claude Fable, and OpenAI models on DigitalOcean serverless do not support zero
data retention — both are excluded from policy for that reason.

The working assumption is that those terms plus the executed DPA are sufficient for the
§7216 auxiliary-service treatment until R6 lands. Revisit the moment it does, and revisit if
DigitalOcean publishes a region control for serverless inference or the firm moves to
dedicated inference in a named US region.

**A:**

---

### Q17 — Where does geometry come from for a scanned page?
**Raised:** 2026-09-11. **Working assumption:** it does not, and those documents block.

The optional OCR fallback (`OCR_FALLBACK_ENABLED`) makes a page with no text layer *readable*
— `v1040_ocr_transcribe` returns prose — but not *provable*. Nothing the Router's `local_ocr`
kind can serve returns bounding boxes, so a field derived from a transcription carries
`span_ids: []`, which §6 makes a hard blocking failure. Every scanned document therefore stops
for disposition.

That is the honest behaviour and it needs no rule change, but it is not a finished answer for a
firm whose clients send phone photos. Three ways forward:

1. **A local engine that emits word boxes.** Pair a geometry source (an hOCR engine such as
   Tesseract) with the transcription model, using boxes from the first and text from the
   second. Keeps the provenance guarantee intact and keeps pixels on the appliance. Most work.
2. **Distinct provenance, soft failure.** Mark transcription-derived fields and make their
   missing spans annotate and force review rather than block, leaving §6 hard everywhere else.
   Ships soonest; needs a §6 decision entry and is a real weakening.
3. **Leave it.** Scanned pages block and a reviewer dispositions them. Correct today, and
   tolerable only while scans are rare.

Note the text-layer case needs none of this. PyMuPDF returns exact words *and* exact boxes for
a native digital PDF, which is the deferred sidecar-geometry work (decision log 2026-09-02) and
strictly better than any model for those pages.

**Partial answer (2026-09-16):** the text-layer case is built. The sidecar now measures exact
spans for every `text_layer` page and the vision layout pass runs only for raster pages. Scanned
pages still take option 3 — they get a model's boxes, or, with transcription only, they block.

### Q16 — Is SSA-1042S in scope, and what happens to an unregistered form type?
**Raised:** 2026-09-10. **Answered and closed 2026-09-10.** Both parts.

**A (scope):** in scope. `SSA-1042S` is registered for TY2025 as `allJudgmentRequired`, boxes
as printed, with no line mapping — see §8 and the decision log.

**A (the real one):** the classifier now separates "not a form" from "a form I cannot name".
`unrecognised_form` is its own output, its own column on `documents`, and its own **hard**
check, so an unregistered or unreadable tax document blocks the worksheet until a human reads
the page. It is also carried onto the finished worksheet as an annotation once dispositioned,
because the amounts on that page were never extracted and a worksheet that omits them without
saying so is the failure this was raised about.

The prompt resolves ambiguity toward surfacing: told to guess, the classifier flags. A page
wrongly surfaced costs a reviewer seconds; a tax document wrongly filed as a cover letter is
money missing with nothing on screen to say so.

**Consequence accepted:** classifier misfires now block rather than pass silently. That is the
intended direction of failure for this app and matches §6's existing posture, but it does mean
worksheet throughput depends on classification quality — which is still unmeasured (see the
accuracy harness and the note in STATE.md). If misfires prove common in practice, the answer
is to fix classification, not to soften this check.

Two of five sample client packets (Henning, Hoffmann) open with **SSA-1042S**, the Social
Security benefit statement issued to nonresident aliens. §8 lists SSA-1099 and RRB-1099 and
not SSA-1042S; there is no `ssa-1042s.json` in `data/form-schemas/ty2025/`, so the classifier
has no valid label for the page.

Neither outcome available today is acceptable:

- Classified `form_type: null, is_supplemental: true` — the page is treated as a cover sheet
  and its benefit amounts never reach the worksheet. A **silent omission**, which is the one
  failure this product exists to prevent.
- Classified as SSA-1099 — the wrong schema binds. 1042S reports gross benefits and tax
  withheld under a different box structure, so fields bind to the wrong boxes or come back
  with no spans, which is a blocking hard failure (§6).

Two separable questions:

1. **Scope.** Add SSA-1042S as a registered form type? It is a real form for a real client
   population, and like SSA-1099 its taxable portion is a Judgment Required item (§9), not a
   computation. Adding it is a §8 scope change and needs a decision entry.
2. **Safety, regardless of 1.** A page the classifier cannot label is currently
   indistinguishable from a genuine cover sheet. There should be a third outcome — an
   *unrecognised form* that lands in Judgment Required with its page attached — so an
   unknown tax document is surfaced rather than dropped. That is arguably a bug in the
   current design rather than a scope change, since §5's refusal to treat blank as zero
   rests on the same principle.

### Q15 — Should MFA be conditional on a delivery channel being configured?
**Raised:** 2026-09-10. **Working assumption:** no. MFA stays mandatory.

Asked directly: only require a second factor once an administrator has enabled a way to
*send* one. Raising it rather than implementing it, because "MFA remains mandatory and
cannot be switched off" is a locked decision (STATE.md, 2026-08-26) and MFA on staff
accounts is a GLBA Safeguards obligation this repo owns (§11). Making it conditional on
SMTP or SMS would mean a fresh deployment runs on a password alone, and a deployment that
never configures email never gets a second factor at all.

The request was prompted by a real defect, now fixed: an unenrolled authenticator was
reported as an *unusable* factor, so the first sign-in on every fresh deployment hit
"Second factor unavailable — ask a firm administrator", shown to the only administrator
there was. Enrolment is self-service and needs no delivery channel, so nothing had to be
sent for MFA to be satisfiable. The premise that a send method is a prerequisite was
therefore wrong.

What changed instead, which is believed to satisfy the underlying need:

- An unenrolled authenticator is usable. It routes to enrolment, not to a dead end.
- Email and SMS report unusable until the firm has actually configured that channel, so a
  factor is never offered that cannot be delivered.
- When the assigned factor cannot be delivered and the firm permits authenticators, the
  sign-in offers authenticator enrolment instead of an error, and makes it that user's
  factor once verified.

**Answer if this is still wanted:** it needs a decision-log entry naming the GLBA position
and an amendment to §11, not an implementation choice. A middle option exists if the
concern is lockout rather than policy: a break-glass admin path that resets a user's factor
from the appliance console, which the emergency-access addendum already contemplates.

### Q14 — Can `v1040_layout` ever be bound `local_only`?
**Working assumption:** not as written. **Raised:** 2026-09-02.

CLAUDE.md §4 originally said the local layout model is GLM-OCR via the Router's `local_ocr`
provider kind. GLM-OCR's documented modes (`Text Recognition:`, `Table Recognition:`) return
text and Markdown tables with no coordinates, and the Router's OpenAI-compat adapter would
pass the app's `json_schema` through to llama-server, which would grammar-force a 0.9B OCR
model to invent a spans array. That is the failure §4 exists to avoid.

A local path therefore needs a geometry source that measures pixels — PyMuPDF words for
text-layer PDFs, an hOCR-style engine for scans — built in the sidecar, with any OCR model
used for text quality only. That is a redesign, not a binding change, and it was considered
and deferred on 2026-09-02 in favour of the DigitalOcean vision binding. Until it is built,
the local-only configuration the runbook mentions does not produce span geometry.

**A:**

---

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

Resolved Q4 makes this the *only* confidence signal available — the Router surfaces no
per-token or per-field confidence. Multi-pass cannot be narrowed to fields below a
threshold, because there is no threshold to compare against. Budget accordingly: every
field extraction costs at least 2× inference.

**A (2026-09-16):** The premise was wrong. Two passes of the same prompt at temperature 0
against the same model agree whether or not they are right, so the second pass measured
nothing and doubled the cost. The confidence signal is now **verification**: every bound
value is checked against the text of the spans it cites and flagged `span_mismatch` when it
is not there. `EXTRACT_PASSES` defaults to 1. A second pass, when configured, runs at
`EXTRACT_SECOND_PASS_TEMPERATURE` (0.4) and optionally against `EXTRACT_SECOND_PASS_MODEL`, so
that disagreement is between different readings. Escalation on disagreement is unchanged.

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

### Q1 — Primary stack confirmation
**Gated:** P0.

CLAUDE.md §12 assumed TypeScript for the API and review UI with BullMQ, matching Vibe
Filer, plus a Python sidecar worker for PyMuPDF, pdfplumber, and pypdfium2, with the queue
as the boundary between them. The alternative was Python-primary, given how much of the
pipeline is document processing.

**A:** 2026-08-26 — **TypeScript primary with a Python sidecar, as assumed.** Confirmed by
the Router integration contract: `@kisaes/vibe-ai-client` is a TypeScript SDK and the wire
contract is semver-major frozen, so a Python-primary build would hand-roll a client against
a frozen contract and drift silently — the exact failure mode Q3 warned about. The sidecar
keeps PyMuPDF, pdfplumber, and pypdfium2 where they belong. The language boundary at the
queue is an accepted cost. **P0 is unblocked.**

---

### Q2 — Does `document.classify` accept page images?
**Gated:** P4.

**A:** 2026-08-26 — **The question was malformed; there is no `document.classify`.** Router
task classes are runtime data in the `task_classes` table, not code enums, and the key
convention is `<app>_<purpose>` (`tb_classification`, `tb_doc_extract`, `v1099_w9_extract`)
— not dotted names. Apps **self-register** their own classes at startup via
`registerTaskClasses()`; registration is idempotent and version-stamped, and never changes
an existing class's sensitivity.

So this app registers its own classes and inherits nothing:

| key | requires | purpose |
|---|---|---|
| `v1040_page_classify` | `vision`, `json_schema` | page-level form-type classification (P4) |
| `v1040_layout` | `vision` | layout pass — spans with geometry (P7) |
| `v1040_field_extract` | `json_schema` | field binding from spans + schema (P8) |

No Router work is required to create these. Precedent exists: `tb_doc_extract`,
`mybooks_receipt_extract`, and `v1099_w9_extract` are live vision classes today.

Note the registration default: a class the Router has never seen is created **`local_only`
regardless of what the app requests**. Widening to `cloud_deidentified` is a deliberate,
audited firm-admin action — not something this app can do for itself.

---

### Q3 — Is the Router's OpenAPI spec published and stable?
**Gated:** P3.

**A:** 2026-08-26 — **No spec exists, and none is needed.** There is no OpenAPI document
anywhere in the Router repo. Instead the Router ships a first-party TypeScript SDK,
`@kisaes/vibe-ai-client` (`packages/sdk`), and `docs/integration.md` is a **frozen contract
(Phase 12)**: endpoints, headers, error codes, and envelope semantics are semver-major
frozen, with a one-minor-release deprecation window and the SDK following the Router's
major version.

P3 therefore **depends on the SDK rather than generating a client**. There is no
`src/router-client/` directory and no codegen step. The silent-drift failure mode Q3
worried about does not arise.

---

### Q4 — What does the Router surface for per-field confidence?
**Gated:** P8 exit criteria, P11 confidence highlighting.

**A:** 2026-08-26 — **Nothing.** There is no logprobs plumbing in the Router;
`src/gateway/openai-shape.ts:58` hardcodes `logprobs: null`. No provider-reported score is
passed through either.

P8 falls back entirely to multi-pass agreement as the confidence signal, per Q8. P11's
"confidence highlighting" therefore means "fields where passes disagreed," not a calibrated
model score — the UI copy should say so rather than implying a confidence percentage. Cost
model: at least 2× inference per field extraction.
