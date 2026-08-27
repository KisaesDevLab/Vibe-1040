# Vibe 1040

A staff-facing appliance that ingests a client's 1040 source-document bundle, reads the
dollar amounts off each form, and emits a **standardized worksheet of totals keyed to Form
1040 and schedule line numbers**. A preparer opens the worksheet next to the prepared
return and eyeball-compares.

It does not ingest the prepared return, does not compute tax, and does not decide
characterization questions. See `CLAUDE.md` §2 for the scope boundaries and §9 for what
lands in Judgment Required instead of being guessed at.

---

## Requirements

- Docker and Docker Compose, on stock Ubuntu 24.04
- A reachable **Vibe AI Router** on the shared `vibe-suite` network
- An app token minted in the router's admin UI

This app holds no provider credentials. All inference goes through the router (§3).

## First run

```bash
cp .env.example .env
# Fill in: VIBE_AI_TOKEN, and generate the three 32-byte keys:
#   openssl rand -base64 32   # TIN_HASH_SALT
#   openssl rand -base64 32   # SESSION_SECRET
#   openssl rand -base64 32   # STORAGE_ENCRYPTION_KEY

docker compose up -d
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed     # prints a generated admin password
```

Then open `http://localhost:8240`, sign in, and complete MFA enrolment. MFA is mandatory —
a session is not usable until the second factor is satisfied.

> **`TIN_HASH_SALT` is not rotatable in place.** It is the salt for the client join key;
> changing it orphans every taxpayer record already stored. Generate it once per
> deployment and back it up with the rest of the secret store.

## It will refuse to start

By design. `ROUTER_REQUIRE_US_REGION=true` makes the app assert at startup that the router
reports US-region pinning for its three task classes, and **fail closed** if it does not
(§11).

As of router v0.0.24 that capability does not exist — there is no region concept in the
router at all. Until it lands (QUESTIONS.md Q11), development deployments must set:

```
ROUTER_REQUIRE_US_REGION=false
```

Do not set that for live client data. Because these task classes are `cloud_deidentified`
and the router's scrubber cannot scrub image parts, this assertion is the only control
keeping taxpayer page images inside US inference.

## Task classes

Registered by this app at startup, per the router's `<app>_<purpose>` convention:

| key | requires | phase |
|---|---|---|
| `v1040_page_classify` | vision, json_schema | page-level form-type classification |
| `v1040_layout` | vision, json_schema | layout pass — spans with page geometry |
| `v1040_field_extract` | json_schema | binds schema fields to span ids |

A class the router has never seen is created **`local_only` regardless of what this app
asks for**. Widening to `cloud_deidentified` is a firm-admin action in the router admin UI
that this app cannot perform for itself — if provisioning skips it, everything runs on
local models and the startup log says so.

## Development

```bash
npm install
node scripts/link-sdk.mjs ../Vibe-AI-Router   # the SDK is private; link a local checkout
npm test
npm run typecheck
npm run check:providers
npm run dev

cd ui && npm install && npm run dev           # review UI on :5240, proxies /api to :8240
```

The Python sidecar owns rasterization and text-layer triage:

```bash
cd sidecar && pip install -r requirements.txt && python worker.py
```

## Layout

| path | what |
|---|---|
| `src/router/` | the only place that talks to the router |
| `src/schemas/` | form schema registry — loads `data/form-schemas/` at runtime |
| `src/layout/`, `src/extract/` | the two-pass extraction (§4) |
| `src/reconcile/` | the arithmetic gate (§6) — `gate.ts` is the one door |
| `src/mapping/` | 1040 line mapping engine (P10) |
| `src/worksheet/` | XLSX and bookmarked PDF |
| `data/form-schemas/` | 27 form schemas; adding one is a data change |
| `data/line-mappings/` | per-tax-year box → line mapping |
| `data/tax-tables/` | wage bases and rates, per year |
| `sidecar/` | Python: PyMuPDF, pypdfium2, Pillow |
| `ui/` | React review UI with bounding-box overlay |

## Adding a tax year

Three data files, no code:

1. `data/form-schemas/ty<year>/` — only forms whose layout changed; the registry falls
   back to the most recent earlier year otherwise.
2. `data/line-mappings/<year>.json`
3. `data/tax-tables/<year>.json`

## Operations

```bash
npm run db:migrate      # forward
npm run db:rollback     # back one migration
npm run retention       # purge per the retention schedule; RETENTION_DRY_RUN=true to preview
```

Retention runs on the operator's schedule — there are no auto-update timers. Rasterized
page images are derived PII and purge earlier than their source documents; the config
refuses to start if that ordering is inverted.

## Documentation

- `CLAUDE.md` — what this is, what it is not, and the rules that must not be softened
- `PHASES.md` — P0–P15 with exit criteria
- `STATE.md` — where the build actually stands
- `QUESTIONS.md` — open items, including the two that block P14 and live client data
- `docs/wisp-amendment.md` — the WISP language this deployment requires
- `docs/runbook.md` — install, upgrade, rollback, incident response
