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
