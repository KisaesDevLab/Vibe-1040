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

**Then, in the router admin UI**, widen the three `v1040_*` task classes from `local_only`
to `cloud_deidentified` if this deployment intends to use cloud models. Registration always
creates them local-only; the app cannot widen itself. If you skip this, everything runs on
local models — which is a legitimate configuration, just be aware it is the one you have.

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

Expected as of router v0.0.24 — the capability does not exist yet (QUESTIONS.md Q11). For a
development or local-only deployment, set `ROUTER_REQUIRE_US_REGION=false`. Do not set it
for live client data on a cloud-bound task class.

### The UI says "Router unreachable — work is parked"

The router is down or the app token is wrong. Work is parked, not lost: nothing failed the
bundle. Check `docker compose logs api`, verify the router is up, then re-queue.

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

Multi-pass agreement is the only confidence signal the router surfaces (QUESTIONS.md Q4), so
every field extraction costs at least `EXTRACT_PASSES` inferences, escalating to
`EXTRACT_PASSES_ON_DISAGREEMENT` when passes disagree. Lowering `EXTRACT_PASSES` to 1
removes the only misread detection the system has.

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
