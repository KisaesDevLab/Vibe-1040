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

**NOT verified:**

- The appliance image has never been built or run — `docker compose up` covered Postgres
  and Redis only, because the API image needs the private SDK from the suite registry.
  "Clean install from GHCR on a fresh host" (P14) remains unproven.
- No inference has ever been performed. Classification, layout, and field binding are
  written against the SDK's contract but have never received a real model response.
- **The fixture set is still empty.** Every phase whose exit criterion says "on a fixture
  set" is unproven — P2 triage accuracy, P4 consolidated-package splitting, P8 blank-vs-zero
  on a real W-2, P15 K-1 renderings. This is the largest gap and it is not closeable by
  writing more code.

Treat the build as a complete, self-consistent implementation awaiting its first contact
with real documents.

---

## Phase ledger

| Phase | Name | Status | Notes |
|---|---|---|---|
| P0 | Scaffolding | implemented | compose/migrations/auth/audit written; **not yet run on a host** |
| P1 | Ingestion and storage | implemented | ingest + content-hash dedup + encrypted blob store (local & B2) |
| P2 | Rasterization and text-layer triage | implemented | Python sidecar: PyMuPDF triage, grayscale JPEG raster; **needs fixtures** |
| P3 | Router SDK integration | implemented | SDK client, error taxonomy, parking, leakage check verified |
| P4 | Page classification and bundle splitting | implemented | v1040_page_classify + grouping + consolidated containers |
| P5 | Identity resolution | implemented | salted HMAC TIN, ITIN-aware, human confirmation gate |
| P6 | Form schema registry | implemented | **27 form schemas**; all fields nullable; validated at load |
| P7 | Layout pass | implemented | spans normalized 0..1 on receipt, immutable, model recorded |
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
| Router R5 — US-region pinning + policy reporting | P14 | **does not exist** — no region concept anywhere in the Router. Real work, must be scheduled. See Q11 |
| Router image scrubbing (proposed preprocess stage) | — | proposed, pending operator decision D7. **Not a dependency** — exposure accepted, see decision log |
| Firm-admin widening of the three classes to `cloud_deidentified` | P7 | not started — app cannot widen itself; must be part of provisioning |
| Router OpenAPI spec published | P3 | **moot** — no spec exists; SDK is the contract (Q3) |
| DigitalOcean DPA executed | before live client data | not started |
| WISP amendment drafted — must name unscrubbed page-image egress | P14 | not started — see Q12 |

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

**2026-08-26 — Startup assertion is region-based, not sensitivity-based.**
A local_only assertion was considered and rejected as inconsistent with the
`cloud_deidentified` tier — the app would refuse to start against its own registration.
P14 therefore blocks on Router region pinning landing. *Affects:* P3, P14.

---

## Known risks

| Risk | Phase | Mitigation |
|---|---|---|
| **Unscrubbed page images carrying SSNs egress to cloud providers** | P7, P8, P14 | Accepted 2026-08-26 — see decision log. WISP must name it (Q12); region pinning is the only remaining control (Q11) |
| **No region enforcement exists, so nothing prevents non-US inference** | P14 | Q11 — Router work, must land before P14 exits |
| Classes stay pinned `local_only` if provisioning forgets the firm-admin widening | P7 | App cannot widen itself; add to the provisioning checklist and assert the effective tier at startup |
| Multi-pass is the only confidence signal, at ≥2× inference cost per field | P8 | Q4/Q8 — budget for it; do not promise calibrated confidence in the UI |
| Constrained decoding may reduce accuracy on long documents vs prompt-based JSON | P8 | Validate empirically on fixtures; keep a re-prompt-and-validate fallback |
| Consolidated 1099 layouts vary widely by brokerage | P4, P9 | Build the fixture set from multiple brokerages before P4 exit |
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
