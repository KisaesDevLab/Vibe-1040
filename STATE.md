# Vibe 1040 — STATE.md

Current state of the build. Update at the close of every phase and whenever a blocking
condition changes. This file is the single source of truth for where the build stands —
do not infer progress from the commit log.

---

## Current position

**Phase:** P0–P15 — **all phases implemented 2026-08-26**
**Status:** code complete; **integration-unverified** (see below)
**Blocked by:** nothing for development. P14 cannot *exit* until Router region pinning
lands (QUESTIONS.md Q11).

Router integration was verified against Vibe-AI-Router **v0.0.24** on 2026-08-26. Four of
the five assumed Router dependencies already exist; the region-pinning one does not exist
at all. See External dependencies below and QUESTIONS.md Q11.

### What "code complete" means here, precisely

**Verified by execution on 2026-09-16** (pipeline review change set, released as v0.6.0;
carries **migration 0007**):

- 218 tests pass across 18 files (`npm test`), including a new **stage hand-off integration
  test** (`test/pipeline.test.ts`) that walks a bundle with a cover letter, a native W-2, a
  blank duplex page, and an unregistered form from raster output to `blocked`, with the
  router mocked and the database real. That bundle stalled twice before this change set and
  no test crossed a stage boundary to notice. The test skips itself, loudly, when the test
  Postgres is not up.
- Migration 0007 ran forward, back, and forward again against the compose Postgres 17.
- `tsc --noEmit` clean; the UI builds; the sidecar compiles and its new text-layer span
  extraction was run on the fixture W-2 (44 spans, boxes inside 0..1, rotation handled).
- The IRS-form fixtures generate: every filled value is asserted present in the flattened
  text layer, so the field maps are known to be right for the 2025 revisions on disk.
- **Still not verified:** anything past the router boundary. No model has yet read the
  IRS-layout fixtures. The harness is the next step and needs the router provisioned.

**Verified by execution on 2026-09-02** (DigitalOcean-binding change set):

- 126 tests pass across 12 files (`npm test`), including new coverage for page-level
  coordinate-convention detection (a 0–1000 span set on a 1700 px raster now maps 500 →
  0.5, where the old rule produced 0.29), the `invalid_response` / `no_vision_provider`
  taxonomy cases, and classifier provenance on document groups.
- `tsc --noEmit` clean; provider-leakage check clean.
- Migration `0003_model_provenance` ran forward, back, and forward again against the compose
  Postgres 17: the three new columns appear, disappear, and reappear; `schema_migrations`
  ends at 0001, 0002, 0003.
- `npm run lint` does **not** run: the repo has no `eslint.config.*` (ESLint 9 flat config)
  and never had one committed. Pre-existing; not addressed in this change set.
- **Still not verified:** anything past the router boundary. No DigitalOcean request has been
  made; the coordinate-convention detection, the truncation retry, and the overlay alignment
  are tested against synthetic span sets only. The provisioning steps in the runbook and the
  first harness run are the next work.

**Verified by execution on 2026-08-26:**

- 61 tests pass across 7 files (`npm test`).
- `tsc --noEmit` clean under `strict` + `exactOptionalPropertyTypes` +
  `noUncheckedIndexedAccess`.
- Production build emits `dist/server.js` and copies migration SQL.
- UI builds (Vite, 32 modules).
- Python sidecar compiles; `triage`/`blobstore` import.
- **The AES-256-GCM blob envelope round-trips both directions between TypeScript and
  Python** — the language boundary at the queue was tested for real, not assumed.
- Provider-leakage CI check passes, and demonstrably fails when a provider hostname is
  introduced (P3 exit criterion).
- Both worksheet renderers produce artifacts whose totals reconcile to the same model.
- **The full TS → Python → TS queue boundary ran for real** (2026-08-26): a 7-file fixture
  bundle uploaded through the API, the Python sidecar rasterized every file, and the TS
  worker recorded all 7 page rows and advanced the bundle. Triage matched the fixture
  expectations exactly — 6 native pages to `text_layer` at 200 DPI, the scanned page to
  `raster` at 300 DPI.
- **Router-down parking proven end to end**: with no router reachable, classification parked
  1 job and the bundle went to `blocked` rather than failing (§3).
- **Admin, notifications, and both new factors exercised against a live stack** (2026-08-26)
  with a real SMTP catcher: settings validation refused a raster window outliving its source
  documents and an email factor with delivery disabled; the SMTP password stored as
  ciphertext; a test email arrived; a staff user on the email factor signed in with a mailed
  code, was rejected on a wrong code, and could not replay a used one; a password reset
  completed and revoked the prior session. Migration 0002 runs forward and back.

**Verified against a live stack on 2026-08-26** (Postgres 17 + Redis 7 in Docker, app on
the host):

- Migrations run **forward and back**: 20 tables up, clean rollback including every enum,
  forward again. P0 criterion met.
- Full auth flow: password alone yields a session that is explicitly unusable
  (`403 mfa_required`); TOTP enrolment and verification make it usable. P0 criterion met.
- Every taxpayer-data action wrote an audit row — login, failed login, MFA enrolment,
  disposition, worksheet generate, worksheet download, retention.
- **Database-enforced invariants proven by direct INSERT**, not by trusting app code:
  a populated field with no span is rejected by CHECK constraint and accepted only once
  flagged for review; un-normalized span geometry is rejected; a full SSN in `tin_last4`
  is rejected.
- **The blocking gate works end to end through the API**: worksheet generation returned
  `409 blocked` with the offending check named, and succeeded only after a human
  disposition with a note.
- Both artifacts downloaded and are real files (XLSX zip container, `%PDF-1.3`).
- Retention job runs and logs; dry-run mode works.
- Server starts in **degraded mode** when the router is unreachable and says so at
  `/health`, rather than refusing to boot.

**Released 2026-09-17 as v0.9.0** — taxpayer recognition (identity name field, spaced and
bare TINs, masked-number hints), quieter field review with **Looks right**, code-letter money
values parsed, and foreign tax / foreign source income captured from consolidated packages
(decision log, same date). **Carries migration 0010.** Images tagged `0.9.0` / `0.9`.

**Released 2026-09-17 as v0.8.3** — the admin settings now do what they say. The
reconciliation, retention, extraction and rasterization settings had been stored since
2026-08-26 and read by nothing; the pipeline used the environment. Binding passes, escalation,
second-pass temperature and model, reconcile tolerance, retention windows and dry-run are now
read from the store on every use; rasterization settings ride on each raster job to the
sidecar; and a new **Pipeline concurrency** setting is applied to the live worker within a
minute. Env-only knobs that change task-class registration (`EXTRACT_ATTACH_PAGE_IMAGE`,
`OCR_FALLBACK_ENABLED`) are shown read-only with the reason. No migration. Images tagged
`0.8.3` / `0.8`.

**Released 2026-09-17 as v0.8.2** — read from the router ledger of the first scanned packets.
A worksheet is refused while any document has no extraction outcome (a bundle had reached
`ready` with every line blank), and confirming identity no longer flips a running bundle to
`in_review`. Taxpayers can be typed, renamed, re-roled and removed in the UI — the full TIN is
hashed on the server and only its last four kept (§7) — because a scanned packet has no text
layer to harvest one from. Binding budget raised to 8192 tokens (ten truncations in the ledger),
router timeout to ten minutes (layout on the fallback model reached 243 s a page), and
`WORKER_CONCURRENCY` is configurable. No migration. Images tagged `0.8.2` / `0.8`.

**Released 2026-09-17 as v0.8.1** — the bundle view shows pipeline progress (pages laid out,
documents bound, refreshed every 8 s while running) and pipeline jobs that died outside the
router path (an app error after five attempts), which were invisible before and left a bundle
at `extracting` with nothing on screen to say why. Retry covers them. Layout coordinates are
coerced from quoted numbers. No migration. Images tagged `0.8.1` / `0.8`.

**Released 2026-09-16 as v0.8.0** — documents in return order in the UI and the workbook, and
the bookmarked sorted PDF of the source pages (decision log, same date). **Carries migration
0009.** Images tagged `0.8.0` / `0.8`.

**Released 2026-09-16 as v0.7.3** — the worksheet preview lists what feeds each line
(Judgment Required opens by default, with the reason per item); W-2 boxes 3–6 each get their own
detail line instead of one meaningless sum (mapping 2025.2); box 16 is listed as state *wages*
and box 17 appears under state withholding beside the 1099 boxes, boxes 18/19 added; a
de-identification placeholder such as `[EIN]` the cloud model copies back is recovered from the
unscrubbed span it cites. No migration. Images tagged `0.7.3` / `0.7`.

**Released 2026-09-16 as v0.7.2** — the generated workbook is downloadable from the bundle
view. The download route existed but the UI discarded the worksheet id after Generate, so
nothing on screen led to the file. The bundle view now lists generated worksheets and shows
Download Excel / Download PDF for the latest. No migration. Images tagged `0.7.2` / `0.7`.

**Released 2026-09-16 as v0.7.1** — the bundle tax year is the classification majority and
is no longer overwritten by the last document's proposal; confirming identity no longer
re-extracts the bundle; the confirm panel takes a tax year; the title-box year outranks due
dates in the text-layer reader. No migration. Images tagged `0.7.1` / `0.7`.

**Released 2026-09-16 as v0.7.0** — fixes from the first real packets through v0.6.0 and the
review workbook (decision log, same date). Stage fan-out claimed once per run; empty boxes
(`$`, uncited `0`, unchecked checkboxes) stored blank without prompting; tax year read from the
exact text layer and correctable in the UI; soft annotations acknowledgeable; the Excel
workbook gains a document index, one recap sheet per form type, review items, checks and
provenance. **Carries migration 0008.** Images `ghcr.io/kisaesdevlab/vibe-1040` and
`-sidecar`, tagged `0.7.0` / `0.7`.

**Released 2026-09-16 as v0.6.0** — the pipeline review change set (decision log 2026-09-16).
Stage completion recorded instead of inferred, so a cover letter or a blank page no longer
strands a bundle; silent drops (`no_registered_schema`, off-year documents, unnormalized form
types) made loud; a requeue action for parked and failed router jobs; exact PyMuPDF geometry
for native pages; the binder given span positions; verification against cited spans as the
confidence signal in place of same-prompt repetition; 1099-B split per Form 8949 section;
IRS-layout fixtures. A minor because the pipeline's stage contract and §4's geometry source
both changed. **Carries migration 0007**, which also relaxes the §4 CHECK constraint that
rejected every blank box. Images `ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged
`0.6.0` / `0.6`.

**Released 2026-09-11 as v0.5.0** — optional OCR transcription for pages with no text layer.
Adds a fourth task class, `v1040_ocr_transcribe`, requiring `vision` and deliberately not
`json_schema`, which is the only shape the Router's `local_ocr` kind can serve. Off by default
behind `OCR_FALLBACK_ENABLED` and registered only when on. **Sensitivity is the firm's
decision**: the class is excluded from `SENSITIVITY_CHECKED`, so binding it to a local OCR
server or to a cloud vision model are both legitimate and neither warns. Gives no geometry, so
§6 still blocks transcription-derived fields (Q17). **Carries migration 0006.** Images
`ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.5.0` / `0.5`.

**Released 2026-09-10 as v0.4.0** — bundle deletion and list search. `DELETE /api/bundles/:id`
removes the bundle and every blob it owns, admin or partner only, guarded by typing the label
back rather than a confirm dialog; disposal is written to the same `purge_log` the retention
job uses, so an ad-hoc delete leaves the same evidence a policy purge does (§11).
`GET /api/bundles` gains `q`, `status`, `taxYear`, `limit` and `offset`, where `q` matches the
label, a taxpayer's name, or the last four digits only — plaintext identification numbers are
never stored, and a box accepting a full one would invite staff to type it. Images
`ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.4.0` / `0.4`.

**Released 2026-09-10 as v0.3.0** — the identity gate moved from before extraction to before
the worksheet, so ingestion runs classify → layout → extract → reconcile without stopping and
the reviewer confirms against forms the app has actually read. `identityConfirmedAt` was
previously written and read by nothing; it is now a real precondition enforced beside the
arithmetic gate. A minor, because the pipeline's sequencing and §7's meaning both changed.
Images `ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.3.0` / `0.3`.

**Released 2026-09-10 as v0.2.1** — the identity proposal was built inside `extractDocument`,
and extraction does not start until identity is confirmed: a deadlock, with every bundle
parked at `awaiting_identity_confirmation` showing an empty taxpayer table. Identity is now
proposed at classification time from the page text layer the sidecar already stores, so the
gate is answerable with no inference. Only SSN/ITIN-shaped tokens are read, so a payer EIN can
never be proposed as the client; names come from recipient labels or are left null. Verified
against five real client packets. The confirm button no longer requires a proposed taxpayer,
which was a second way to trap a bundle. Images `ghcr.io/kisaesdevlab/vibe-1040` and
`-sidecar`, tagged `0.2.1` / `0.2`.

**Released 2026-09-10 as v0.2.0** — **the §7 identity gate had no control in the UI**, so no
bundle ever reached extraction. It parked at `awaiting_identity_confirmation`, the fields pane
stayed empty, and the worksheet preview rendered every line with all contributing boxes blank.
The pipeline was behaving as specified with no way for a human to clear the gate. Found from a
screenshot of a real bundle, not by a test. Adds the confirmation panel, plus bundle
reprocessing at three depths (`reconcile`, `extract`, `classify`) and a fix for dispositions
being silently deleted on every reconcile re-run. **Carries migration 0005.** Images
`ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.2.0` / `0.2`.

**Released 2026-09-10 as v0.1.0** — bulk upload and a new registered form type, so a minor
rather than a patch. One bundle per file with `POST /api/bundles/bulk`, labelled from the
filename and renamed to the primary taxpayer once identity is proposed; `bundles.label_auto`
keeps the app from ever overwriting a name a reviewer chose. SSA-1042S is registered as
`allJudgmentRequired` with no line mapping (Q16, §8). **Carries migration 0004** — the
appliance runs it through the migrate one-shot on update. Images
`ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.1.0` / `0.1`.

**Released 2026-09-10 as v0.0.9** — bodyless POSTs no longer declare a JSON body. The API
client set `Content-Type: application/json` on every request, and Fastify rejects that with
"Body cannot be empty when content-type is set to 'application/json'", so six actions were
broken from the start: enrolling an authenticator, sending an email or SMS code, signing out,
resetting a user's second factor, running retention, and generating a worksheet. It surfaced
only once enrolment became reachable. Images `ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`,
tagged `0.0.9` / `0.0`.

**Released 2026-09-10 as v0.0.8** — authenticator enrolment shows a scannable QR code. The
`otpauth://` URI was always returned and never used, so enrolment meant hand-typing a 32
character key, and a scanned entry labels itself with the issuer and account where a typed
one does not. Re-enrolment also used to mint a fresh secret on every call, silently
invalidating a secret the user had just scanned; an unconfirmed secret is now reused, so
rescanning is the recovery. Images `ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged
`0.0.8` / `0.0`.

**Released 2026-09-10 as v0.0.7** — a failed second-factor check no longer presents as an
endless "Checking your second factor…". Any failure of `GET /api/auth/factor` left that
screen spinning with the only explanation in a dismissible banner at the top of the page,
which hid the common cause: a 401 because the browser will not return a `Secure` session
cookie over plain HTTP. The screen now shows the message, names that cause, and offers a way
back to sign-in. Images `ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.0.7` / `0.0`.

**Released 2026-09-10 as v0.0.6** — first sign-in can clear the mandatory second factor. An
unenrolled authenticator was reported as an unusable factor, so a fresh deployment's seeded
admin was told to ask an administrator who did not exist. Email and SMS now report unusable
until the firm has configured that channel, and an undeliverable factor offers authenticator
enrolment instead of a dead end. MFA remains mandatory — see Q15. Images
`ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.0.6` / `0.0`.

**Released 2026-09-10 as v0.0.5** — the staff session cookie's `Secure` flag is now read
from `SESSION_SECURE` instead of inferred from `NODE_ENV`. Sign-in was impossible on a Vibe
Appliance in LAN and Tailscale modes, where this app is served over plain HTTP. Images
`ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.0.5` / `0.0`. Deployments outside
the appliance are unaffected: an unset `SESSION_SECURE` keeps the old behaviour.

**Released 2026-09-03 as v0.0.4** — build-only: the release workflow's Docker actions moved
to their Node 24 majors. No application change from v0.0.3.

**Released 2026-09-02 as v0.0.3** — the DigitalOcean-binding change set above (migration
0003, page-level coordinate convention, router taxonomy fixes, provisioning runbook).
Images `ghcr.io/kisaesdevlab/vibe-1040` and `-sidecar`, tagged `0.0.3` / `0.0` / `latest`.

**Released 2026-08-26 as v0.0.1.** Repository and both GHCR images are **private**;
`docs/wisp-amendment.md` documents the firm's compliance posture and an accepted exposure,
which is not something to publish. Images: `ghcr.io/kisaesdevlab/vibe-1040` and
`-sidecar`, tagged `0.0.1` / `0.0` / `latest`. Both build in CI, and the appliance image was
pulled back and started to confirm it is real. A droplet needs a token with `read:packages`.

**NOT verified:**

- **Extraction accuracy.** Classification, layout, and field binding have still never
  received a real model response. `scripts/accuracy-run.mjs` scores a processed bundle
  against the fixture ground truth and is itself verified (seeded with known defects, it
  correctly caught a blank-read-as-zero, a wrong value, and an orphan field with no span,
  and exited non-zero). It needs a reachable router with a vision-capable model — see
  "Blocked on" below.
- **"Clean install from GHCR on a fresh host" (P14) is still unproven.** The image builds,
  publishes, pulls, and starts — but nobody has run the documented install end to end on a
  clean droplet, which is what that criterion actually asks for.
- No inference has ever been performed. Classification, layout, and field binding are
  written against the SDK's contract but have never received a real model response.
- **The fixture set is still empty.** Every phase whose exit criterion says "on a fixture
  set" is unproven — P2 triage accuracy, P4 consolidated-package splitting, P8 blank-vs-zero
  on a real W-2, P15 K-1 renderings. This is the largest gap and it is not closeable by
  writing more code.

### Blocked on — what an accuracy run needs from the operator

Everything up to the router boundary is proven. To score extraction, three things are
needed that this build cannot supply for itself:

1. **The router running** with provider credentials. `vibe-ai-router-postgres` is up but the
   router app is not, its Redis has been down 12 days, and no local model endpoint is
   listening (nothing on 11434 or 8090).
2. **A vision-capable model reachable.** Decided 2026-09-02: DigitalOcean-hosted
   `glm-5.3-flash`, discovered and probed for vision in the router. (GLM-OCR via `local_ocr`
   is **not** an option for the layout class — it emits no geometry; Q14.)
3. **An app token** minted for `vibe-1040`, the three `v1040_*` classes widened from
   `local_only`, policies bound, and `ROUTER_REQUIRE_US_REGION=false` set per the decision
   log. The full sequence is `docs/runbook.md` → Provisioning.

Then: `npm run accuracy -- <bundleId>`. The report opens with which models served the
bundle, so a second run against a different policy binding is a direct comparison.

Treat the build as a complete, self-consistent implementation whose only unproven half is
what a model returns.

---

## Phase ledger

| Phase | Name | Status | Notes |
|---|---|---|---|
| P0 | Scaffolding | implemented | compose/migrations/auth/audit written; **not yet run on a host** |
| P1 | Ingestion and storage | implemented | ingest + content-hash dedup + encrypted blob store (local & B2) |
| P2 | Rasterization and text-layer triage | implemented | Python sidecar: PyMuPDF triage, grayscale JPEG raster; **needs fixtures** |
| P3 | Router SDK integration | implemented | SDK client, error taxonomy, parking, leakage check verified |
| P4 | Page classification and bundle splitting | implemented | v1040_page_classify + grouping + consolidated containers; classifier model recorded (0003) |
| P5 | Identity resolution | implemented | salted HMAC TIN, ITIN-aware, human confirmation gate |
| P6 | Form schema registry | implemented | **27 form schemas**; all fields nullable; validated at load |
| P7 | Layout pass | implemented | 0–1000 scale requested; convention detected per page and recorded; spans immutable, model recorded; values-only retry on truncation |
| P8 | Field-binding extraction | implemented | multi-pass agreement (only signal per Q4); no-span forces review |
| P9 | Arithmetic reconciliation gate | implemented | every §6 check; gate has one door and no bypass |
| P10 | 1040 line mapping engine | implemented | TY2025 incl. Schedule 1-A → 13b; conditional 1099-R routing |
| P11 | Review UI | implemented | bbox overlay; corrections layer over model output; dispositions |
| P12 | Worksheet generation | implemented | XLSX + bookmarked PDF reconcile to one model; prior-year column stubbed |
| P13 | Retention and disposal | implemented | rasters purge earlier than sources; every disposal logged |
| P14 | Compliance hardening and packaging | implemented | **cannot exit** — gated on Router region pinning (Q11) |
| P15 | K-1 support | implemented | K-1 1065/1120-S/1041, boxes as printed, all Judgment Required |

---

## External dependencies

Verified against Vibe-AI-Router v0.0.24 on 2026-08-26. The addendum in
`vibe-ai-router-PHASES-addendum.md` was written before this check and is now largely
historical — read this table first.

| Dependency | Needed by | Status |
|---|---|---|
| Router R1 — multimodal request envelope | P7 | **already shipped** — `gateway/envelope.ts:122` accepts `image_url` parts; adapters translate `data:` URIs natively |
| Router R2 — provider capability matrix | P2 (config), P7, P8 | **already shipped** — `catalog/service.ts` capability keys incl. `vision`; `catalog/probe.ts` probes models live |
| Router R3 — task classes registered | P7, P8 | **not Router work** — apps self-register; this app registers its own three (Q2) |
| Router R4 — body-size limits raised | P7 | **not needed** — `ROUTER_MAX_BODY_BYTES` already defaults to 10 MiB vs ~800 KB/page budget |
| Router R6 — region pinning + policy reporting | P14 | **ticket filed 2026-08-26** — `Vibe-AI-Router/docs/ticket-R6-region-pinning.md`. Not built. Ships inert; 3–4 d router-side, 0 app-side. See Q11 |
| Router image scrubbing (proposed preprocess stage) | — | proposed, pending operator decision D7. **Not a dependency** — exposure accepted, see decision log |
| Firm-admin widening of the three classes to `cloud_deidentified` | P7 | **runbook step** (docs/runbook.md → Provisioning) — app cannot widen itself |
| DigitalOcean provider configured in the Router; `glm-5.3-flash` probed for vision; policies bound | P4, P7, P8 | **runbook step**, decided 2026-09-02 — see decision log |
| Router OpenAPI spec published | P3 | **moot** — no spec exists; SDK is the contract (Q3) |
| DigitalOcean DPA executed | before live client data | not started |
| WISP amendment drafted — must name unscrubbed page-image egress | P14 | **drafted** — `docs/wisp-amendment.md` names DigitalOcean-hosted open models, their retention terms, and the region gap (Q12, Q13) |

---

## Decisions locked

These were settled in requirements and are not open for revisiting mid-build. Changing one
requires an explicit decision entry below, not a silent implementation choice.

- Staff-only internal upload. No client portal.
- SDK client (`@kisaes/vibe-ai-client`) to a separately deployed Router. No bundled Router,
  no direct provider calls, no generated client.
- TypeScript primary, Python sidecar for document processing. Queue is the boundary.
- Task classes are app-registered: `v1040_page_classify`, `v1040_layout`,
  `v1040_field_extract`, at `cloud_deidentified`.
- Base64 inline image transport. No presigned URLs. No DigitalOcean Files API.
- Two-pass extraction: layout pass for geometry, field-binding pass for values.
- Full review UI with bounding-box overlay in v1.
- Arithmetic gate is blocking, not advisory.
- XLSX and bookmarked PDF output, standard 1040 order.
- Client and tax year proposed from the bundle, confirmed by reviewer. No client master.
- TIN stored as salted hash plus last four plaintext. No plaintext SSN in the database.
- All form types in v1; K-1s boxes-as-printed only, sequenced last.
- Single firm. Internal first, productize later.
- No return ingestion, no diff engine, no tax calculation.

---

## Decision log

Append here when a locked decision changes or a significant implementation choice is made
that future phases depend on. Date, decision, reason, phases affected.

**2026-08-26 — Router integration verified against v0.0.24; §3 rewritten.**
The spec was written against assumptions that no longer hold. There is no OpenAPI spec (an
SDK is the contract), no `document.*` task classes (apps self-register `<app>_<purpose>`
keys), and the multimodal envelope, capability matrix, and body-size headroom all already
exist. Addendum phases R1–R4 are therefore shipped, not-Router-work, or moot.
*Affects:* P3, P4, P7, P8.

**2026-08-26 — Q1 answered: TypeScript primary with a Python sidecar.**
The Router SDK is TypeScript and the wire contract is semver-major frozen, so Python-primary
would mean hand-rolling a client against a frozen contract and drifting silently. *Affects:*
P0 and everything downstream. **P0 unblocked.**

**2026-08-26 — Two-pass extraction is built app-side, not deferred to the Router.**
Two task classes, two round trips. The Router's proposed preprocess stage (pending operator
decision D7) would fuse OCR-then-extract into one call, but waiting on it would gate P7 on
external work for no gain here. Migrate later if it proves better. *Affects:* P7, P8.

**2026-08-26 — Task classes register `cloud_deidentified`; unscrubbed image egress accepted.**
The Router's scrubber rewrites text content parts only (`src/protect/scrub.ts:225`); image
parts pass through verbatim. These classes carry W-2 and 1099 page images, so SSNs and EINs
egress unscrubbed to whatever cloud provider policy selects. Kurt accepted this exposure
rather than gating on Router D7, paralleling the existing accepted exposure for
`tb_doc_extract` and `mybooks_receipt_extract` (Router Q-087).
Two consequences that must not be quietly dropped: the WISP amendment has to name page-image
egress explicitly (Q12), and **region pinning becomes the only control keeping this
inference in the US** — which does not exist yet (Q11). *Affects:* P7, P8, P14.

**2026-08-26 — Build executed, P0–P15. Three bugs found by the tests, not by review.**
Worth recording because each was a silent-wrong-answer class rather than a crash:
1. **ITINs were rejected as implausible TINs.** SSN validation treats a 9xx area as
   invalid, but that is exactly the ITIN range — a joint return with an ITIN-holding spouse
   resolved to one taxpayer instead of two, with no error anywhere. `isPlausibleTin` now
   knows the assigned ITIN group ranges.
2. **A blank box stopped being a contributor.** The mapping engine skipped fields with no
   value, so a line fed by three documents where one had an empty box reported two clean
   contributors instead of three with a gap — the precise omission the tool exists to
   surface (§5). Blanks now contribute as null to mapped lines.
3. **The audit scrubber only knew dashed TINs.** `123 45 6789` would have been written to
   the access log verbatim.
*Affects:* P5, P10, and the §11 audit posture.

**2026-08-26 — No TypeScript parameter properties anywhere in `src/`.**
Node's `--experimental-strip-types`, which `npm run dev`, `worker`, and the migration
scripts all use, refuses them outright. They compile fine in the built image and fail in
development, which is the worst possible split. Fields are declared and assigned
explicitly instead. *Affects:* anyone adding a class.

**2026-08-26 — Admin UI added; firm policy moved out of the environment.**
Vibe 1040 had no settings screen, no user management, and no audit viewer — 28 env vars and
a shell. For a GLBA-scoped app intended for licensing (§13) that was the weakest part of the
build. Four tabs now: Settings, Users, Audit, Retention.

The split is the decision worth recording. **Firm policy** (tolerance, retention, pass
counts, rasterization, licensing, notification channels) moved to a `firm_settings` table —
editable without shell access, audited on every change, effective without a restart, seeded
from the matching env var so existing deployments do not change behaviour.
**Infrastructure, key material, and the compliance guardrails stayed in `.env`** and render
read-only with an explanation. `ROUTER_REQUIRE_US_REGION` is the control keeping taxpayer
page images inside US inference; making it a toggle would make disabling the guarantee a
click. A test asserts those keys can never appear in the editable set.

**2026-08-26 — Email and SMS second factors, and password reset.**
MFA remains mandatory and cannot be switched off — `auth.allowed_mfa_methods` controls only
*which* factors staff may enrol, and its schema rejects an empty list. Codes are never
stored, only an HMAC keyed by the session secret; single-use; attempt-limited; issuing a new
one burns the old. SMS is offered but labelled the weakest option in the UI, because SIM
swap is real. Completing a password reset revokes every existing session for that account.
SMTP passwords and SMS auth tokens are sealed with the blob key before storage and are never
returned to the UI.

**2026-08-26 — Startup assertion is region-based, not sensitivity-based.**
A local_only assertion was considered and rejected as inconsistent with the
`cloud_deidentified` tier — the app would refuse to start against its own registration.
P14 therefore blocks on Router region pinning landing. *Affects:* P3, P14.

**2026-09-02 — Task classes bound to DigitalOcean-hosted open-source models; VLM geometry kept.**
Policy binds `v1040_page_classify` and `v1040_layout` to `digitalocean/glm-5.3-flash` and
`v1040_field_extract` to `digitalocean/qwen3.5-397b-a17b`. Chosen for retention, not
accuracy: DigitalOcean's terms for its hosted open models are no storage of inputs or
outputs, no training, never forwarded to the model creator, one subprocessor under one DPA.
Anthropic models on DigitalOcean carry a mandatory 30-day retention for Claude Fable and
OpenAI models there have no zero-data-retention on serverless; both are excluded from
policy. A sidecar-geometry redesign (PyMuPDF words for text-layer pages, an hOCR engine for
scans, text-only cloud calls, no pixel egress) was considered and deferred; the existing
design where the vision model estimates span geometry stands for v1. Kurt's call.
Two consequences: the local-only configuration is not viable for the layout class (Q14),
and the accuracy of a general VLM on dense 1099 pages is unproven — the harness decides.
*Affects:* P4, P7, P8, P14, WISP.

**2026-09-02 — `ROUTER_REQUIRE_US_REGION=false` is the accepted production setting for the DigitalOcean binding.**
DigitalOcean serverless inference exposes no region selection and the Router exposes no
region report, so `assertUsRegionPinning` cannot pass. Disabling it is a recorded decision,
not a development shortcut. The §7216 position rests on DigitalOcean's contractual terms and
the executed DPA rather than a technical control until Router R6 lands — and even then R6
would have nothing to assert against for serverless; dedicated inference in a named US
region is the only DigitalOcean product that gives a provable region. See Q13.
*Affects:* P14, WISP.

**2026-09-02 — Layout geometry requested on a 0–1000 scale; convention detected per page.**
The per-span rule "anything above 1 is pixels" would have misread the native 0–1000
grounding of GLM/Qwen-family models as pixels on every raster wider than 1000 px and
misplaced every box. Detection is now over the whole span set, the result is stored in
`pages.layout_coord_convention`, and the worker warns when a model returns anything other
than the requested scale. One values-only retry on truncation; the layout budget is 16384.
Also: `invalid_response` and `no_vision_provider` — router codes outside the SDK's type
union — are now handled explicitly instead of parking forever; the binder no longer puts
an `enum` on `field_key` because the Router enforces it and fails the whole pass on one
invented key; the classifier's model is recorded on `documents` (migration 0003).
*Affects:* P4, P7, P8, P11 overlay.

**2026-09-10 — The `Secure` flag on the session cookie is deployment configuration, not a build-mode inference.**
It was hardwired to `NODE_ENV === 'production'`, which the Vibe Appliance sets
unconditionally. The appliance serves this app over plain HTTP on emergency port 5177 in LAN
mode, and — because the app is `rootServedOnly` and cannot be path-mounted under
`tailscale serve`'s :80 catch-all — in Tailscale mode as well. A `Secure` cookie on a
plain-HTTP origin is accepted by the browser and then never sent back, so sign-in was
impossible in both modes: the password was accepted, the second-factor request 401'd, and the
UI looped to the login screen with no error displayed anywhere.

Now read from `SESSION_SECURE`, which the appliance already renders per network mode for
Vibe Connect, Vibe Recap, the transaction converter, and the Router. Unset falls back to the
old `NODE_ENV` behaviour, so nothing outside the appliance changes. Deriving it per request
from `X-Forwarded-Proto` was considered and rejected: `tailscale serve` terminates TLS and
forwards to Caddy over plain HTTP, so the flag would silently drop on a tailnet origin that
genuinely is secure.

`SESSION_SECURE=false` is a recorded weakening of the §11 encryption-in-transit control, on
the same footing as `ROUTER_REQUIRE_US_REGION=false` above. In LAN mode staff credentials and
worksheets cross the office network in cleartext, protected by UFW gating the emergency ports
to RFC1918 and the Tailscale CGNAT range rather than by TLS. In Tailscale mode the transport
is inside WireGuard. Named in §3.1 of the WISP amendment. The app logs which way the flag
resolved on every boot. Serving the LAN over HTTPS was considered and rejected for now: the
emergency port is fronted by a deliberately dependency-free HAProxy, the LAN address is a
bare IP that no public CA will certify and that DHCP can move, and it would change every app
on the appliance rather than this one.
*Affects:* P0, P14, WISP.

**2026-09-10 — First sign-in could not clear the mandatory second factor. MFA stays mandatory.**
`factorDestination` reported an unenrolled authenticator as an *unusable* factor, and the UI
turns an unusable factor into a terminal screen telling the user to ask a firm administrator
to reset it. On a fresh deployment the seeded admin has nothing enrolled and is the only
administrator, so the first sign-in was a hard lockout and the enrolment button below that
branch was unreachable.

An unenrolled authenticator is now usable, because enrolment is self-service and needs no
SMTP, no SMS gateway, and no second person. `needsTotpEnrolment` carries whether enrolment
still has to happen; `usable` no longer conflates the two. Email and SMS now report unusable
until the firm has configured that channel, so a factor is never offered that cannot be
delivered. When the assigned factor cannot be delivered and the firm permits authenticators,
sign-in offers authenticator enrolment instead of an error and makes it that user's factor
once verified.

**The locked decision stands: MFA is mandatory and cannot be switched off.** Making it
conditional on a delivery channel being configured was requested and declined — see Q15. It
would leave a fresh deployment on a password alone and is a §11 GLBA obligation, so it needs
a decision entry here rather than an implementation choice.
*Affects:* P0, P14.

**2026-09-10 — SSA-1042S registered; boxes as printed, no line mapping.**
Two of five sample client packets opened with an SSA-1042S, the Social Security benefit
statement issued to a nonresident alien. It was not a registered form type, so the classifier
had no valid label for the page and the only outcomes were a silent drop as a supplemental
page or a misbind against SSA-1099. The misbind is not theoretical: the two forms agree on
boxes 3, 4 and 5 and diverge immediately after, where 1042S box 6 is a tax **rate** printed
as a percentage and SSA-1099 box 6 is an amount withheld, so the binder would read "10%" into
a money field.

Registered `allJudgmentRequired` with **no line mapping at all**, which is the part worth
recording. A 1042S recipient may not be filing a 1040, the benefit may be taxed at a flat or
treaty rate rather than through the line 6a worksheet, and choosing a line would be exactly
the characterization decision §11 forbids. Every field lands in Judgment Required instead.
Carries its own footing check for box 9 against box 7 less box 8; the existing SSA box 5 check
applies unchanged because the field keys match.

Q16's second half stays open and matters more: a page the classifier cannot label is still
indistinguishable from a cover letter, so the next unregistered tax document is still a silent
omission. Registering form types one at a time does not fix that.
*Affects:* P4, P8, P10, §8, §9.

**2026-09-10 — An unrecognised tax document blocks instead of disappearing.**
`form_type: null` meant two unrelated pages — a cover letter, and a tax form not in the
registry or unreadable — and `runChecks` skipped both (`pipeline.ts`: `if (!doc.formType ||
doc.isSupplemental) continue`). So an unregistered form was dropped in silence with nothing on
the worksheet to say a page had been ignored. Found in a real client packet, not in testing:
an SSA-1042S at the front of a bundle.

The classifier now emits `unrecognised_form` as a separate signal, `documents` carries it
(migration 0005), and it raises a **hard** check. Registering SSA-1042S fixed two packets;
this is what fixes the next unregistered document, whatever it turns out to be.

Three choices worth recording. **Hard, not soft**: a soft annotation would produce a worksheet
silently missing whatever the page reported, and rely on a reviewer noticing a note. **Carried
onto the worksheet even after disposition** (`gate.ts` `softAnnotations` includes it): the
human read the page, but the amounts were still never extracted, so the artifact has to say
so. **The prompt breaks ties toward surfacing**: a page wrongly surfaced costs seconds, a tax
document filed as a cover letter costs money with nothing on screen.

Accepted consequence: classifier misfires now block. Worksheet throughput therefore depends on
classification quality, which is still unmeasured. If misfires prove common, fix
classification rather than softening the check.
*Affects:* P4, P9, P10, §6, §9.

**2026-09-10 — The identity gate moved from before extraction to before the worksheet.**
§7 says the client is confirmed before extraction results are *committed*. The build read that
as before extraction *runs*, which was stricter than the rule and worse in every direction.

Three findings decided it. `identityConfirmedAt` was written and then **read by nothing** — a
sequencing step wearing the costume of a control. Page classification is a vision class, so the
rasterized pages had already left the appliance before the reviewer ever saw the gate, leaving
no exposure to gate. And the best evidence of who a bundle belongs to comes out of extraction,
which is exactly why the original code deferred the proposal until afterwards and deadlocked.

Ingestion now runs classify → layout → extract → reconcile without stopping, and
`assertIdentityConfirmed` is a precondition of the worksheet alongside the arithmetic gate. The
reviewer confirms against forms the app has read, and a worksheet is not produced until someone
has said whose return it describes.

Accepted cost: inference is spent before a human looks at the bundle, so a misuploaded file now
costs a full pass rather than classification alone. Acceptable for a staff-only tool where
uploads come from inside the firm, and reprocessing exists if a bundle needs redoing.

Kurt's call, and the right one — he pushed back on the gate as unnecessary and the evidence
agreed with him.
*Affects:* P4, P7, P8, P10, §7.

**2026-09-17 — Taxpayer recognition, review false positives, and foreign income on brokerage packages.** (v0.9.0, migration 0010)
Three complaints from the first week of real packets, one change set.

1. **The taxpayer.** The post-extraction proposal passed the *payer's* name as the taxpayer's,
   so a W-2 read through extraction proposed the employer as the client. Schemas now flag the
   field that names the taxpayer (`identity: name` — recipient, employee, borrower, student,
   participant, beneficiary, partner, shareholder, winner) and the proposal uses it. The text
   harvest reads spaced and label-adjacent bare nine-digit numbers as well as dashed ones, and
   keeps masked numbers (`XXX-XX-8214`, `***-**-8214`, "ending in 8214") as **hints**: last four
   plus the name beside them, stored on the bundle (never a full TIN), shown in the confirm
   panel as "documents show •••-••-8214 — MARCUS D WILLIAMS (W-2); type the full number". The
   scrubbed-placeholder recovery also accepts spaced and bare SSNs.
2. **False positives.** Unflagged fields render quietly with an "edit" affordance on hover; a
   flagged field says in a sentence why, and offers **Looks right** (clears the flag, audited as
   `field.accept`) beside **Correct**. A money value copied with its code letter ("D 20,500.00")
   is parsed from its one amount token instead of being flagged unparseable.
3. **Foreign income and taxes on brokerage statements.** Foreign tax paid was already mapped
   to Judgment Required per sub-form box, but foreign *source* income lives on a package's
   supplemental detail page, which was classified as a stand-alone non-form page and never
   read. A supplemental page that continues an open consolidated package now stays with the
   package document, the container schema gains `summary_foreign_tax_paid`,
   `summary_foreign_source_income`, `summary_foreign_source_qualified_dividends` and
   `summary_foreign_country`, two INFO lines carry them (mapping 2025.3), and a soft check
   flags a package whose summary foreign tax does not tie to its 1099-INT box 6 / 1099-DIV
   box 7 — the exact case of a missed sub-form box. The classifier prompt names these pages.
*Affects:* P4, P5, P8, P9, P10, P11, §7, §9.

**2026-09-16 — Documents in return order everywhere, and a bookmarked sorted PDF of the source pages.** (v0.8.0, migration 0009)
One ordering, loaded from `data/form-order.json`: wages, interest, dividends, retirement,
Social Security, capital gains, refunds, self-employment, K-1s, gambling, deductions, education
and health accounts, marketplace insurance; unlisted forms after those, non-form pages last.
Applied to the review UI's document list (with group headings), the workbook's Documents sheet
and the order of its recap sheets, and a new artifact: the **sorted PDF**. The sidecar binds the
stored source pages into one PDF in that order — PyMuPDF `insert_pdf`, so each page keeps its
own text layer — with a level-1 bookmark per return section and a level-2 bookmark per
document naming the form, section, issuer and CORRECTED/VOID. Built on demand from the bundle
view (`POST /api/bundles/:id/sorted-pdf`, then a download), the job travels on the sidecar's
existing queue and makes no AI call. It is source pages re-bound, so it is recorded on the
bundle (`sorted_pdf_storage_key`) and **purged on the raster schedule** and on bundle delete
(§11); it can be rebuilt while the sources exist. *Affects:* P11, P12, P13, §11.

**2026-09-16 — The bundle year came from whichever document extracted last; confirmation re-ran extraction.** (v0.7.1)
A 2025 packet showed tax year 2026 with every form printed 2025. `saveProposal` wrote the
proposal's year onto the bundle, and the post-extraction refinement is called per document with
that one document's year, so a 5498 read as 2026 became the bundle year by extracting last. The
proposal now sets the bundle year only at classification (the true majority); the per-document
refinement touches taxpayers only, and no longer flips the bundle status mid-pipeline. The
confirm route still called `startExtraction`, a leftover from the pre-2026-09-10 gate, so every
confirmation re-extracted the whole bundle at full inference cost; it now re-runs reconcile only
when the reviewer changed the year. The confirm panel has a year field, and confirming re-flags
every document's mismatch against the chosen year. The text-layer year reader prefers the year
printed beside the form name over due dates and contribution dates elsewhere on the page, and the
classifier prompt says so too. *Affects:* P4, P5, P7, §7.

**2026-09-16 — First real packets through v0.6.0: fan-out claimed once, empty boxes stop prompting, the year comes from the text layer, soft annotations can be acknowledged, and the workbook becomes a review instrument.** (v0.7.0, migration 0008)

Kurt ran real packets through v0.6.0 and sent a screenshot. Three things were wrong and one
was missing.

1. **Every document showed "extracting…" beneath a finished reconcile.** Under worker
   concurrency several layout jobs finish together; each observed "layout complete" and each
   fanned extraction out again, re-extracting every document at full inference cost and
   nulling outcomes a reconcile had already read. `bundles.extraction_fanout_at` /
   `reconcile_fanout_at` are claimed with one conditional UPDATE, so exactly one job advances
   a stage per run. A page laid out after the claim (a requeue) re-binds only its own document.
2. **Hard failures on every empty box.** `every_field_has_spans` fired on unchecked
   checkboxes (box 13, CORRECTED) and on money boxes the model rendered as `0` or `$` with
   nothing to cite. §5 now names three readings of "empty" that are stored blank and never
   prompt; the CHECK constraint admits `value_bool = false` without a span. The read was
   correct; the app was arguing about its spelling.
3. **The wrong year, with no way to fix it.** A continuous-use 1099-INT prints "(Rev. January
   2024)" twice and "2025" once; the classifier and the text-layer heuristic both chose 2024.
   The prompt now says what tax_year is and is not, `dominantYear` strips revision dates and
   prefers "For calendar year", and the exact text layer overrides the model's year. A
   reviewer can also set a document's year in place (`PATCH /api/documents/:id`), which
   re-runs reconcile. Soft annotations can be acknowledged (a disposition without a required
   note), acknowledgements are carried across re-runs like hard dispositions, and the bundle
   view shows what has been decided rather than listing it forever.
4. **The Excel file was a total sheet, not a review tool.** A tax manager has to answer "was
   every document captured" and "was every box read right" before "do the totals tie". The
   workbook now carries: `Documents` (one row per page-group with issuer, taxpayer, year,
   pages, and how the read went), **one recap sheet per form type** laid out like the form —
   rows are the boxes in printed order, columns are each document, cells are the amounts as
   read, coloured and annotated where flagged or corrected, a blank cell for an empty box and
   0.00 for a printed zero, each column ending with its arithmetic checks — `Review Items`
   (everything waiting on a human), `Checks` (every check with its disposition), and
   `Provenance` (which model, which geometry source, per document). The `Worksheet` sheet's
   contributions hyperlink to their recap cells. `src/worksheet/review.ts` builds the model;
   the renderer is pure over it and unit-tested without a database.

*Affects:* P8, P9, P11, P12, §5, §6.

**2026-09-16 — Pipeline review: stage completion recorded, exact geometry for native pages, the binder given position, verification as the confidence signal, 1099-B per section, IRS-layout fixtures.**
An exhaustive review of the recognition path found the app could not finish a real client
packet, and would not have been accurate if it had. Eight changes, one change set, migration
0007. Each is a decision worth recording because each reverses something the build believed.

1. **Stage completion is recorded, never inferred.** "Layout is done when every page has a
   span row" stalled on any blank page (a blank page stores zero spans); "extraction is done
   when no document is still `classified`" stalled on any cover letter (never extracted, never
   left `classified`). Every real packet has both. `pages.layout_completed_at` / `span_count` /
   `layout_source` and `documents.extraction_outcome` / `extraction_completed_at` are written on
   every exit path, and `advanceAfterLayout` / `advanceAfterExtraction` are the only places a
   bundle moves stage. A reprocess from classify also now deletes the prior documents instead
   of doubling the list.
2. **Silent drops made loud.** `no_registered_schema` was written at extraction and deleted by
   reconcile's reset; it and a new `no_layout_spans` are now recomputed at reconcile from the
   document's recorded outcome. The registry resolves to the nearest registered year in either
   direction (a 2024 document in the pile is read, with a soft `schema_year_substituted`), and
   the classifier's free-string form type is normalized onto registry keys ("Form W2",
   "Schedule K-1 (Form 1065)", "SSA 1042-S") before lookup.
3. **Requeue exists.** `POST /api/bundles/:id/router-jobs/requeue` re-creates every parked or
   failed router job at the stage it stopped in; the bundle view shows failed jobs, which were
   invisible before (only `parked` was queried). "Re-queue" had been a word in the runbook with
   nothing behind it.
4. **Exact geometry from the text layer.** Revises the 2026-09-02 "VLM geometry kept" decision
   for native pages only: the sidecar measures PyMuPDF words with exact boxes, merges them into
   spans, and marks the page laid out; the vision layout pass runs only for raster pages. Cloud
   binding unchanged. No pixel leaves the appliance to obtain geometry for a native page, and
   the boxes are exact rather than estimated. Recorded per page as `layout_source`.
5. **The binder sees position.** It received `[index] text` with geometry stripped; on a W-2
   grid nothing tied "85,000.00" to box 1 rather than box 3. Spans are now serialized in rows,
   left to right, with x/y in thousandths, and the prompt explains the grid and multi-copy
   pages. `EXTRACT_ATTACH_PAGE_IMAGE` (default off) additionally sends the page image and
   registers the class as a vision class — the runbook binding is text-only, so it is opt-in.
6. **Verification replaces repetition as the confidence signal.** Two passes of the same prompt
   at temperature 0 against the same model agree whether or not they are right, so multi-pass
   agreement measured nothing at 2× cost (Q8 answered). Every bound value is now checked against
   the spans it cites (money in cents, text loosely) and flagged `span_mismatch` when absent —
   a new review reason and a new column-level rule. `EXTRACT_PASSES` defaults to 1; later
   passes run at a non-zero temperature and optionally against a second model. The §4 CHECK
   constraint was also wrong in the other direction: it rejected a *blank* field with no span,
   so the first real extraction would have failed on its first empty box. Relaxed in 0007.
7. **1099-B is one document per Form 8949 section.** The old schema had ten "repeating" fields
   and a flat bind response over a (document, field) unique index, so lots collapsed to one row
   and two sections shared one `section_code`. The classifier now reports the section letter,
   grouping splits on it, the schema carries the section subtotals printed at its foot, and
   `b_section_subtotals_foot_to_summary` runs on the container against `summary_proceeds`.
   Per-lot rows are a v2 question; Schedule D needs section totals.
8. **Fixtures from the IRS's own forms.** `fixtures/irs_forms.py` fills the official fillable
   PDFs (public US government works, kept in `fixtures/irs/`) with invented data, flattens
   them, and keeps Copy B. The new bundle also carries a cover letter, a blank page, a
   three-copies-on-one-page W-2, and a scanned W-2 — what a client packet actually contains.
   The synthetic drawings stay for the arithmetic cases they were built for.

Not done, and not claimable: no model has read any of it. The harness run is next and needs
the router provisioned per the runbook. *Affects:* P2, P4, P7, P8, P9, §4, §6, §8, Q8, Q17.

**2026-09-11 — Optional OCR fallback for pages with no text layer; sensitivity left to the firm.**
Added `v1040_ocr_transcribe`, requiring `vision` and deliberately not `json_schema`. That is
the only shape that can bind to the Router's `local_ocr` kind, which is pinned
`json_schema: false` — the Router's note records why, and it is the same mistake in a different
costume: a grammar constraint forces a 0.9B OCR model to invent a spans array rather than
refuse, producing confident garbage. The class asks for prose; this app parses it. Registered
only when `OCR_FALLBACK_ENABLED` is on, so a class nobody calls does not clutter the console.

**The app holds no opinion on this class's sensitivity**, by request. It is excluded from
`SENSITIVITY_CHECKED`, so no startup warning fires either way: a firm may bind it to a local
OCR server and keep every page image on the appliance, or to a cloud vision model for accuracy.
Both are legitimate and the trade is the firm's. The startup log reports how it resolved.

Available today: `ghcr.io/kisaesdevlab/vibe-glm-ocr`, CPU and CUDA. Two operational facts
decide whether it is usable. It was removed from the appliance on 2026-07-24 for footprint —
it reserved 2–3 GiB and the reference droplet dropped from $48 to $24/mo without it — so
re-adding it means an appliance change and roughly double the baseline. And the CPU image runs
40–60 s/page against 2–3 s on CUDA, which for a 41-page bundle is half an hour versus under two
minutes. On a GPU-less droplet this is impractical at any real volume.

Scope limit, deliberate: transcription only. It gives no geometry, so §6's blocking rule stands
and scanned documents stop for disposition. See Q17 for the three ways out. The text-layer case
needs none of it — PyMuPDF already returns exact words and boxes, which remains the better fix
and remains deferred.
*Affects:* P7, P8, §3, §4, §6.

---

## Known risks

| Risk | Phase | Mitigation |
|---|---|---|
| **Unscrubbed page images carrying SSNs egress to cloud providers** | P7, P8, P14 | Accepted 2026-08-26 — see decision log. WISP must name it (Q12); region pinning is the only remaining control (Q11) |
| **No region enforcement exists, so nothing prevents non-US inference** | P14 | Accepted 2026-09-02 for the DigitalOcean binding — contractual only (Q13). Q11 remains open for R6 |
| A general VLM returns plausible but imprecise span boxes | P7, P11 | Raster pages only since 2026-09-16; native pages carry exact PyMuPDF boxes (`layout_source`). Convention recorded per page; overlay checked at P7 verification |
| 0–1000 vs pixel convention ambiguity on a near-empty page | P7 | Page-level detection prefers the requested scale; convention stored on the page; worker warns on any other |
| Dense pages exceed the layout output budget | P7 | Budget 16384; one values-only retry; then `failed` with `json_truncated` in `router_jobs` for the operator |
| Classes stay pinned `local_only` if provisioning forgets the firm-admin widening | P7 | App cannot widen itself; add to the provisioning checklist and assert the effective tier at startup |
| Multi-pass is the only confidence signal, at ≥2× inference cost per field | P8 | Retired 2026-09-16 — verification against cited spans (`span_mismatch`) is the signal; passes default to 1 (Q8) |
| Constrained decoding may reduce accuracy on long documents vs prompt-based JSON | P8 | Validate empirically on fixtures; keep a re-prompt-and-validate fallback |
| Consolidated 1099 layouts vary widely by brokerage | P4, P9 | Build the fixture set from multiple brokerages before P4 exit; 1099-B sections split by the classifier's section letter (2026-09-16) |
| Classifier misfires now block, and section splitting depends on the classifier reading the 8949 heading | P4, P9 | Text-layer pre-classification cross-checks native pages and logs disagreement; measure on the IRS-layout fixtures |
| Base64 inflation pushes request bodies past Router limits during season | P7 | Largely retired — Router default is 10 MiB vs ~800 KB/page. Still measure encoded sizes at P2 exit and confirm the deployed value |
| K-1 renderings differ across UltraTax, CCH, Lacerte | P15 | Three-rendering fixture requirement in P15 exit criteria |
| Powered-off GPU droplets still bill if the Router ever provisions one | Router-side | Not this repo's concern, but flag to Router work |

---

## Fixture inventory

The build is only as good as the fixture set. Track what exists.

| Fixture | Have | Notes |
|---|---|---|
| Native digital W-2 | yes | `w2_robert_native.pdf`, `w2_maria_native.pdf` — blank box 7 vs printed `-0-` box 8 |
| Scanned W-2 | yes | `w2_robert_scanned.pdf` — image-only, no text layer, skew + speckle |
| Phone-photo W-2 | yes | `w2_robert_phone.jpg` — rotation, keystone, lighting gradient |
| Consolidated 1099, brokerage A | yes | `consolidated_brokerage_a.pdf` — 6 pages, 2 1099-B sections |
| Consolidated 1099, brokerage B | yes | `consolidated_brokerage_b.pdf` — **summary deliberately does not tie** |
| Consolidated 1099, brokerage C | yes | `consolidated_brokerage_c.pdf` — different layout again |
| CORRECTED 1099 | yes | `1099int_corrected.pdf` |
| 1099-R, code G rollover | yes | `1099r_code_g.pdf` — taxable amount not determined |
| 1095-A, full year | yes | `1095a_full_year.pdf` — 12 monthly rows footing to the annual row |
| Joint bundle, two TINs | yes | SSN + **ITIN**, documents split 5/1 |
| Bundle with planted prior-year document | yes | `1098_prior_year.pdf` — TY2024 in a TY2025 bundle |
| K-1 1065 with §199A statement | yes | all three K-1 fixtures carry a box 20 code Z statement page |
| K-1 from three different tax packages | yes | UltraTax / CCH / Lacerte renderings, visibly different layouts |
| **IRS-layout forms** (W-2, 1099-INT, -DIV, -R, -NEC, -MISC, 1098) | yes | `irs_*.pdf` — official fillable PDFs filled and flattened; Copy B only |
| W-2 with three copies on one page | yes | `irs_w2_three_copies.pdf` — payroll-vendor layout, identical values ×3 |
| Cover letter and blank page | yes | `cover_letter.pdf`, `blank_page.pdf` — the two pages that stalled every real bundle |

All fixtures must be synthetic or fully de-identified. Do not use live client documents as
test fixtures.

**Generated 2026-08-26** by `fixtures/generate.py` — 16 files, fully synthetic, deterministic.
Ground truth for every field lives in `test/fixtures/manifest.json`, including which boxes
are blank and which print a zero, so extraction tests can assert correctness rather than
merely that something came back. Regenerate with:

```bash
python fixtures/generate.py test/fixtures
```

**P2's exit criterion is now met**: the sidecar's own triage code was run against all 31
fixture pages and classified every one correctly — native PDFs to `text_layer`, the scanned
PDF and the phone photo to `raster`. Encoded page sizes ran 90–184 KB, comfortably inside
the ~800 KB budget (246 KB base64, 42x headroom against the router's 10 MiB limit). Note
these synthetic pages are sparser than real scans, so expect real documents to be larger.

**Still unproven:** classification, layout, and extraction accuracy against these fixtures,
because that needs a live router. The fixtures are ready for that the moment one is
available.
