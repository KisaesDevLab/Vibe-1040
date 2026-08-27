# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Working name: **Vibe 1040**. Repo `vibe-1040`. Distributed via GHCR alongside the rest
of the Vibe suite. Rename freely; the slug appears only in compose service names and the
image path.

---

## 0. Start here

**This repo currently contains no code.** It is four planning documents plus this file,
with no commits on `main`. The build has not started.

Read in this order before doing anything:

1. **STATE.md** — the single source of truth for where the build stands. Current position,
   phase ledger, external dependencies, locked decisions, known risks, fixture inventory.
   Do not infer progress from the commit log. Update it at the close of every phase and
   whenever a blocking condition changes.
2. **PHASES.md** — P0 through P15, each with its dependency, deliverable, and exit
   criteria. A phase is not complete until its exit criteria are demonstrably met.
3. **QUESTIONS.md** — open items. Blocking questions halt the phase they gate; non-blocking
   ones carry a recorded working assumption. Answer with `**A:**` and a date, then move to
   Resolved.
4. **vibe-ai-router-PHASES-addendum.md** — R1–R5, work that belongs to the Vibe AI Router
   repo, not this one. **Largely historical as of 2026-08-26** — most of it already shipped
   or turned out not to be Router work. STATE.md's External dependencies table supersedes
   it. Only region pinning (R5) is still real, and it gates P14.

Working rules:

- **Raise, do not guess.** Anything ambiguous or out of scope becomes a QUESTIONS.md entry
  rather than an implementation choice. §2 boundaries specifically require this.
- **P0 is blocked on Q1** (stack confirmation). P0–P6 are Router-independent and can run
  while the Router addendum is in flight; P7 is the first hard gate on external work.
- Decisions in STATE.md's "Decisions locked" are settled. Changing one requires an entry
  in the decision log, not a silent implementation choice.
- Conventional commits.

## Commands

None yet — P0 establishes the Docker Compose stack, migration tooling, and CI. Record the
build, test, lint, single-test, and migration commands in this section as part of P0's
close, so later phases do not have to rediscover them.

---

## 1. What this is

A staff-facing appliance that ingests a client's 1040 source-document bundle, reads the
dollar amounts off each form, and emits a **standardized worksheet of totals keyed to
Form 1040 and schedule line numbers**. A preparer opens the worksheet next to the
prepared return and eyeball-compares.

## 2. What this is explicitly NOT

These are hard scope boundaries. Do not build toward them, do not leave hooks for them,
and raise a QUESTIONS.md entry before adding anything in these directions.

- **Not a diff engine.** The app never ingests the prepared return. No MeF XML parsing,
  no UltraTax / Lacerte / CCH / GoSystem export ingestion, no automated reconciliation
  against a return. The human does the comparison.
- **Not a client portal.** Upload is staff-only, from inside the firm. No client accounts,
  no client-facing auth, no consent-collection UI, no E2EE intake. Vibe Connect owns that
  surface; this app does not duplicate it.
- **Not a tax calculation engine.** The app does not compute taxable Social Security, does
  not apply the §121 exclusion, does not compute QBI. It reports what the documents say
  and, where a box does not map cleanly to a line, it says so and stops.
- **Not multi-tenant.** Single firm per deployment.
- **Not a model host.** All inference goes through Vibe AI Router. This app holds no
  provider credentials of any kind.

## 3. Integration boundary: Vibe AI Router

The app is a **client of the Vibe AI Router SDK**, against a separately deployed Router
instance. The Router keeps the firm-owned key model, the task-class policy engine, the
scrubber, and the local-default / cloud-opt-in routing. This app inherits all of it and
holds none of it.

**This section was verified against Vibe-AI-Router at v0.0.24 on 2026-08-26.** The
authority is that repo's `docs/integration.md`, which is a **frozen contract (Phase 12)** —
endpoints, headers, error codes, and envelope semantics are semver-major frozen. Read it
before writing any Router-facing code; do not re-derive the contract from this summary.

Rules:

- **Use the SDK, `@kisaes/vibe-ai-client`.** There is no OpenAPI spec and no codegen step;
  there is no `src/router-client/` directory. The SDK follows the Router's major version.
- Never call a provider directly. No DigitalOcean SDK, no `inference.do-ai.run` string,
  no Anthropic SDK, no Ollama URL, no direct call to the GLM-OCR llama-server on port 8090
  anywhere in this repo. A grep for provider hostnames in CI should return nothing outside
  of documentation.
- Config is `VIBE_AI_ROUTER_URL` and `VIBE_AI_TOKEN` — the suite-wide names, not
  `ROUTER_BASE_URL` / `ROUTER_TOKEN`. The URL is the internal Docker network address
  (`http://vibe-ai-router:8220`), never routed through Caddy. There is no fallback path if
  the Router is unreachable — jobs park in a retry queue and the UI says the Router is down.
- **Handle errors by taxonomy code, not HTTP status.** `scrubber_blocked` and
  `policy_blocked` are never retried; `rate_limited` and `provider_unavailable` are
  retryable and honor `retryAfterSeconds`; `capability_missing` and `invalid_request` are
  app bugs and must log loudly.
- `model` is advisory. **Policy decides what serves**, so handle any model's output shape.

### Task classes

Task classes are **runtime data**, not Router code, and this app registers its own at
startup via `registerTaskClasses()` — idempotent and version-stamped. The key convention is
`<app>_<purpose>`; dotted names like `document.layout` are not how the Router names things
and were never real. Nothing is inherited from T&B or any other app.

| key | requires | phase |
|---|---|---|
| `v1040_page_classify` | `vision`, `json_schema` | P4 — page-level form-type classification |
| `v1040_layout` | `vision` | P7 — spans with page-relative geometry |
| `v1040_field_extract` | `json_schema` | P8 — binds schema fields to span IDs |

Two-pass extraction (§4) is **built app-side as two task classes and two round trips**. Do
not wait on the Router's proposed preprocess stage that would fuse them; if it lands, this
app can migrate to it later.

Sensitivity: these register **`cloud_deidentified`**. Note the Router's registration
default — a never-before-seen class is created `local_only` regardless of what the app
asks for, and widening is a deliberate, audited firm-admin action. The app cannot widen
itself, so provisioning must include that step or every class stays pinned local.

**Accepted exposure, decided 2026-08-26:** the Router's scrubber rewrites text content
parts only (`src/protect/scrub.ts:225`); image parts pass through verbatim. A
`cloud_deidentified` vision class therefore egresses page images unscrubbed, and here those
pixels carry SSNs and EINs. This is accepted rather than gated on the Router's image-scrub
work. It must be named explicitly in the WISP amendment — see QUESTIONS.md Q12.

### Image transport

**Base64 inline in the request body.** Not presigned URLs, not Router-pulls-from-storage.

Presigned URLs would put a page of taxpayer return information behind a briefly-public
URL that a cloud provider reaches back to fetch, which is a control the firm then has to
justify in the WISP. It also breaks the local path, since vibellm behind Cloudflare
Tunnel is not reachable the way DigitalOcean is, and the entire value of the Router
envelope is that one request works against either provider.

Consequences to respect at the rasterizer:

- Grayscale JPEG for scans, not PNG. PNG only where the source is already lossless and
  small.
- Downscale to the capability matrix's declared resolution ceiling for the target
  provider before encoding. Do not send a 600 DPI page to a model that will downsample it
  anyway.
- One page per request. Do not batch pages into a single call.
- Budget roughly 800 KB encoded for a 300 DPI letter page. **Verified 2026-08-26:** the
  Router's `ROUTER_MAX_BODY_BYTES` already defaults to 10 MiB, comfortably above that, so
  no limit raise is needed — confirm the deployed value at P7 rather than assuming it.

The envelope already carries this natively: it accepts `image_url` content parts, and the
adapters translate a `data:` URI into each provider's native form — a base64 `image` block
for Anthropic, `image_url` passthrough for OpenAI-compatible providers. No Router work is
required for image transport.

**Never use DigitalOcean's Files API** for any part of this pipeline. It has a separate
retention model and is not auto-purged.

## 4. Two-pass extraction

A general VLM asked to emit JSON will produce plausible field values and untrustworthy
coordinates. Because the review UI requires bounding-box overlay, extraction is split:

1. **Layout pass** (`v1040_layout`) — a document-OCR model that emits geometry natively.
   Locally that is GLM-OCR, reached through the Router's `local_ocr` provider kind, never
   called directly. Output is text spans with page-relative boxes. Store this verbatim; it
   is the provenance substrate. Normalize the coordinate convention on receipt and record
   which model produced each span set — policy decides what serves, so a provider swap must
   be detectable rather than silent.
2. **Field-binding pass** (`v1040_field_extract`) — takes the layout output plus
   the registered schema for the classified form type and binds schema fields to spans.
   Every emitted field carries `span_ids`, so every number on the worksheet traces to
   pixels without the model ever being asked to invent a coordinate.

A field the binder cannot tie to a span is emitted with `span_ids: []` and is
automatically routed to review regardless of confidence.

## 5. Blank is not zero

Extraction emits `null` for an empty box and `0` only where the form literally prints a
zero. This distinction drives whether the worksheet flags an omission, and collapsing it
destroys the tool's main value. Every schema field is nullable. No default-to-zero
anywhere in the pipeline, including in the aggregation layer — a line total sums the
non-null values and separately reports how many contributing documents were null.

## 6. The arithmetic gate is blocking

Reconciliation checks are not advisory. A bundle with a hard failure does not produce a
worksheet until a human dispositions the failure. Soft failures annotate the worksheet
and proceed.

Hard failures (block):

- W-2 box 4 exceeds box 3 × 6.2% beyond rounding tolerance.
- W-2 box 3 exceeds the tax-year Social Security wage base (2025: $176,100.
  2026: $184,500).
- W-2 box 6 is not reconcilable to box 5 × 1.45% plus 0.9% on the excess over $200,000.
- 1099-B section subtotals do not foot to the package summary page.
- 1095-A monthly rows do not sum to the annual totals row.
- A consolidated 1099's sub-form totals do not tie to its summary.
- Any field with `span_ids: []`.

Soft failures (annotate):

- W-2 box 1 differs from boxes 3 and 5 — legitimate via 401(k), §125, group-term life,
  or excess deferrals, but worth surfacing.
- 1099-R box 2a blank with "taxable amount not determined" checked.
- Distribution code implausible against the payee's age where a DOB is available.
- Document tax year differs from the bundle's majority year.

Tolerance is $1 per document for rounding, configurable per firm. Do not silently widen
it.

## 7. Identity resolution

There is no client master. Client and tax year are **proposed from the bundle and
confirmed by the reviewer** before extraction results are committed.

- Join key is a **salted hash of the TIN**, per-deployment salt held in the app's secret
  store. Plaintext SSNs are never written to the database.
- Only the last four digits are stored in plaintext, for display.
- Name matching is a tiebreaker, never the key. The W-2 says ROBERT J SMITH, the
  brokerage says SMITH FAMILY TRUST, and a joint return has two TINs with documents
  split unevenly between them. Expect and handle multiple TINs in one bundle.
- Tax year: detect per document, take the bundle majority, flag every mismatch. A
  prior-year 1098 or an off-year 5498 in the pile is a real preparer error this catches.

Consequences accepted for v1: no prior-year comparison column until a second season of
data exists, and duplicate-bundle detection is content-hash only.

## 8. Form scope

All registered form types ship in v1 with one exception in how K-1s are handled.

W-2, W-2G, 1099-INT, 1099-OID, 1099-DIV, 1099-B and consolidated packages, 1099-R,
1099-MISC, 1099-NEC, 1099-K, 1099-G, 1099-S, 1099-SA, 1099-Q, 1099-LTC, SSA-1099,
RRB-1099, 1098, 1098-E, 1098-T, 1095-A, 5498, 5498-SA, and K-1 (1065, 1120-S, 1041).

**K-1 v1 scope is boxes-as-printed only.** No line dispersion onto the worksheet. A 1065
K-1 puts the numbers that matter in lettered sub-codes and footnote statements rather
than the boxes, box 20 code Z routinely points to a separate §199A statement with its own
layout, and there is no standardized rendering across UltraTax, CCH, and Lacerte output.
Extract the printed boxes, attach the footnote pages to the worksheet unparsed, and let
the preparer read them. Sequence K-1 work last (Phase 15) so it cannot delay the rest.

## 9. Where a box does not map cleanly

The worksheet has a **Judgment Required** section. Items land there rather than being
guessed at:

- 1099-B rows with missing or noncovered basis, wash sale adjustments, or corporate-action
  basis questions.
- 1099-R with taxable amount not determined, or code G rollovers.
- 1099-K where business vs personal-item character is undetermined.
- SSA-1099 and RRB-1099 — gross benefits are reported, taxable portion is not computed.
- 1098-T — payments received vs qualified expenses, scholarship netting.
- 1099-G box 2 state refunds, which depend on prior-year itemization.
- 1099-S, which depends on the §121 exclusion.
- Every K-1 in v1.

## 10. Tax-year versioning

Line-number mappings live in versioned per-tax-year tables, not in code. TY2025 brings
Schedule 1-A (tips, overtime, car-loan interest, enhanced senior deduction) totaling to
Form 1040 line 13b, and the 1099-K threshold reverting to $20,000 / 200 transactions.
TY2026 brings the 1099-NEC and 1099-MISC threshold rise to $2,000 and Form 1099-DA for
digital-asset broker proceeds. Expect a mapping table update every season and make that a
data change, not a code change.

Gross wages including tips and overtime still report on line 1z matching the W-2 — the
new deductions are below-the-line on Schedule 1-A. The worksheet reports what the W-2
says and does not attempt the deduction.

## 11. Compliance posture

The app performs data capture only and makes no substantive determinations about filing
status, income characterization, deductions, or credits. That keeps inference within the
auxiliary service provider treatment under Treas. Reg. §301.7216-2(d), which does not
require written taxpayer consent — but only while processing stays inside the US.

- The Router must enforce US-region pinning for any task class this app calls. This app
  asserts at startup that the Router reports a US-pinned policy for `v1040_page_classify`,
  `v1040_layout`, and `v1040_field_extract`, and refuses to start if not.
  **This is not currently buildable.** As of Router v0.0.24 there is no region concept
  anywhere in the Router — no region column on policy, no enforcement at routing time, no
  policy-reporting endpoint to assert against. It is Router work that must be scheduled and
  landed before P14 exits. See QUESTIONS.md Q11. Because these classes are
  `cloud_deidentified`, this assertion is the only control keeping inference in the US.
- Section 9's Judgment Required behavior is not only a UX choice; it is what keeps the
  app on the data-capture side of the line. Do not add logic that decides a
  characterization question.
- Adding this app requires a WISP amendment naming the Router's providers as service
  providers, and an executed DPA with DigitalOcean.
- GLBA Safeguards obligations that land on this repo: MFA on staff accounts, encryption
  at rest and in transit, access logging, and a documented retention and disposal
  schedule with an enforcing job.
- Rasterized page images are derived PII. Purge them on the retention schedule
  independently of the source PDFs.

## 12. Stack

**Confirmed 2026-08-26 — QUESTIONS.md Q1 resolved, P0 unblocked.** The Router SDK being
TypeScript settled it: a Python-primary build would hand-roll a client against a frozen
wire contract and drift silently.

- API and review UI in TypeScript, matching the rest of the suite. BullMQ for the job
  queue, consistent with Vibe Filer.
- A Python sidecar worker for document processing, where PyMuPDF, pdfplumber, and
  pypdfium2 live. The queue is the boundary between the two.
- Postgres for metadata. Object storage for blobs — local encrypted volume by default,
  B2 optional following the Filer pattern.
- Conventional commits. Phased execution per PHASES.md, state tracked in STATE.md, open
  items raised in QUESTIONS.md rather than guessed.

## 13. Productization

Internal Kisaes use first, licensed Vibe product later. Build single-firm, but:

- Keep firm-specific configuration in config, not in code.
- Stub the licensing.kisaes.com check at the same integration point the other appliances
  use, feature-flagged off.
- Keep the client identity layer behind an interface so a later version can bind to Vibe
  T&B or the Filer sentinel instead of deriving identity from the bundle.

Do not build multi-tenancy now.
