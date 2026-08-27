# Vibe 1040 — STATE.md

Current state of the build. Update at the close of every phase and whenever a blocking
condition changes. This file is the single source of truth for where the build stands —
do not infer progress from the commit log.

---

## Current position

**Phase:** P0 — Scaffolding
**Status:** not started — **unblocked, ready to begin**
**Blocked by:** nothing. Q1 was answered 2026-08-26 (TypeScript primary + Python sidecar).

Router integration was verified against Vibe-AI-Router **v0.0.24** on 2026-08-26. Four of
the five assumed Router dependencies already exist; the region-pinning one does not exist
at all. See External dependencies below and QUESTIONS.md Q11.

---

## Phase ledger

| Phase | Name | Status | Notes |
|---|---|---|---|
| P0 | Scaffolding | not started | **unblocked** — Q1 answered 2026-08-26 |
| P1 | Ingestion and storage | not started | |
| P2 | Rasterization and text-layer triage | not started | |
| P3 | Router SDK integration | not started | no codegen — depends on `@kisaes/vibe-ai-client` (Q3) |
| P4 | Page classification and bundle splitting | not started | registers `v1040_page_classify` (Q2) |
| P5 | Identity resolution | not started | |
| P6 | Form schema registry | not started | |
| P7 | Layout pass | not started | **no longer gated** — envelope + vision already shipped |
| P8 | Field-binding extraction | not started | multi-pass is the only confidence signal (Q4) |
| P9 | Arithmetic reconciliation gate | not started | |
| P10 | 1040 line mapping engine | not started | |
| P11 | Review UI | not started | |
| P12 | Worksheet generation | not started | |
| P13 | Retention and disposal | not started | |
| P14 | Compliance hardening and packaging | not started | **gated on Router region pinning (Q11)** |
| P15 | K-1 support | not started | severable |

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
| Native digital W-2 | no | |
| Scanned W-2 | no | |
| Phone-photo W-2 | no | |
| Consolidated 1099, brokerage A | no | need at least three brokerages |
| Consolidated 1099, brokerage B | no | |
| Consolidated 1099, brokerage C | no | |
| CORRECTED 1099 | no | |
| 1099-R, code G rollover | no | |
| 1095-A, full year | no | |
| Joint bundle, two TINs | no | |
| Bundle with planted prior-year document | no | |
| K-1 1065 with §199A statement | no | P15 |
| K-1 from three different tax packages | no | P15 |

All fixtures must be synthetic or fully de-identified. Do not use live client documents as
test fixtures.
