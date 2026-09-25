# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Working name: **Vibe 1040**. Repo `vibe-1040`. Distributed via GHCR alongside the rest
of the Vibe suite. Rename freely; the slug appears only in compose service names and the
image path.

---

## 0. Start here

**This is a built, released application, not a plan.** P0–P15 are implemented and shipping
as versioned GHCR images: a Fastify API that also serves the React review UI (`src/`, `ui/`),
a BullMQ pipeline worker, and a Python rasterization sidecar (`sidecar/`), over Postgres and
Redis. P16 (single sign-on) is the most recent phase. Do not read a version or a phase status
off this file — it went stale once already, saying "no code" through nine releases. **STATE.md
has the current position**, including which phases are implemented but have not *exited*
because their exit criteria have not been demonstrably met.

"Implemented" and "verified" are different claims in this repo and STATE.md keeps them apart:
each change set records what was verified by execution and, separately, what was not. Keep
doing that. A phase whose exit criteria were reasoned about but not run has not exited.

Read in this order before doing anything:

1. **STATE.md** — the single source of truth for where the build stands. Current position,
   phase ledger, external dependencies, locked decisions, known risks, fixture inventory.
   Do not infer progress from the commit log. Update it at the close of every phase and
   whenever a blocking condition changes.
2. **PHASES.md** — P0 through P16, each with its dependency, deliverable, and exit
   criteria. A phase is not complete until its exit criteria are demonstrably met.
3. **QUESTIONS.md** — open items. Blocking questions halt the phase they gate; non-blocking
   ones carry a recorded working assumption. Answer with `**A:**` and a date, then move to
   Resolved.
4. **vibe-ai-router-PHASES-addendum.md** — R1–R5, work that belongs to the Vibe AI Router
   repo, not this one. **Largely historical as of 2026-08-26** — most of it already shipped
   or turned out not to be Router work. STATE.md's External dependencies table supersedes
   it. Only region pinning is still real (the addendum's R5, filed in the Router repo as
   R6), and it gates P14's exit.
5. **docs/** — `runbook.md` (provisioning, Router policy binding), `sso.md` (single sign-on,
   break-glass, registration with Vibe Auth), `wisp-amendment.md`, `line-mapping-review.md`.

Sibling repositories are usually checked out beside this one (`../Vibe-AI-Router`,
`../Vibe-Auth`, `../Vibe-Appliance`, `../trial-balance-app`) and sometimes hold documents
addressed to this repo — Vibe Auth has a plan for it. Read them, and verify what they say
about this codebase before acting on it; that plan was wrong about how migrations work here.

Working rules:

- **Raise, do not guess.** Anything ambiguous or out of scope becomes a QUESTIONS.md entry
  rather than an implementation choice. §2 boundaries specifically require this.
- Decisions in STATE.md's "Decisions locked" are settled. Changing one requires an entry
  in the decision log, not a silent implementation choice. That includes changing *how* a
  locked decision is satisfied — see Q18, where single sign-on changed who performs the
  mandatory second factor.
- Migrations are hand-written `NNNN_name.up.sql` / `.down.sql` pairs in
  `src/db/migrations`, mirrored by hand in `src/db/schema.ts`, and must run forward **and
  back**. `drizzle-kit generate` exists in `package.json` and its output is not what runs.
- No TypeScript parameter properties or enums in `src/`: `npm run dev`, the worker and the
  migration scripts run under `--experimental-strip-types`, which rejects them, so they would
  work in the built image and fail in development.
- Conventional commits.

## Commands

```bash
node scripts/install-deps.mjs        # NOT `npm install` — see below
npm run typecheck                    # tsc --noEmit (strict, exactOptionalPropertyTypes)
npm run lint                         # eslint . — known broken: no eslint.config.* was ever committed
npm test                             # vitest run — test/**/*.test.ts
npx vitest run test/layout.test.ts   # one file
npm run build                        # tsc + copy migrations into dist/
npm run db:migrate | db:rollback     # SQL migrations in src/db/migrations, up / one step down
npm run dev | worker                 # API and queue worker, --experimental-strip-types
npm run accuracy -- <bundleId>       # score a processed bundle against fixture ground truth
npm run check:providers              # provider-leakage grep; must stay clean
```

Installing takes two first-party packages that plain `npm install` cannot fetch.
`@kisaes/vibe-ai-client` is on no registry: `scripts/install-deps.mjs` installs everything
else and links the SDK from `vendor/sdk` or a sibling `../Vibe-AI-Router` checkout.
`@kisaesdevlab/vibe-auth` is on GitHub Packages, which needs a token with `read:packages`
even to read: keep `//npm.pkg.github.com/:_authToken=…` in your user-level `~/.npmrc`, never
in the repo's `.npmrc` (scope line only). The UI is its own package — `cd ui && npm install`.
Docker takes the token as a BuildKit secret: `docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN .`

The tests that touch the database (`test/pipeline.test.ts`, `test/sso.test.ts`) need the
Postgres from `docker-compose.dev.yml` with `vibe1040_test` migrated; they skip themselves,
loudly, when it is not there — so a green run with skips has not tested those paths.

Sidecar: `cd sidecar && pip install -r requirements.txt && python -m py_compile worker.py`.

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
  against a return. The human does the comparison. **This is unchanged by P17**: the draft
  return compares the app's own two derivations of the same source documents — what the
  worksheet reports against what the engine computes — which is internal consistency
  checking. Nothing is ever read out of a prepared return, and the app emits no MeF XML.
- **Not a client portal.** Upload is staff-only, from inside the firm. No client accounts,
  no client-facing auth, no consent-collection UI, no E2EE intake. Vibe Connect owns that
  surface; this app does not duplicate it.
- **Not a tax calculation engine of its own, and never a decider.** The app computes no tax
  itself: there is no taxable-Social-Security worksheet, no §121 exclusion, no QBI
  calculation anywhere in `src/`. It reports what the documents say and, where a box does not
  map cleanly to a line, it says so and stops.
  **Amended 2026-09-25 (§14, P17, STATE.md decision log).** It may hand the amounts it read
  to a separate, deterministic, locally-run engine and show that engine's computed lines
  beside its own reported totals, as a checking aid. That is a narrowing, not a repeal: every
  §9 judgment call is still withheld rather than answered, the engine is a severable optional
  process and not a library, and no characterization logic is written here. Read §14 before
  touching any of it.
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
| `v1040_layout` | `vision`, `json_schema` | P7 — spans with page-relative geometry |
| `v1040_field_extract` | `json_schema` | P8 — binds schema fields to span IDs |
| `v1040_ocr_transcribe` | `vision` | **Optional**, off by default — transcribes a page with no text layer |

**`v1040_ocr_transcribe` is opt-in via `OCR_FALLBACK_ENABLED` and registered only when on.**
It requires `vision` and deliberately **not** `json_schema`, which is the only reason it can
bind to the Router's `local_ocr` kind at all: that kind is pinned to `json_schema: false`,
because a grammar constraint forces a small OCR model to invent a spans array rather than
refuse, which produced confident garbage. The class asks for prose and this app parses it.

**Its sensitivity is the firm's decision, not this app's.** It is absent from
`SENSITIVITY_CHECKED`, so no startup warning is raised either way. A firm may bind it to a
local OCR server, in which case no page image leaves the appliance, or to a cloud vision model
for accuracy. The startup log reports which way it resolved.

**It supplies no geometry.** Nothing the `local_ocr` kind can serve returns bounding boxes, so
a value read out of a transcription has no span to point at and §6's blocking rule applies in
full. Enabling this makes a scanned page readable, not provable. Transcriptions are stored on
`pages.ocr_text` and never merged into `pages.text_layer` — one is exact and came from no
model, the other is an estimate, and a footing check must not mistake the second for the
first.

Two-pass extraction (§4) is **built app-side as two task classes and two round trips**. Do
not wait on the Router's proposed preprocess stage that would fuse them; if it lands, this
app can migrate to it later.

**Current binding (decided 2026-09-02):** all three classes are served by DigitalOcean-hosted
open-source models chosen in Router policy — `digitalocean/glm-5.3-flash` for classify and
layout, `digitalocean/qwen3.5-397b-a17b` for field extraction. Anthropic and OpenAI models
hosted on DigitalOcean are excluded for retention reasons. The app never names a model; the
provisioning steps are in `docs/runbook.md`.

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

1. **Layout pass** — text spans with page-relative boxes, the provenance substrate. Stored
   verbatim. **Where the geometry comes from depends on the page (decided 2026-09-16):**
   - A page with a usable text layer gets its spans from the **sidecar**: PyMuPDF words with
     exact boxes, merged into spans, normalized to 0..1 in the rotated page space the raster
     is rendered in. No model, no inference, no pixel leaves the appliance for geometry.
     Recorded as `pages.layout_source = 'text_layer'`, producer `pymupdf`.
   - A raster page (scan, phone photo, garbled text layer) goes to `v1040_layout`, a vision
     model asked for spans with boxes on a 0–1000 scale, the native grounding convention of
     the GLM/Qwen-family models policy binds. The app detects the convention the model
     actually returned — fraction, thousandths, or pixel — **once per page over the whole
     span set**, normalizes to 0..1, records the convention on the page row and the serving
     model on every span. Recorded as `layout_source = 'model'`.
   A page may print several copies of one form (Copy B, C, 2); every copy is transcribed.
   **GLM-OCR cannot serve the vision class**: it emits text and Markdown tables without
   geometry (QUESTIONS.md Q14).
2. **Field-binding pass** (`v1040_field_extract`) — takes the spans **with their position**
   plus the registered schema for the classified form type and binds schema fields to spans.
   Spans are serialized grouped into rows, left to right, with x/y in thousandths, because a
   tax form is a grid and a flat list of span text cannot say which label a value sits under.
   With `EXTRACT_ATTACH_PAGE_IMAGE` the page image goes along too and the class is registered
   as a vision class. Every emitted field carries `span_ids`, so every number on the worksheet
   traces to pixels without the model ever being asked to invent a coordinate.

**Verification is the confidence signal.** The router surfaces no logprobs (Q4). Every bound
value is checked against the text of the spans it cites — money in cents, text loosely — and a
value that is not in its own evidence is flagged `span_mismatch` and routed to review. A
second pass (`EXTRACT_PASSES` ≥ 2) runs at a non-zero temperature and optionally against
`EXTRACT_SECOND_PASS_MODEL`, so that agreement is between different readings; the old design
ran the same prompt twice at temperature 0, which agrees whether or not it is right.

A field the binder cannot tie to a span is emitted with `span_ids: []` and is
automatically routed to review regardless of confidence. A blank box legitimately cites
nothing and is not a review item.

## 5. Blank is not zero

Extraction emits `null` for an empty box and `0` only where the form literally prints a
zero. This distinction drives whether the worksheet flags an omission, and collapsing it
destroys the tool's main value. Every schema field is nullable. No default-to-zero
anywhere in the pipeline, including in the aggregation layer — a line total sums the
non-null values and separately reports how many contributing documents were null.

Three readings of "empty" the binder produces are all stored as blank and are **not review
items** (decided 2026-09-16, after the first real packets prompted on every empty box): a
money value with no digit in it (the pre-printed `$`), a zero that cites no span (a printed
zero has a span, and the binder must cite it), and an unchecked checkbox, which is `false`
and has nothing on the page to cite. A *checked* box with no span is still an orphan.

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
- A page that reports tax amounts but whose form type is not registered. The classifier
  separates this from a cover letter, and the two are not interchangeable: an unreadable tax
  document must be louder than a readable one, not quieter. It blocks until a human reads the
  page, and it is carried onto the finished worksheet as an annotation even once
  dispositioned, because the amounts on it were never extracted.
- A document classified as a form type with no registered schema in any year
  (`no_registered_schema`), and a form document whose pages yielded no layout spans at all
  (`no_layout_spans`). Both are recomputed at reconcile from the document's recorded
  extraction outcome, so they survive the check-result reset.

Soft failures (annotate):

- W-2 box 1 differs from boxes 3 and 5 — legitimate via 401(k), §125, group-term life,
  or excess deferrals, but worth surfacing.
- 1099-R box 2a blank with "taxable amount not determined" checked.
- Distribution code implausible against the payee's age where a DOB is available.
- Document tax year differs from the bundle's majority year.
- A document read with another season's schema because its own year has none registered
  (`schema_year_substituted`). The registry resolves to the nearest year in either direction
  rather than dropping the document.

Tolerance is $1 per document for rounding, configurable per firm. Do not silently widen
it.

## 7. Identity resolution

There is no client master. Client and tax year are **proposed from the bundle and
confirmed by the reviewer** before extraction results are committed to a client — which
means **before a worksheet is produced, not before extraction runs** (decided 2026-09-10).

Ingestion runs straight through: classify, layout, extract, reconcile. The reviewer then
confirms against the forms the app actually read. Gating extraction on the confirmation was
tried and removed: nothing downstream read the confirmation, the page images had already
gone to a cloud model during classification so there was no exposure left to gate, and it
asked the reviewer to identify a client from a guess made before anything had been read.
`assertIdentityConfirmed` is now a real precondition of the worksheet, enforced in the same
place as the arithmetic gate.

- Join key is a **salted hash of the TIN**, per-deployment salt held in the app's secret
  store. Plaintext SSNs are never written to the database.
- Only the last four digits are stored in plaintext, for display.
- The taxpayer's name comes from the schema field flagged `identity: name` (recipient,
  employee, borrower, …), never from the payer. A masked number on a document is kept as a
  last-four hint for the reviewer, never as a key; the reviewer types the full number.
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
SSA-1042S, RRB-1099, 1098, 1098-E, 1098-T, 1095-A, 5498, 5498-SA, and K-1 (1065, 1120-S,
1041).

**SSA-1042S is boxes-as-printed only** (added 2026-09-10, Q16). It is the benefit statement
issued to a nonresident alien, so the return it belongs on may not be a 1040 at all, and the
characterization of the benefit is a determination §11 forbids this app from making. Report
the printed boxes, land the whole form in Judgment Required, and let the preparer decide. Do
not map it to a 1040 line.

**1099-B is one document per Form 8949 section** (decided 2026-09-16). The classifier reports
the section letter (A–F) printed in the heading, grouping splits on it, and the schema carries
the section subtotals printed at the section's foot — proceeds, basis, wash sales, market
discount, gain or loss as printed — which is what Schedule D needs. Per-lot rows are not
extracted in v1; the section pages are attached for the preparer. Section subtotals foot to
the package summary as a hard check on the container.

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
- SSA-1042S — every field. Gross benefits and withholding are reported; whether they belong
  on a 1040 or a 1040-NR, and at what rate or under which treaty, is not decided here.
- 1098-T — payments received vs qualified expenses, scholarship netting.
- 1099-G box 2 state refunds, which depend on prior-year itemization.
- 1099-S, which depends on the §121 exclusion.
- Every K-1 in v1.
- Any page the classifier could not identify as a registered form.

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

The app performs data capture and makes no substantive determinations about filing status,
income characterization, deductions, or credits. That keeps inference within the auxiliary
service provider treatment under Treas. Reg. §301.7216-2(d), which does not require written
taxpayer consent — but only while processing stays inside the US.

**Amended 2026-09-25, and not yet settled.** §14's draft return computes arithmetic over
amounts a human has accepted, from inputs the preparer has stated. It still decides nothing:
a populated field the schema marks `judgmentRequired` withholds its whole document from the
engine, so an SSA-1099 never reaches it and the taxable portion of social security is never
computed here. The engine runs on the appliance and discloses nothing to anyone, so the set of
third parties seeing taxpayer data is unchanged. **But the sentence above is the sentence the
WISP rests on, and `docs/wisp-amendment.md` §4 has to be revised by whoever owns the WISP
before this runs against live client data — QUESTIONS.md Q21.** Until Q21 is answered,
`DRAFT_RETURN_ENABLED` stays off wherever there is live client data.

- The Router must enforce US-region pinning for any task class this app calls. This app
  asserts at startup that the Router reports a US-pinned policy for `v1040_page_classify`,
  `v1040_layout`, and `v1040_field_extract`, and refuses to start if not.
  **This is not currently buildable.** As of Router v0.0.24 there is no region concept
  anywhere in the Router — no region column on policy, no enforcement at routing time, no
  policy-reporting endpoint to assert against. It is Router work that must be scheduled and
  landed before P14 exits. See QUESTIONS.md Q11. Because these classes are
  `cloud_deidentified`, this assertion is the only control keeping inference in the US.
  **Decided 2026-09-02:** DigitalOcean serverless inference offers no region selection
  either, so deployments bound to DigitalOcean-hosted open-source models run with
  `ROUTER_REQUIRE_US_REGION=false` by explicit, recorded decision (STATE.md decision log,
  QUESTIONS.md Q13). The §7216 position then rests on DigitalOcean's terms and DPA.
- Section 9's Judgment Required behavior is not only a UX choice; it is what keeps the
  app on the data-capture side of the line. Do not add logic that decides a
  characterization question.
- Adding this app requires a WISP amendment naming the Router's providers as service
  providers, and an executed DPA with DigitalOcean.
- GLBA Safeguards obligations that land on this repo: MFA on staff accounts, encryption
  at rest and in transit, access logging, and a documented retention and disposal
  schedule with an enforcing job.
- **MFA is mandatory and cannot be switched off; single sign-on does not change that**
  (decided 2026-09-19, QUESTIONS.md Q18). Staff may sign in through Vibe Auth, and a second
  factor performed by the firm's identity provider counts — but only on proof. An SSO session
  is marked MFA-satisfied solely when the ID token's `amr` shows a second factor, a token
  without it is refused rather than downgraded, and `amr` is written to the audit row. That
  refusal is enforced in this app's session adapter as well as in the package configuration,
  so no environment value or settings page can disable it. The break-glass account is a local
  admin with an authenticator, never a password-only path. Do not add a way around
  `requireUser`'s `mfa_satisfied_at` check, and do not mark a session satisfied anywhere but
  the local second-factor verification and the `amr`-checked SSO adapter.
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

**Licensed AGPL-3.0-only since 2026-09-25**, relicensed from BUSL-1.1 so the OpenTax engine
(verbatim AGPL v3, no linking exception) can be used without ambiguity. Two things follow and
neither is settled — see QUESTIONS.md Q22. Conveying Corresponding Source has to cover
`@kisaes/vibe-ai-client` and `@kisaesdevlab/vibe-auth`, which are sibling-repo decisions. And
a proprietary licence for a work that *incorporates* OpenTax is no longer Kisaes's alone to
grant, which is why the engine is invoked as a separate process and stays severable: **do not
move it in-process and do not vendor its source into `src/`.** The AGPL obliges offering source
to those who use the service over a network; it does not oblige a public repository, and this
one stays private while `docs/wisp-amendment.md` lives in it.

- Keep firm-specific configuration in config, not in code.
- Stub the licensing.kisaes.com check at the same integration point the other appliances
  use, feature-flagged off.
- Keep the client identity layer behind an interface so a later version can bind to Vibe
  T&B or the Filer sentinel instead of deriving identity from the bundle.

Do not build multi-tenancy now.

## 14. Draft return (P17)

**Decided 2026-09-25.** The app can hand the amounts it read to
[OpenTax](https://opentax.filed.com/) — a deterministic, open-source federal 1040 engine that
runs as a single binary on the appliance — and show the computed lines beside the worksheet's
own reported totals. It turns §1's eyeball comparison into an arithmetic one without ingesting
the prepared return.

Why this is not a repeal of §2: the engine holds no credentials, makes no network call and
sees no third party, so nothing about the §7216 disclosure analysis changes; the app itself
still computes no tax and still decides nothing; and everything §9 sends to Judgment Required
is withheld from the engine rather than guessed at.

**Off by default, behind `DRAFT_RETURN_ENABLED`.** It is an environment key, not a
`firm_settings` row, and renders read-only in Admin → Settings with its reason — it changes
what the app computes about a taxpayer, which is not a click. **It stays off wherever there is
live client data until QUESTIONS.md Q21 is answered.**

### The omissions contract

**An incomplete draft return is an enumerated fact, not a footnote.** A draft computed from a
source-document bundle can never be a return, and pretending otherwise is the one failure mode
that would make this worse than nothing. `src/draft/translate.ts` therefore emits, beside the
nodes it can send, every reason something could not be sent. Six rules produce it, and none of
them may be softened to make a draft look more complete:

1. **A blank is never a zero.** `null` reaching a calculation engine as `0` would destroy the
   distinction §5 exists to preserve. A blank box is left off the payload; where the engine
   requires the field, the **whole document is withheld** rather than zero-filled. A partially
   read 1095-A year is not padded with zero-premium months. A zero the form actually printed is
   sent, because that is a value.
2. **A value no human has accepted does not feed a computation.** A mapped field flagged for
   review, or citing no span, withholds its document (§4, §6).
3. **A judgment call is never made here.** A *populated* field the schema marks
   `judgmentRequired` withholds its document, and an `allJudgmentRequired` form type never
   reaches the engine at all. Applied per document by content, this is §9 exactly: an SSA-1099
   always prints box 3, so it is always withheld, because the taxable portion of social
   security is not this app's to compute. Every K-1 and the SSA-1042S are withheld by §8.
4. **A negative amount is withheld**, because nearly every money field in the engine's
   catalogue is declared non-negative and the alternative is a silent absolute value.
5. **What the bundle cannot know is listed every time** — filing status, dependents, itemised
   deductions, estimated payments, basis, carryovers, prior-year AGI. Filing status and the
   age/blindness flags come from the **reviewer**, never from inference over a pile of forms.
   That is the preparer making the determination, which is the right place for it.
6. **One door.** A draft return goes through `assertWorksheetAllowed` (`src/reconcile/gate.ts`),
   the same gate as the worksheet, so a bundle with an undispositioned hard failure gets no
   draft return either. Do not add a `force` flag; the gate deliberately has none.

### The node map is data

`data/opentax-nodes/<year>.json`, loaded and validated by `src/draft/nodes.ts`. A new season is
a data change, exactly as for `data/line-mappings`. The engine's field names are **not**
derivable by convention — its catalogue calls the first money box `box1_wages` on `w2`, `box1`
on `f1099int`, `box1_oid` on `f1099oid` and `box_1_unemployment` on `f1099g` — so every pair is
written out and checked.

Two load-time rules carry the weight, and both exist because a quietly missing number is the
failure this whole app is built to prevent:

- **Every registered form type is declared**, either mapped or explicitly `unmappable` with a
  reason a preparer can read. A form type nobody thought about fails at startup.
- **Every field of a mapped form type is accounted for exactly once**, in `fields`,
  `codeGroups`, `monthlyArrays` or `ignored`. A TIN is always `ignored` with reason
  `tin_withheld` and is never forwarded (§7).

### Boundaries that stay

- **The engine is a separate process over JSON, never a library.** That is the arm's-length
  reading of its AGPL licence and it keeps the integration severable (§13, QUESTIONS.md Q22).
  Do not move it in-process. Do not vendor its source into `src/`.
- **Pin the version and verify the binary by checksum.** It is a young, largely
  AI-maintained engine; `install.sh | sh` into a floating latest is not acceptable here.
- **No MeF XML and no filing.** The engine can emit MeF XML and a filled PDF; this app uses
  neither. No transmission, no acknowledgements, no EFIN or ERO surface.
- **Every computed figure is labelled advisory**, with the engine and its version named, and a
  draft return is never presented as a finished return.
