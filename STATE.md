# Vibe 1040 — STATE.md

Current state of the build. Update at the close of every phase and whenever a blocking
condition changes. This file is the single source of truth for where the build stands —
do not infer progress from the commit log.

---

## Current position

**Phase:** P0 — Scaffolding
**Status:** not started
**Blocked by:** QUESTIONS.md Q1 (stack confirmation) must be answered before P0 begins.

---

## Phase ledger

| Phase | Name | Status | Notes |
|---|---|---|---|
| P0 | Scaffolding | not started | blocked on Q1 |
| P1 | Ingestion and storage | not started | |
| P2 | Rasterization and text-layer triage | not started | |
| P3 | Router client | not started | needs Router OpenAPI spec |
| P4 | Page classification and bundle splitting | not started | see Q2 |
| P5 | Identity resolution | not started | |
| P6 | Form schema registry | not started | |
| P7 | Layout pass | not started | **gated on Router R1–R3** |
| P8 | Field-binding extraction | not started | |
| P9 | Arithmetic reconciliation gate | not started | |
| P10 | 1040 line mapping engine | not started | |
| P11 | Review UI | not started | |
| P12 | Worksheet generation | not started | |
| P13 | Retention and disposal | not started | |
| P14 | Compliance hardening and packaging | not started | |
| P15 | K-1 support | not started | severable |

---

## External dependencies

| Dependency | Needed by | Status |
|---|---|---|
| Router R1 — multimodal request envelope | P7 | not started |
| Router R2 — provider capability matrix | P2 (config), P7, P8 | not started |
| Router R3 — task classes registered | P7, P8 | not started |
| Router R4 — body-size limits raised | P7 | not started |
| Router R5 — US-region pinning + policy reporting | P3, P14 | not started |
| Router OpenAPI spec published | P3 | unknown — confirm |
| DigitalOcean DPA executed | before live client data | not started |
| WISP amendment drafted | P14 | not started |

---

## Decisions locked

These were settled in requirements and are not open for revisiting mid-build. Changing one
requires an explicit decision entry below, not a silent implementation choice.

- Staff-only internal upload. No client portal.
- HTTP client to a separately deployed Router. No bundled Router, no direct provider calls.
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

_(empty)_

---

## Known risks

| Risk | Phase | Mitigation |
|---|---|---|
| `document.classify` was built filename-only and does not accept page images | P4 | Q2 — confirm before P4; may become Router work |
| Constrained decoding may reduce accuracy on long documents vs prompt-based JSON | P8 | Validate empirically on fixtures; keep a re-prompt-and-validate fallback |
| Consolidated 1099 layouts vary widely by brokerage | P4, P9 | Build the fixture set from multiple brokerages before P4 exit |
| Base64 inflation pushes request bodies past Router limits during season | P7 | Router R4; measure encoded sizes at P2 exit |
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
