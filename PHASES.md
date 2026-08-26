# Vibe 1040 — PHASES.md

Sixteen phases, P0 through P15. Each phase lists its dependency, its deliverable, and the
exit criteria that must pass before the next phase starts. A phase is not complete until
its exit criteria are demonstrably met and STATE.md is updated.

**Hard external dependency:** Router phases R1–R3 in `vibe-ai-router-PHASES-addendum.md`
must land before P7 here. P0–P6 can proceed in parallel with Router work.

---

## P0 — Scaffolding

**Depends on:** nothing. **Blocks:** everything.

Repo, Docker Compose stack, Postgres with migration tooling, BullMQ + Redis, the Python
sidecar worker skeleton, GHCR build and publish pipeline, staff auth with MFA, and
audit-log middleware wired before any route that touches taxpayer data.

Configuration surface: `ROUTER_BASE_URL`, `ROUTER_TOKEN`, `TIN_HASH_SALT`, storage
backend selection, retention schedule.

**Exit:** stack comes up clean from `docker compose up` on a fresh host, a staff user can
authenticate with MFA, an authenticated request writes an audit row, migrations run
forward and back.

---

## P1 — Ingestion and storage

**Depends on:** P0.

Staff upload of a bundle — one or many PDFs, plus loose images. Content hashing for
dedup. Blob storage abstraction with a local encrypted volume driver and a B2 driver
following the Filer pattern. Bundle and document records. Original files are immutable
once written.

**Exit:** a 60-page mixed bundle uploads, stores, and reloads byte-identical. Re-uploading
the same bundle is detected as a duplicate. Storage driver swaps by config with no code
change.

---

## P2 — Rasterization and text-layer triage

**Depends on:** P1.

Per page, probe the embedded text layer with PyMuPDF. If it is empty or CID-garbled,
route the page down the raster path with pypdfium2; otherwise keep the text layer
available for footing checks alongside the raster.

Rasterize at 300 DPI baseline, 200 for clean digital PDFs, 400 for degraded scans.
Grayscale JPEG encoding. Downscale to the provider capability ceiling before encoding —
this depends on Router R2 but should be written against a config value until then.

**Exit:** across a fixture set of native PDFs, scans, and phone photos, the triage decision
is correct on every page. Encoded page sizes sit within the documented budget. Page
records carry DPI, encoding, and text-layer flag.

---

## P3 — Router client

**Depends on:** P0. Router R1 recommended but not strictly required to stub.

Generate the client from the Router OpenAPI spec into `src/router-client/`. Job wrapper
handling retry, backoff, and Router-unavailable parking. Startup assertion that the
Router reports US-pinned policy for the two task classes this app consumes.

CI check: grep for provider hostnames and SDK imports outside documentation, fail the
build on any hit.

**Exit:** a round-trip call to a stub task class succeeds. Router down parks the job and
surfaces cleanly in the UI rather than failing the bundle. The provider-leakage CI check
passes and demonstrably fails when a provider hostname is introduced.

---

## P4 — Page classification and bundle splitting

**Depends on:** P2, P3.

Page-level form-type classification via the existing `document.classify` task class —
confirm its response shape fits page images before relying on it, and raise a QUESTIONS.md
entry if it was built filename-only.

Group contiguous pages into logical documents. Detect CORRECTED and VOID checkboxes as
first-class fields at this stage, not buried in extraction.

Consolidated brokerage 1099 packages get container treatment: detect internal sub-form
boundaries, register each sub-form as its own document with a parent link, and identify
the summary page and the supplemental non-form pages.

**Exit:** on a fixture bundle containing a consolidated 1099, page grouping is correct,
sub-forms are individually addressable, supplemental pages are marked as such, and a
CORRECTED 1099 in the pile is flagged.

---

## P5 — Identity resolution

**Depends on:** P4.

Extract candidate TINs, names, and tax years per document. Salted-hash the TINs, store
last four in plaintext only. Propose a client and a tax year for the bundle. Present a
confirmation gate to the reviewer; nothing commits until confirmed.

Handle multiple TINs in one bundle. Flag per-document tax-year mismatches against the
bundle majority.

**Exit:** a joint-return bundle with documents split across two TINs proposes both and
lets the reviewer confirm. A planted prior-year 1098 is flagged. No plaintext SSN exists
anywhere in the database — verify by direct query, not by inspection.

---

## P6 — Form schema registry

**Depends on:** P0.

Declarative per-form schemas: form type, tax year, field list with box identifiers, types,
nullability, and the validation rules that apply. Registry is data, loaded at runtime, not
compiled in. Schema versioning is per tax year.

Every field nullable. No defaults. Ship all form types listed in CLAUDE.md §8 except
K-1s, which register in P15.

**Exit:** every non-K-1 form type has a registered TY2025 schema. Adding a new form type
requires no code change. Schema validation rejects a malformed registration at load.

---

## P7 — Layout pass

**Depends on:** P2, P3, P6, **Router R1–R3**.

Call `document.layout` per page. Store returned text spans with page-relative geometry
verbatim as the provenance substrate. Spans are immutable once written.

**Exit:** span geometry renders correctly as an overlay on the source page image at
multiple zoom levels and DPIs. Span storage round-trips without coordinate drift.

---

## P8 — Field-binding extraction

**Depends on:** P6, P7.

Call `document.extract.tax_form` with layout output plus the registered schema. Bind
schema fields to span IDs. Emit `null` for blank boxes, `0` only where a zero is printed.
Any field with empty `span_ids` is force-routed to review regardless of reported
confidence.

Multi-pass agreement: run N passes, compare, flag disagreement. Wire confidence scoring
from whatever the Router surfaces per R2.

**Exit:** on a labeled fixture set, every emitted field carries at least one span ID or is
force-flagged. Blank versus zero is correctly distinguished on a fixture W-2 with an empty
box 12 and a printed zero elsewhere. Injecting a deliberate misread is caught by
multi-pass disagreement.

---

## P9 — Arithmetic reconciliation gate

**Depends on:** P8.

Implement every hard and soft check in CLAUDE.md §6. Hard failures block worksheet
emission until dispositioned by a human. Soft failures annotate. Tolerance $1 per document,
configurable.

Wage base and rate tables are per-tax-year data, not constants in code.

**Exit:** a fixture W-2 with box 4 inflated past 6.2% of box 3 blocks. A fixture
consolidated 1099 whose sections do not foot blocks. A legitimate 401(k)-driven box 1 vs
box 3 difference annotates and proceeds. The gate cannot be bypassed by any code path.

---

## P10 — 1040 line mapping engine

**Depends on:** P6, P9.

Versioned per-tax-year mapping from form box to 1040 or schedule line. Roll per-document
values up to per-line totals, retaining the contributing document references. Route
non-clean mappings into the Judgment Required section per CLAUDE.md §9 rather than
guessing.

TY2025 must include Schedule 1-A totaling to line 13b. Line 1z reports gross wages
including tips and overtime as printed on the W-2; the app does not compute the new
deductions.

**Exit:** mapping table for TY2025 covers every registered form type. A line total equals
the sum of its non-null contributors and separately reports the null count. Every
Judgment Required category in §9 routes correctly. Adding TY2026 is a data change only.

---

## P11 — Review UI

**Depends on:** P8, P9, P10.

Side-by-side page image with bounding-box overlay, editable field values, confidence
highlighting, per-field accept and correct actions, hard-failure disposition workflow, and
a live worksheet preview grouped by 1040 line.

Every correction writes an audit row with before, after, user, and timestamp. Corrections
never overwrite the model's original output — they layer over it.

**Exit:** a reviewer can walk a full bundle, correct a misread field, disposition a hard
failure, and see the worksheet total update. The original model output remains
recoverable after correction. Clicking any worksheet number lands on the source pixels.

---

## P12 — Worksheet generation

**Depends on:** P10, P11.

XLSX and bookmarked PDF, both organized in standard 1040 order with a table of contents.
Per-line totals with per-document detail beneath. Provenance references to document and
page. Judgment Required section. Soft-failure annotations. Correction indicators where a
human overrode the model.

Prior-year comparison column is stubbed and empty for v1 — no client master, no prior-year
data. Leave the column in the layout so season two does not require a redesign.

**Exit:** both formats generate from the same bundle and reconcile to each other and to
the UI. Bookmarks land on the right sections. A preparer can compare the worksheet to a
return without opening the app.

---

## P13 — Retention and disposal

**Depends on:** P1, P12.

Enforcing retention job. Rasterized page images are derived PII and purge on their own
schedule, independent of source PDFs and earlier than them. Documented disposal with audit
trail. Configurable schedule per firm policy.

**Exit:** a bundle past its raster retention window has its page images purged while
source documents and extracted data survive. Purge is audited. Nothing purges without a
policy match.

---

## P14 — Compliance hardening and packaging

**Depends on:** P13.

Startup assertion on Router US-region pinning, failing closed. Full audit-log review pass
across every taxpayer-data route. Encryption-at-rest key handling review. WISP amendment
document drafted and shipped in `docs/`. Licensing check stubbed at the standard
integration point, feature-flagged off. GHCR release, versioned compose file, upgrade and
rollback documentation.

**Exit:** app refuses to start against a Router reporting a non-US policy. Every
taxpayer-data route audits. A clean install from GHCR on a fresh host reaches a working
state from documentation alone.

---

## P15 — K-1 support

**Depends on:** P14. Deliberately last.

Register K-1 (1065, 1120-S, 1041) schemas. Extract printed boxes only. Detect and attach
footnote and statement pages — including box 20 code Z §199A statements — to the worksheet
unparsed for the preparer to read.

No line dispersion onto the worksheet. Every K-1 lands in Judgment Required in v1.

**Exit:** K-1s from at least three different tax software renderings extract their printed
boxes correctly. Footnote pages attach and are readable in the PDF worksheet. No K-1 value
appears as a 1040 line total.

---

## Sequencing notes

P0–P6 are Router-independent and can run while the Router addendum is in flight. P7 is the
first hard gate on external work.

P9 is the phase most likely to expose bad extraction assumptions from P8. If P9 exit
criteria fight back, the problem is usually in P8's binding or P6's schema, not in the
checks. Do not weaken the gate to make P9 pass.

P15 is severable. Shipping P0–P14 is a complete, useful product.
