# Vibe 1040 — runbook

Operator-facing. Install, upgrade, rollback, and the failure modes worth recognising on
sight during filing season.

---

## Install (fresh host)

Stock Ubuntu 24.04 with Docker. No Marketplace image, no NixOS.

```bash
git clone https://github.com/KisaesDevLab/Vibe-1040.git /opt/vibe-1040
cd /opt/vibe-1040
cp .env.example .env
```

### Package visibility — do this once, or the appliance will not enable the app

A GHCR package inherits its repository's visibility when it is **first created**, and this
repository is private. That made the v0.0.1 images private too, which the Vibe Appliance
console reports as **"image not published"** — its check asks GHCR's anonymous token
endpoint whether the image is publicly pullable, and a private package fails that check
exactly like a nonexistent one.

Set both packages public once, in the web UI. Visibility cannot be changed through the REST
API, and it is sticky — every later release stays public:

- https://github.com/users/KisaesDevLab/packages/container/vibe-1040/settings
- https://github.com/users/KisaesDevLab/packages/container/vibe-1040-sidecar/settings

Danger Zone → Change visibility → Public.

**The repository stays private.** The images carry only compiled code, the built review UI,
and the form-schema and mapping data — no docs, no `.env`, and not the WISP amendment.

The release workflow verifies this after every push and fails the release if it does not
hold, so a silently unusable release cannot ship again.

If you would rather keep the packages private, every host that pulls them needs a token
with `read:packages`, and the appliance console will not offer to enable the app:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u KisaesDevLab --password-stdin
```

Images published per release tag:

| image | tags |
|---|---|
| `ghcr.io/kisaesdevlab/vibe-1040` | `0.0.1`, `0.0`, `latest` |
| `ghcr.io/kisaesdevlab/vibe-1040-sidecar` | `0.0.1`, `0.0`, `latest` |

Pin a specific version in `.env` with `VIBE_1040_VERSION=0.0.1` rather than tracking
`latest`, so an upgrade is something you decide rather than something that happens.

Generate the three keys and put them in `.env`:

```bash
openssl rand -base64 32   # TIN_HASH_SALT           — back this up; not rotatable
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # STORAGE_ENCRYPTION_KEY  — back this up; loses every blob if lost
```

Set `SESSION_SECURE` to match how staff will actually reach the app. `true` if a reverse
proxy terminates HTTPS in front of it, `false` if it is served over plain HTTP. Getting this
wrong in the `true` direction does not degrade gracefully: the browser accepts the session
cookie, refuses to send it back, and sign-in loops forever with the password accepted and no
error on screen. On a Vibe Appliance this variable is rendered automatically per network
mode and should not be edited by hand. Leaving it unset falls back to
`NODE_ENV === 'production'`, which is only correct when production also means HTTPS.

Mint an app token in the router admin UI (App tokens → new, app `vibe-1040`) and set
`VIBE_AI_TOKEN`. Confirm the router is on the shared network:

```bash
docker network ls | grep vibe-suite   # create it if missing: docker network create vibe-suite
```

Bring it up:

```bash
docker compose up -d
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed
```

**Then provision the router** — the next section. Registration always creates the three
`v1040_*` classes `local_only`; the app cannot widen itself. Note that a local-only
configuration does **not** currently produce span geometry for the layout class (GLM-OCR via
`local_ocr` emits text without coordinates — QUESTIONS.md Q14), so "skip the widening and run
local" is not a working configuration for this app as built.

## Provisioning: Router → DigitalOcean

Decided 2026-09-02 (STATE.md decision log). All three task classes are served by
DigitalOcean-hosted open-source models chosen in router policy; the app never names a model.
Every step below is a router admin action (session cookie, not the app token) except 4, 7,
and 8. Base URL below is the router's admin API.

1. **Add the provider.** Providers → add "DigitalOcean (Gradient)": kind `digitalocean`, base
   URL `https://inference.do-ai.run/v1`, auth `api_key`. Then store the DigitalOcean *model
   access key*:
   `POST /admin-api/providers/:id/credentials {"apiKey": "..."}`. Test the connection.
2. **Discover models.** `POST /admin-api/providers/:id/discover-models`. Discovered rows
   arrive with `json_schema` only, no `vision`, and a placeholder 8192 context window. In the
   catalog editor set the real context windows: `glm-5.3-flash` 1,048,576;
   `qwen3.5-397b-a17b` 131,072 (this one is curated and may already be right).
3. **Probe for vision — required.** `POST /admin-api/models/:id/probe {"apply": true}` for
   `digitalocean/glm-5.3-flash`. The result must show `vision: supported`; if it is
   `inconclusive`, fix the credential and probe again. Without this, classify and layout fail
   with `capability_missing` or `no_vision_provider`. Probe `qwen3.5-397b-a17b` too.
4. **Start the app once** so the classes register. The startup log shows all three as
   `local_only (created)`.
5. **Widen the classes.** For each of `v1040_page_classify`, `v1040_layout`,
   `v1040_field_extract`:
   `PATCH /admin-api/task-classes/<key> {"sensitivity": "cloud_deidentified"}`. Audited.
6. **Bind policies.** `PUT /admin-api/policies/<key>`:
   - `v1040_page_classify` → `defaultModel: digitalocean/glm-5.3-flash`,
     `allowedModels: [glm-5.3-flash, kimi-k2.6]`, `fallbackChain: []`.
   - `v1040_layout` → same models; `maxTokensOverride` may stay unset (the class default is
     16384) or be raised if dense pages truncate.
   - `v1040_field_extract` → `defaultModel: digitalocean/qwen3.5-397b-a17b`,
     `allowedModels: [qwen3.5-397b-a17b, glm-5.3]`, `fallbackChain: []`.
   Leave `temperatureMin` unset — the app sends `temperature: 0` on the first binding pass
   and `EXTRACT_SECOND_PASS_TEMPERATURE` on any later one. If `EXTRACT_ATTACH_PAGE_IMAGE` is
   on, `v1040_field_extract` registers as a vision class and must be bound to a vision-probed
   model (`glm-5.3-flash`), not `qwen3.5-397b-a17b`. **Never add an Anthropic- or OpenAI-on-DigitalOcean model** to these
   policies; the WISP names DigitalOcean-hosted open models only (docs/wisp-amendment.md §3).
7. **Set the app environment.** `ROUTER_EXPECTED_SENSITIVITY=cloud_deidentified` and
   `ROUTER_REQUIRE_US_REGION=false`. The second one is a recorded decision (STATE.md
   2026-09-02, QUESTIONS.md Q13), not a development shortcut; do not set it without having
   read both.
8. **Restart and check the log.** Expect `[startup] task class …: cloud_deidentified` three
   times and the `ROUTER_REQUIRE_US_REGION=false` warning. Anything still `local_only` means
   step 5 was missed.

### Comparing models

The accuracy harness is the only arbiter of which model is better on these forms. To compare:

1. Upload the fixture bundle once **per candidate binding** — spans are immutable per page and
   the layout job short-circuits when the page is marked laid out, so a re-run on the same
   bundle proves nothing. Content-hash dedup flags the second upload as a duplicate but does
   not block it. Use `test/fixtures/irs_*.pdf` plus `cover_letter.pdf` and `blank_page.pdf`
   (the `irs-official-forms-2025` bundle): those are real IRS layouts, and the two non-form
   pages are what every client packet contains.
2. Between runs change only the router policy (step 6). Never change the app.
3. Let classification finish, confirm identity in the UI, let extraction finish. Check
   `router_jobs` for the bundle is empty.
4. `npm run accuracy -- <bundleId> --json > runs/<date>-<model>.json`. The report names the
   models that actually served the bundle and the coordinate convention the layout model
   returned. Compare blank-vs-zero first, classification second, orphan spans third, the
   headline number last.
5. Record the winning binding in STATE.md's decision log.

## Releasing a new version

Tagging is what publishes. `.github/workflows/release.yml` runs the typecheck, the test
suite, and the provider-leakage check *before* it pushes anything — a tag is not a reason to
skip the gate.

```bash
git tag -a v0.0.2 -m "what changed"
git push origin v0.0.2
```

The build needs `@kisaes/vibe-ai-client`, which is not on a public registry. CI checks the
(public) Vibe-AI-Router repository out and builds the SDK from source, so no registry token
is involved. To build an image locally:

```bash
mkdir -p vendor && cp -r ../Vibe-AI-Router/packages/sdk vendor/sdk
docker build -t vibe-1040 .
```

`vendor/` is gitignored — that is BUSL code belonging to another repository and is not
committed here.

## Upgrade

Manual, on the operator's schedule. There are no auto-update timers.

```bash
cd /opt/vibe-1040
git pull
docker compose pull
docker compose up -d
docker compose exec api npm run db:migrate
```

## Rollback

```bash
docker compose exec api npm run db:rollback    # one migration at a time
VIBE_1040_VERSION=<previous-tag> docker compose up -d
```

Roll the migration back **before** pinning the older image, or the older code will meet a
newer schema.

## Failure modes

### "Refusing to start: the router does not expose region pinning"

Expected as of router v0.0.24 — the capability does not exist yet (QUESTIONS.md Q11), and
DigitalOcean serverless inference has no region control to report anyway. For the
DigitalOcean binding this deployment runs with `ROUTER_REQUIRE_US_REGION=false` by recorded
decision (STATE.md 2026-09-02, QUESTIONS.md Q13). Read both before setting it.

### `router_jobs` shows `invalid_response` with `json_truncated`

The layout model ran out of output budget on a dense page, the router retried and gave up,
and the app's one values-only retry also overran. The job is `failed`, not parked. Raise
`maxTokensOverride` on the `v1040_layout` policy, or accept that the page's back-page
instruction text will not be transcribed, and re-queue the page.

### `router_jobs` shows `capability_missing` or `no_vision_provider`

The class is bound to a model whose vision capability was never probed and enabled
(Provisioning step 3). Probe with `apply: true`, then re-queue. Parked, not failed.

### Worker log says "returned pixel coordinates, not the requested 0–1000 scale"

The layout model changed — most likely a policy edit swapped models — and the new one uses a
different coordinate convention. The app normalized it and recorded the convention on the
page, so nothing is wrong yet, but open one of those pages in the review UI and confirm the
boxes sit on the text before trusting the season's overlays.

### The UI says "Router unreachable — work is parked", or "N router job(s) failed"

The router is down or the app token is wrong. Work is parked, not lost: nothing failed the
bundle. Check `docker compose logs api`, verify the router is up, then **Retry parked/failed
jobs** in the bundle header (admin or partner; `POST /api/bundles/:id/router-jobs/requeue`).
Each job is re-created at the stage it stopped in — a layout page, a document binding, or the
whole classification — and the failure row is kept as `requeued`. A failed job (permanent
router code such as `invalid_response`) is retried the same way once the cause is fixed.

```bash
docker compose exec postgres psql -U vibe1040 -c \
  "select task_class, state, last_error_code, count(*) from router_jobs group by 1,2,3;"
```

`auth_error` means the app token is bad — mint a new one and restart. `scrubber_blocked` is
not retryable: the router refused to send protected data to a cloud provider for that task
class, and retrying sends the same data again.

### A bundle sits in `blocked`

That is the arithmetic gate doing its job (§6). Open the bundle in the review UI; each hard
failure needs a human disposition with a note. The gate has no bypass and no force flag —
if you find yourself wanting one, the answer is a disposition, not a code change.

### A page image shows "Page image purged"

Normal. The raster passed `RETENTION_RASTER_DAYS` and was disposed of on schedule. The
extracted values and their coordinates survive; only the pixels are gone.

### Extraction is slower or costlier than expected

Native pages cost no layout inference at all: their spans come from the PDF text layer in the
sidecar (`pages.layout_source = 'text_layer'`). Only raster pages go to `v1040_layout`. Binding
costs `EXTRACT_PASSES` inferences per document (default 1), escalating to
`EXTRACT_PASSES_ON_DISAGREEMENT` when passes disagree. Misread detection does not depend on
the pass count — every bound value is verified against the spans it cites (`span_mismatch`).

### A bundle sits in `extracting`

Since 0007 this means work is genuinely outstanding: a page without a layout outcome or a
document without an extraction outcome. Open the bundle; parked or failed router jobs show in
the header with a retry button. `select id, layout_completed_at, layout_source, span_count from
pages where bundle_id = …` and `select form_type, extraction_outcome from documents where
bundle_id = …` name what is still open.

## Retention

```bash
RETENTION_DRY_RUN=true docker compose exec api npm run retention   # preview
docker compose exec api npm run retention                          # execute
```

Every disposal writes to `purge_log` with the policy days and the age that justified it.
Nothing purges without a policy match.

Schedule it with cron on the host:

```
17 3 * * *  cd /opt/vibe-1040 && docker compose exec -T api npm run retention >> /var/log/vibe-1040-retention.log 2>&1
```

## Backups

Three things must be backed up together, or a restore produces an appliance that cannot
read its own data:

1. Postgres (`pgdata` volume)
2. Blob storage (`blobs` volume, or the B2 bucket)
3. `.env` — specifically `TIN_HASH_SALT` and `STORAGE_ENCRYPTION_KEY`

Losing the blob key loses every source document and page image. Losing the TIN salt orphans
every taxpayer record, since the join key can no longer be re-derived.

## Health

```bash
curl -s localhost:8240/health
docker compose ps
docker compose logs -f worker    # pipeline progress, one JSON line per job
```
