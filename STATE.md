# Vibe 1040 — STATE.md

Current state of the build. Update at the close of every phase and whenever a blocking
condition changes. This file is the single source of truth for where the build stands —
do not infer progress from the commit log.

---

## Current position

**Phase:** P0–P15 — **all phases implemented 2026-08-26**; **P16 (single sign-on) implemented
2026-09-19**, merged to main 2026-09-22 (PR #1, merge `84c3918`) and **released as v0.10.0**
the same day so the appliance can register against a real image. **P17 (draft return via
OpenTax) — implemented 2026-09-25**, all three stages, carrying migration 0012.
**Status:** P0–P16 code complete and **integration-unverified**; P17 code complete and
**scored against the real engine v2.0.4** — 13 of 13 comparable lines agree (see below).
**Blocked by:** nothing for development. P14 cannot *exit* until Router region pinning
lands (QUESTIONS.md Q11). P16 cannot *exit* until it has been signed into from a real browser
against a real Vibe Auth (below). P17 cannot *exit* until Q21 is answered and the fixture
harness has scored; `DRAFT_RETURN_ENABLED` stays off wherever there is live client data.

Router integration was verified against Vibe-AI-Router **v0.0.24** on 2026-08-26. Four of
the five assumed Router dependencies already exist; the region-pinning one does not exist
at all. See External dependencies below and QUESTIONS.md Q11.

### What "code complete" means here, precisely

**Verified by execution on 2026-09-25 (second pass) — the real engine, at last.**

`opentax-linux-x64` from release **v2.0.4** (SHA-256 `7f0911050f7f34e1…aaaa02d4`) was downloaded,
run, and driven through the wrapper over HTTP. Docker is unavailable in that environment so
`opentax/Dockerfile` is still unbuilt, but the binary is glibc and the host is Ubuntu 24.04, so
pointing `OPENTAX_BIN` at it proves the engine and the wrapper without the image.

- **`npm run draft -- --truth` scores 13 agreed, 0 disagreed, 2 not compared, exit 0 — against
  the real engine.** Every income and withholding line that was hand-derived from the printed
  boxes now matches an engine figure exactly: line 1a at 127,000.00 and 255,000.00, line 25a at
  15,440.00 and 34,260.00, line 2b at 1,946.00 and 764.00, line 3b at 16,114.00 and 3,187.00,
  line 3a at 14,683.00 and 2,914.00.
- Seeded with a misrouted node field (W-2 box 1 aimed at `box7_ss_tips`), it reports
  `1040:1a expected 127,000.00, engine —` and exits 1. Restored, exit 0.
- 330 tests pass across 27 files, none skipped, with a real Postgres, excluding `test/sso.test.ts`
  (the token-gated package again; **CI run 47/48 ran it and were green**).
- `npm run check:providers` clean. `python fixtures/generate.py` is idempotent and the drift check
  passes.

**Seven things the real engine corrected. Every one would have shipped as a silent defect, and
the first is the one worth reading:**

1. **`lines` is flat, keyed by line name — not nested by form.** The whole comparison layer read
   `lines[form][line]` and got nothing. The reason it survived review is the instructive part:
   `test/helpers/fake-opentax.mjs` encoded the same wrong assumption, so all 328 tests agreed
   with the mistake and none of them could catch it. **A stand-in that shares your
   misunderstanding tests nothing.** The stub now mirrors the engine's real shapes.
2. **Some values arrive as a two-element array** — `[11420, 11420]`. `compare.ts` handled that
   defensively; `scripts/draft-check.mjs` had its own copy of the conversion that did not, so
   every array-valued line read as absent. The conversion is now exported and shared, not copied.
3. **An unfed source line is absent, not zero.** The earlier claim that "an engine computes a
   line it received no documents for as zero" came from the stub and is wrong. Verified: source
   lines (`line5a_pension_gross`, `line2b_taxable_interest`) are **absent**; only computed
   aggregates (`line10_adjustments`, `line21_credits_total`) come back as real `0`. The omissions
   argument is stronger stated accurately — a withheld document leaves the source line absent
   *and* every computed total a confident number, so a draft can show a plausible refund that is
   wrong by the whole of a pension. Corrected in §14, the design doc, the workbook sheet and the
   UI panel.
4. **The filing-status vocabulary is `single | mfs | mfj | hoh | qss`.** The long names the UI and
   the harness sent are refused at the `general` node, which loses the standard deduction and the
   entire tax computation with it — every draft return would have failed. The codes now live in
   the node map as data, are served to the UI so it cannot hardcode them again, and an unknown
   value becomes a named omission instead of an engine rejection.
5. **Engine 2.0.4's `f1099m` requires the taxpayer's own `recipient_tin`**, confirmed by probe.
   §7 forbids forwarding a TIN anywhere, so **1099-MISC is now unmappable** under a new reason
   code, `engine_requires_withheld_input`. The engine and this app disagree and §7 wins.
6. **`f1099div` alone among the nodes uses camelCase** (`payerName`), has no `payer_tin`, and
   requires `isNominee` and `box11`. Mapping it by the other nodes' convention would have had
   every 1099-DIV rejected.
7. **A required *checkbox* needs `false` when blank, and that is §5 read correctly rather than a
   hole in it.** §5 is about money; §5 itself says an unticked box "is `false` and has nothing on
   the page to cite". Without `falseWhenBlank`, requiring `box11` would have withheld every
   1099-DIV whose box 11 is unticked — nearly all of them. The loader refuses the flag on any
   field that is not a checkbox, so it can never reach a money field, and a test pins that.

**Also observed, not this repo's to fix:** with a single 1098 of 12,844 and an MFJ standard
deduction of 31,500, the engine reports `line12c_deduction_total = 12844` while
`line15_taxable_income` correctly reflects 31,500. Line 12c looks like it should be the greater of
the two. Worth reporting upstream; this app does not compare that line, and it is listed among the
computed-only figures, so a draft would display it. Raised rather than worked around.

**Still not verified:**

- `opentax/Dockerfile` has **never been built** — Docker is unavailable in the development
  environment. The pinned tag and checksum are recorded and the binary was run directly instead.
- The three draft-return routes have not been exercised over HTTP.
- **The UI panel has still not been looked at.** It cannot render without
  `@kisaesdevlab/vibe-auth/react`, which needs a `read:packages` token.
- **P17 has not exited.** Q21 is unanswered, and the phase also wants a draft return hand-checked
  line by line by a person against a known packet.


**Verified by execution on 2026-09-25** (P17, all three stages; carries **migration 0012**):

- `npx vitest run`: **328 pass across 27 files, none skipped**, with a real Postgres.
  **85 are new**, across seven new files. Nothing regressed.
  **One file was excluded locally:** `test/sso.test.ts` cannot load
  `@kisaesdevlab/vibe-auth`, which needs a `read:packages` token that was not available in
  the development environment, and that absence also made `npm run build` and
  `npm run typecheck` fail on implicit-`any` errors in `src/lib/vibeAuth*.ts`. Outside those
  two files `tsc --noEmit` was clean and `dist/draft/` emitted.
  **CI closed that gap** (run 47, all four jobs green): it has the token, so there it
  type-checked, migrated up/down/up, ran the **whole** suite including `sso.test.ts`'s 47
  tests, built, built the UI, and passed the fixture drift check. P16 is not disturbed.
- **Two guarantees were checked by mutation**, not argued:
  1. **A blank never becomes a zero at the engine boundary** (§5, §14 rule 1). Switch the
     guard to zero-fill and exactly three tests fail: the optional blank box, the
     engine-required blank box, and the partially-read 1095-A year.
  2. **No taxpayer amount survives a draft-return request.** Remove the wrapper's state
     cleanup and the test fails on a sentinel amount found on disk.
- **Migration 0012 ran forward, back, and forward again** against a real Postgres: four
  tables and their indexes appear, disappear with no residue (no leftover index rows), and
  reappear. `schema_migrations` returns to 0011 and back to 0012.
- **The wrapper and the client were driven over real HTTP against a real child process**
  (`test/helpers/fake-opentax.mjs` standing in for the binary): the `create → add × n → get →
  validate` sequence, a refused node reported without losing the rest of the draft,
  diagnostics split with an unclassified one treated as hard, per-request state isolation
  proven by two concurrent drafts not summing together, and the absent-engine path reporting
  `engine_unreachable` rather than throwing something a route turns into a 500.
- **The whole draft-return path ran end to end** (`test/draft-return.test.ts`, real database):
  the gate refuses a blocked bundle and an unconfirmed identity and the refusals come from
  `assertWorksheetAllowed`; the withheld SSA-1099 survives as a durable omission naming box 3;
  computed-only figures store with no line ref; disposal is logged to `purge_log`.
- **`npm run draft -- --truth` ran and scored**: 13 lines agreed, 0 disagreed, 2 not compared,
  exit 0, across all five fixture bundles. Seeded with defects it caught each and exited 1 —
  a misrouted node field (`1040:1a` expected 255,000.00, got 0.00) and the §9 judgment rule
  removed (`1040:5a` expected 0.00, got 25,000.00). A third seeded defect was caught at
  *load* instead, by the node map's own consistency check, before the harness ran.
- The UI builds with the new panel (35 modules) and `ui/` type-checks — both with
  `@kisaesdevlab/vibe-auth` externalised, because it cannot be installed here.
- `npm run check:providers` clean. Enabling the draft return adds **no inference and no
  egress**: the engine is deterministic and runs on the appliance.

**Five things were found by running it, not by reading it:**

1. **The wrapper's version regex truncated a prerelease** — `0.1.0-rc.1` reported as `0.1.0`,
   which would have passed the `OPENTAX_VERSION` check that exists to catch exactly that.
2. **A null `taxYear` coerced to 0** through `Number()`, so a draft could have been labelled
   year 0 rather than refused.
3. **Nothing stopped an off-year document feeding the engine.** The `1098_prior_year.pdf`
   fixture would have added last season's mortgage interest to this season's computation. §6
   flags the year mismatch as a soft failure precisely because it is a real preparer error, so
   a new `off_year_document` rule now withholds it. The worksheet still reports it, annotated.
4. **A hand-derived expectation was wrong**, and reading the line mapping caught it: the
   fixture 1099-R has box 7's IRA/SEP/SIMPLE box unchecked, so its gross distribution is a
   pension on line 5a, not an IRA distribution on 4a.
5. **A withheld line's expected value is a computed zero, not nothing.** An engine computes a
   line it received no documents for as `0`, and that zero is indistinguishable from a zero the
   documents reported. This is the sharpest argument for the omissions contract being part of
   the answer rather than an appendix to it, and it is now said that way in §14, in the
   workbook sheet, and in the UI panel.

**Not verified, and none of it is small:**

- **No real OpenTax binary has ever run, so no draft return has been computed by the actual
  engine.** Every figure in every test came from a stand-in that does plain sums with no
  ordering, phase-out or characterization anywhere. `npm run draft` proves the *harness*
  works; it says nothing yet about the engine's arithmetic.
- **`opentax/Dockerfile` has never been built.** It needs a published release and its SHA-256,
  and neither exists here. Whether `deno compile` output runs on `node:24-bookworm-slim` is
  reasoned, not observed.
- The `draft-input`, `draft-return` and `draft-return/status` routes have not been exercised
  over HTTP. They type-check and their gate wiring is covered at the service layer, not the
  route layer. Two small route-level defects were found by reading rather than running, and
  fixed: `?download=false` parsed as true (`z.coerce.boolean()` reads the *string* `'false'`
  as true), and the node map's `engine.pinnedVersion` was declared and then read by nothing,
  so a map written against one engine release could sit under another without a word.
- **The UI panel has been compiled, not looked at.** No browser has rendered it.
- The `Draft Return` workbook sheet is asserted against a parsed workbook, not opened in Excel.
- **P17 has not exited, and neither of its gates has moved** — Q21 is unanswered and no real
  engine has been scored.

**Verified by execution on 2026-09-20** (P16 follow-up: break-glass guard, reset refusal and
readiness check; no migration; same branch, merged 2026-09-22):

- 290 tests pass across 21 files (`npm test`), none skipped — the compose Postgres was up and at
  0011. 12 are new, in `test/sso.test.ts`: six tests run once in `local` and once in `both`,
  the two modes the old guard did not cover. (The 2026-09-19 entry below says 271 / 28; the
  code-review change set the same day took it to 278 / 35 and did not update that line.)
- **Checked by mutation.** With the every-mode guard, the `set-password` refusal, the
  reset-by-rule refusal and the authenticator check all switched off together, 11 of the 12 new tests
  fail, and so does the existing `oidc_only` guard test. The twelfth pins behaviour that already
  held — the users route writes no email — and is there so it cannot stop holding quietly.
- The readiness command was run three ways: from source under `--experimental-strip-types`
  (inside the suite, as a child process: a provisioned-but-unenrolled account, an absent one, and
  an unreachable database — exit 0, 0 and 1, the last with nothing on stdout and no credential
  on stderr); and **built**, `node dist/auth/breakglass-status.js` after `npm run build`, against
  the test database, which printed the all-false JSON and exited 0.
- `.appliance/manifest.json` with the new `sso.breakglassStatusCommand` was validated against
  `../Vibe-Appliance/console/manifest.schema.json` with a full JSON Schema validator: one error,
  and it is that key (`sso` is `additionalProperties: false` there). Nothing in this repo
  validates the manifest. See the external-dependencies row.
- `tsc --noEmit` clean; provider-leakage check clean. The UI was not touched and not rebuilt.
- **Not verified:** the image was not rebuilt, so `dist/auth/breakglass-status.js` is in the
  image by construction (`COPY --from=build /app/dist`) and has not been seen there, and the
  `docker exec` line in `docs/sso.md` has not been run against a container. No authenticator was
  enrolled by a person: `secondFactorEnrolled: true` was reached in tests by writing
  `totp_confirmed_at`, not by scanning a QR code. Nothing on the appliance reads the new key.
  **None of P16's three exit criteria below moved.**

**Verified by execution on 2026-09-19** (P16, single sign-on through Vibe Auth; carries
**migration 0011**; `@kisaesdevlab/vibe-auth` 1.0.4):

- 271 tests pass across 21 files (`npm test`). 28 are new, in `test/sso.test.ts` — the first
  HTTP-level tests in the repo: the real server via `buildServer()` + `inject()`, the real
  vibe-auth engine, the real database, and a fake identity provider
  (`test/helpers/fake-idp.ts`) signing real tokens. They skip themselves, loudly, when the test
  Postgres is not at 0011.
- **The MFA gate (Q18) holds, and the tests that say so were checked by mutation.** A
  password-only token, a token with no `amr`, and a password-only token with a stored "MFA not
  required" setting are each refused with no session row and a failure audit row. With the
  environment pin and the settings-store pin both removed, those three tests fail — on a 500
  from the session adapter's own check, not on a sign-in, so the third layer holds alone.
- The **built** server (`node dist/server.js`) was run on a real port against the fake IdP and
  driven over real HTTP with `VIBE_OIDC_REQUIRE_MFA_AMR=false` deliberately set in its
  environment: a token with a second factor signed in (`Set-Cookie … HttpOnly; SameSite=Strict`,
  `/api/me` 200 with `sso: true`, `/api/bundles` 200), a password-only token was refused with
  no cookie, sign-out ended the session, `/login/local` served the SPA and an unknown `/auth/`
  path returned a JSON 404.
- Migration 0011 ran forward, back, and forward again against the compose Postgres 17: three
  tables and five `sessions` columns appear, disappear without residue, and reappear.
- The break-glass CLI ran through the compiled adapter: `status` → `ensure` → `status` created an
  active admin with `mfa_method = totp`, no secret, and a real scrypt hash.
- The image builds with the registry token as a BuildKit secret. In the result: the CLI and
  adapter are at the manifest's paths, the process user is `app`, no npmrc holds a credential,
  and the token occurs **zero** times in `docker history` and in the full `docker save` stream.
- `tsc --noEmit` clean; provider-leakage check clean; the UI type-checks and builds.
- Two defects were found by running it and fixed before this entry: the Dockerfile's secret
  mounts had been committed mangled and did not build, and the boot line reported the identity
  provider "NOT reachable" on every healthy start.
- **Still not verified — and these are P16's exit criteria, so the phase has not exited:**
  1. **No real browser has signed in.** `SameSite=Strict` on the session cookie is argued to be
     compatible with the redirect back from the IdP (the callback *sets* the cookie; nothing
     needs to *send* one until the SPA's same-origin `/api/me`), and every piece of that is
     tested, but the argument itself has only been made, not watched. If it fails, raise a
     question before touching cookie policy.
  2. **No real Vibe Auth.** Nothing has been registered with a broker, and no token has come
     from authentik. In particular authentik's actual `amr` values for TOTP, WebAuthn and
     static codes have not been observed against `amrSatisfiesMfa`.
  3. The Authentication tab and the sign-in button have been compiled, not looked at.
- **CI (added the same day, PR #1):** green, and for the first time it *runs* the
  database-backed tests rather than skipping them. The first CI run of this work passed with
  36 tests skipped — every SSO test and every pipeline hand-off test — because the workflow had
  no Postgres and a skipped test is green. The build job now has a Postgres 17 service, migrates
  up, down and up, and fails if the suite reports the database unavailable: 271 of 271 ran.
  That run also confirmed `GITHUB_TOKEN` can read the package, and exposed a race in one new
  test (it asserted the IdP reachable straight after `start()`, which discovers in the
  background) that a fast local machine had been winning.

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

**Released 2026-09-22 as v0.10.0** — single sign-on through Vibe Auth (P16), merged from
`vibe-auth-integration` (PR #1, merge `84c3918`). Released before the Vibe-Appliance manifest
change on purpose: Vibe Auth's findings for this repo note that `lib/identity.sh` trusts a
manifest's `sso.capable` without probing the image, so a manifest that lands first would show
"registered" against v0.9.0, which ignores every `VIBE_OIDC_*` line. **Carries migration
0011.** Needs a broker ≥ 1.0.4. With `VIBE_AUTH_MODE` unset the app behaves as v0.9.0 did.
**P16 has not exited** — this release is what makes its exit criteria testable on the LAN box,
and none of them has moved; see Current position. Images tagged `0.10.0` / `0.10`.

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
| P6 | Form schema registry | implemented | **28 form schemas** (27 for TY2025 plus a TY2024 1098); all fields nullable; validated at load |
| P7 | Layout pass | implemented | 0–1000 scale requested; convention detected per page and recorded; spans immutable, model recorded; values-only retry on truncation |
| P8 | Field-binding extraction | implemented | multi-pass agreement (only signal per Q4); no-span forces review |
| P9 | Arithmetic reconciliation gate | implemented | every §6 check; gate has one door and no bypass |
| P10 | 1040 line mapping engine | implemented | TY2025 incl. Schedule 1-A → 13b; conditional 1099-R routing |
| P11 | Review UI | implemented | bbox overlay; corrections layer over model output; dispositions |
| P12 | Worksheet generation | implemented | XLSX + bookmarked PDF reconcile to one model; prior-year column stubbed |
| P13 | Retention and disposal | implemented | rasters purge earlier than sources; every disposal logged |
| P14 | Compliance hardening and packaging | implemented | **cannot exit** — gated on Router region pinning (Q11) |
| P15 | K-1 support | implemented | K-1 1065/1120-S/1041, boxes as printed, all Judgment Required |
| P16 | Single sign-on (Vibe Auth) | implemented, released v0.10.0 (2026-09-22) | **cannot exit** until signed into from a real browser against a real Vibe Auth — see Current position. OIDC via `@kisaesdevlab/vibe-auth`; SSO sessions satisfied only on `amr` proof (Q18); appliance registration outside this repo (Q19) |
| P17 | Draft return (OpenTax) | **implemented and scored against engine v2.0.4, 2026-09-25**; carries migration 0012 | translator, node map, sidecar, comparison, workbook sheet, UI panel, harness. `npm run draft -- --truth` is 13/13 against the real engine. **Cannot exit**: Q21 unanswered, the Dockerfile unbuilt, and no person has hand-checked a draft line by line. See Current position |

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
| Vibe Auth client `@kisaesdevlab/vibe-auth` ≥ 1.0.4 on GitHub Packages | P16 | **published** — 1.0.0–1.0.4 listed 2026-09-19. Restricted package: installs need `read:packages`. CI's `GITHUB_TOKEN` reads it today (confirmed by PR #1's run); if that ever 403s, the package's *Manage Actions access* no longer grants this repo |
| Vibe Auth broker ≥ 1.0.4 deployed and this app registered with it | P16 exit | **operator step** — `docs/sso.md`. Before 1.0.4 an MFA-enrolling sign-in carried no MFA `amr` and would be refused here (Q18) |
| Vibe-Appliance manifest `sso` block + env-template keys for `vibe-1040` | P16 LAN-box check | **not started, outside this repo** — scoped out 2026-09-19 (Q19); checklist in `docs/sso.md`. **Unblocked 2026-09-22:** v0.10.0 is published, so the manifest change may now land without the release-ordering hazard in Vibe Auth's findings. **Added 2026-09-20:** the block now carries `breakglassStatusCommand`, which the appliance schema rejects under strict validation (`sso` is `additionalProperties: false`) and `lib/identity.sh` does not read — the schema key and the status-pill / `oidc_only`-guard wiring are appliance work, item 1 of the same checklist |
| OpenTax engine, pinned version, verified by checksum | P17 stages 2–3 | **not started** — `filedcom/opentax`, AGPL v3, launched 2026-09-22 by the Open Tax Technology Alliance. A `deno compile` single binary, so it needs a glibc base and cannot live in this repo's Alpine runtime image. Young and largely AI-maintained: pin the release and verify the SHA-256, never `install.sh \| sh` into latest |
| A revised WISP §4, signed off by whoever owns the WISP | P17 exit, and live client data | **not started** — Q21. The current wording ("makes no substantive determinations") is what the §7216 position rests on and is no longer accurate. `DRAFT_RETURN_ENABLED` stays off until it is revised |
| Corresponding Source conveyable for `@kisaes/vibe-ai-client` and `@kisaesdevlab/vibe-auth` | publishing, §13 productization | **not started, sibling-repo decisions** — Q22. Neither is publicly available today; AGPL §1 requires both to reach anyone this app is conveyed to |
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
- No return ingestion, no diff engine. No tax calculation **by this app** — amended 2026-09-25
  to permit a separate, deterministic, locally-run engine as a checking aid (§14, P17). The app
  itself still computes no tax and decides no characterization question.
- AGPL-3.0-only since 2026-09-25, relicensed from BUSL-1.1 (Q22).

---

## Decision log

Append here when a locked decision changes or a significant implementation choice is made
that future phases depend on. Date, decision, reason, phases affected.

**2026-09-25 — A draft return, computed locally by OpenTax. §2's "not a tax calculation engine"
is narrowed, not repealed; this app is relicensed AGPL v3.** (P17 stage 1)

The Open Tax Technology Alliance published OpenTax on 2026-09-22: a deterministic federal 1040
engine, AGPL v3, a single binary, 186 registered nodes and 131 input types, TY2025, no account
and no cloud. Fed the amounts this app already extracts it turns §1's eyeball comparison into an
arithmetic one, and run against the fixture bundles it becomes the end-to-end accuracy
instrument this build has never had. Kurt's call, on three questions put to him explicitly.

**What changed in the boundaries, and what did not.** §2 now says the app computes no tax *of
its own* and may hand what it read to a separate, deterministic, locally-run engine. §11's
data-capture sentence is amended. Three boundaries are untouched and were checked rather than
assumed: the prepared return is still never ingested and no MeF XML is parsed **or emitted**, so
this is not a diff engine and not a filing product; `src/draft/compare.ts` compares the app's own
two derivations of the same documents, which is internal consistency checking; and every §9
judgment call is still refused rather than answered.

**The §7216 analysis, which is the part worth recording.** The engine runs on the appliance,
holds no credential and makes no network call, so **the set of third parties that see taxpayer
data is unchanged** and §301.7216-2(d)'s disclosure analysis of the Router's providers is
untouched. What changes is the *characterization* claim. The app still decides nothing: a
populated `judgmentRequired` field withholds its whole document, which means an SSA-1099 is
withheld every single time — box 3 is always printed, and the taxable portion of social security
is precisely what §11 forbids computing. Filing status, dependents and the age and blindness
flags come from the **reviewer**, never inferred from a pile of forms; that is the preparer making
a determination, in the right place. But `docs/wisp-amendment.md` §4 now says something untrue
about this app, so it must be revised and signed off before live client data — **QUESTIONS.md
Q21, and `DRAFT_RETURN_ENABLED` stays off until then.**

**The omissions contract is the design.** A draft from a documents-only bundle can never be a
return, and one that looks authoritative while silently missing half a taxpayer's position would
be worse than none. So incompleteness is an enumerated output. Six rules produce it (§14); the
first matters most. The boundary into a calculation engine is the one place in this build where
§5 could be destroyed silently, because engines want numbers and a blank is not a number. A null
is never sent as zero: the box is left off, and where the engine requires it the **whole document
is withheld** rather than zero-filled. A partially read 1095-A year is not padded with
zero-premium months, which would report a month of no coverage as a month of no premium. **That
guard was checked by mutation** — switched off, three tests fail and say why.

**Relicensed AGPL-3.0-only, from BUSL-1.1.** `package.json` declared BUSL-1.1 and no licence text
had ever been committed; the AGPL text is now `LICENSE`. This makes the integration unambiguous
rather than arguable, and it is the Alliance's own framing — open products use it free, closed
products pay. Two consequences are open in Q22 and neither blocks the build. Corresponding Source
has to cover `@kisaes/vibe-ai-client` and `@kisaesdevlab/vibe-auth`, which are sibling-repo
decisions. And a proprietary licence for the *combined* work is no longer Kisaes's alone to grant,
which is why the engine is invoked as a separate process over JSON and stays a severable optional
service — with the flag unset, no OpenTax code is present at all. The AGPL obliges offering source
to network users, **not** a public repository, so this repo stays private while
`docs/wisp-amendment.md` lives in it.

**Sequenced now rather than after the accuracy run, deliberately.** Extraction accuracy has never
been measured and the accuracy run is still blocked on the Router. Building a tax computation on
unmeasured numbers is a real objection, and the answer is to invert it: the translator is a pure
function testable with no engine, no Router and no database, and a wrong total is far easier to
spot on a 1040 line than in a field map. Values flagged for review or citing no span never reach
the engine, so an unchecked number cannot quietly feed a computed line. P17's exit criteria
require the harness to have actually scored and a person to have checked a draft line by line.

**Two findings from writing the node map**, both of which would have been silent guesses:

1. **The engine's field names are not derivable by convention.** Its catalogue calls the first
   money box `box1_wages` on `w2`, `box1` on `f1099int`, `box1_oid` on `f1099oid` and
   `box_1_unemployment` on `f1099g`. Every pair is written out in data and checked at load.
2. **Its `w2g` node numbers boxes differently from the 2025 W-2G revision this app reads** — its
   `box2` is a wager type where the form's box 2 is a date. Mapping by number would have moved a
   date into a wager type. Those boxes are `ignored` with the reason recorded, not guessed.

**And three form types the engine cannot take**, recorded because each is a real limit rather than
an oversight: 1099-B, because the engine's node is per-lot and this app extracts Form 8949 section
subtotals only (§8); 1098-T, 1099-S, 1099-SA, 1099-Q, 1099-LTC, 5498 and 5498-SA, for which it
has no input node; and every K-1 plus SSA-1042S, which have nodes that are deliberately not used
because §8 keeps them as printed. All 28 registered form types are declared either mapped or
unmappable-with-a-reason, and the loader refuses a map where one is missing.

*Affects:* P6, P9, P10, P12, P17, §2, §5, §9, §11, §13, §14, WISP.

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

**2026-09-19 — Single sign-on through Vibe Auth. MFA stays mandatory; the identity provider may now perform it.** (P16, migration 0011)
Staff can sign in through the suite identity service (Vibe Auth: bundled authentik plus a
broker, OIDC authorization code with PKCE) using `@kisaesdevlab/vibe-auth`. Local sign-in is
untouched and remains the default (`VIBE_AUTH_MODE=local`); `both` adds the SSO button and
`oidc_only` hides the local form from everyone but the break-glass account. The session model
is not redesigned — an SSO sign-in ends in the same `sessions` row and the same
`v1040_session` cookie (`httpOnly`, `SameSite=Strict`, `Secure` per `SESSION_SECURE`) as a local
one, and the package never sets a cookie of its own.

**This amends how the locked MFA decision is satisfied, not whether it is** (Q18). `requireUser`
still refuses any session without `mfa_satisfied_at`. An SSO session is marked satisfied only
when the ID token's `amr` claim proves a second factor at the IdP; a token without that proof
is refused outright and no session row is written. `VIBE_OIDC_REQUIRE_MFA_AMR` is forced `true`
in code for this product, and the session adapter refuses independently, so the "disable MFA
enforcement" switch Vibe Auth gives other products is inert here. `amr` is recorded on the audit
row of every SSO sign-in. CLAUDE.md §11 amended to say so.

**Break-glass keeps its second factor.** Vibe Auth's plan for this product preferred a
password-only break-glass account. Declined: it is a single-factor administrator path into
taxpayer data. `vibe-breakglass` is a local admin that enrols an authenticator through the
existing first-sign-in flow — TOTP needs no SMTP, SMS or IdP, which is exactly the outage it is
for. The operational cost is that the authenticator must be enrolled at provisioning, not
discovered missing during an outage; `docs/sso.md` makes that a provisioning step.

**Three holes closed after code review, same day, before merge.** (1) A just-in-time account
never enrols a local factor, so in `both` mode self-service password reset plus first-sign-in
enrolment let whoever reads the mailbox take the account with one factor. Reset is now refused
for an account that has an SSO link and no local factor, indistinguishably from an unknown
address; an admin can still set a password for one. This is the same §11 control as Q18 seen
from the other side, and it is a behaviour a firm will notice, so it is recorded here rather
than left in a commit. (2) Role sync would demote the firm's last active admin if their IdP
groups mapped lower, with no one left to undo it; the user adapter now keeps the role and
audits the refusal. (3) Break-glass could be disabled from Admin → Users in `oidc_only`, which
surfaces as the appliance failing to start at the next restart; refused with 409. Also from
review: sign-in, reset and SSO linking now match the address case-insensitively **on the
stored side too** — the first version lowercased only what was typed, and the seed stores
`SEED_ADMIN_EMAIL` as typed, so a firm whose admin is `Kurt@Firm.com` would have been locked
out by the upgrade; and back-channel logout now finds a session stored without a `sid`.

**2026-09-20 — break-glass is protected in every mode, and "ready" now means the authenticator
is enrolled.** From Vibe Auth's `docs/integration-plans/break-glass-and-rollout-risks.md`.
(1) Hole (3) above was closed only for `oidc_only`. But the switch *into* `oidc_only` is gated
on the appliance by a stored password string, so an account disabled or demoted in `local` or
`both` would pass it. `409 breakglass_required` now applies in every mode; the message no longer
says to change the mode first. (2) Admin → Users no longer sets the break-glass password
(`409 breakglass_password_managed`): `breakglass rotate` is the one path that prints it once,
audits it and keeps the appliance's stored copy true. (3) Self-service reset refused break-glass
only because `appliance.local` is undeliverable; it is now refused by rule, with the uniform
response and an audit row (`why: breakglass_account`). (4) Because this app does not exempt
break-glass from the second factor, and the package's `ensure` creates it
password-only, "a password is on file" says nothing about whether it would work. Readiness is
`exists ∧ active ∧ admin ∧ secondFactorEnrolled`, the last meaning an enrolled **authenticator**
and nothing else, at `GET /api/admin/breakglass/status` and `node dist/auth/breakglass-status.js`.
This is how the locked decision above is *checked*, not a change to it. Left open, knowingly:
an admin can still reset the account's factor or switch its method (both read as not ready), and
the account can still change its own password while signed in, which leaves the stored copy
stale. The unspecified choices in this change set are QUESTIONS.md Q20.

Where this departs from `Vibe-Auth/docs/integration-plans/vibe-1040.md`, and why: that plan
assumed drizzle-kit migrations (this repo's are hand-written up/down SQL, so the package's
tables are inlined into 0011 with a real down); it preferred password-only break-glass (above);
and it included the Vibe-Appliance manifest and env-template edits, which were scoped out of
this phase (Q19) — `.appliance/manifest.json` here carries the `sso` block ready to copy. Also
fixed in passing because SSO account linking depends on it: `POST /api/auth/login` compared the
submitted email case-sensitively while every write path lowercased it, so a mixed-case sign-in
never matched.

The package is the first dependency this repo takes from GitHub Packages, so installs now need
a token with `read:packages` — locally, in CI, and as a BuildKit secret in three Dockerfile
stages. It is never written to a layer or to the repo. Requires Vibe Auth broker ≥ 1.0.4 (Q18).
*Affects:* P0 (auth, sessions, audit), P14 (GLBA posture, packaging), P16, §11, WISP.

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
| **A draft return computed from a documents-only bundle is structurally incomplete, and looks authoritative** | P17 | Incompleteness is a first-class enumerated output (`omissions[]`, §14), not a footnote: filing status comes from the reviewer, every §9 judgment item withholds its whole document, and `complete` is false whenever anything was withheld. Every computed figure is labelled advisory |
| **The engine is young and largely AI-maintained, and its arithmetic is only partly measured** | P17 | Pinned at v2.0.4 and checksummed. `npm run draft -- --truth` now scores 13/13 against it, which covers wages, withholding, interest and dividends — not tax, credits or phase-outs. One suspected engine defect already observed (line 12c ignoring the standard deduction; see Current position). P17 still cannot exit until a person has checked a draft line by line |
| A draft return is built on extraction accuracy that has never been measured | P7, P8, P17 | Accepted 2026-09-25 and inverted deliberately: the draft return is the accuracy instrument (P17 stage 3). Values flagged for review or citing no span never reach the engine, so an unchecked number cannot silently feed a computed line. `--truth` mode now isolates the two: the node map and engine are measured at 13/13, so a future disagreement on a real bundle is extraction |
| Relicensing to AGPL forecloses a proprietary licence for the combined work | P17, §13 | Q22. The engine is a separate process and a severable optional service; with the flag unset no OpenTax code is present at all. Do not move it in-process or vendor its source |
| **A stand-in binary that shares a wrong assumption tests nothing** | P17 | Learned the hard way: the stub encoded a nested `lines` shape the engine does not use, so all 328 tests agreed with the mistake. `test/helpers/fake-opentax.mjs` now mirrors the engine's real shapes — flat keys, array-valued lines, absent source lines, present zero totals — and its comments say where each came from. Re-derive it against the binary whenever the pin moves |
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
| Fake identity provider (P16) | yes | `test/helpers/fake-idp.ts` — in-process OIDC provider signing real RS256 tokens; `user.amr` is driven per test. Not a document fixture: no taxpayer data, synthetic staff identities only. **A real authentik token has not been seen** |

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
