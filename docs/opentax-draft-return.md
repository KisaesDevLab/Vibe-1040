# Draft return via OpenTax — design and operator notes

**Status:** stage 1 implemented 2026-09-25. Stages 2 and 3 not started. **P17 has not exited.**
**Off by default.** `DRAFT_RETURN_ENABLED` stays unset wherever there is live client data until
QUESTIONS.md Q21 is answered.

The contract is CLAUDE.md §14. This file is the reasoning behind it, the upkeep it needs each
season, and what an operator has to do. Read §14 first; if the two ever disagree, §14 wins.

---

## 1. What this is, and what it buys

The app reads dollar amounts off a client's source documents and emits a worksheet of totals
keyed to 1040 line numbers. A preparer opens the worksheet beside the prepared return and
compares by eye (§1).

[OpenTax](https://opentax.filed.com/) ([`filedcom/opentax`](https://github.com/filedcom/opentax))
is a deterministic federal 1040 engine: a single binary, AGPL v3, 186 registered nodes and 131
input node types, TY2025, validating against IRS MeF business rules. It needs no account, no
cloud and no model. It was published on 2026-09-22 by the Open Tax Technology Alliance (Filed
and Crimson Tree Software).

Feeding it the amounts this app already extracts buys two things:

1. **The comparison becomes arithmetic instead of visual.** The worksheet says "the documents
   report $X on line 1z"; the engine says "line 1z computes to $X". A disagreement is a defect
   in one of them, and it is visible rather than something a tired preparer has to notice in
   February.
2. **It is an accuracy instrument for a pipeline that has never had one.** The fixture bundles
   already carry ground truth in `test/fixtures/manifest.json`. A wrong total is far easier to
   spot on a 1040 line than buried in a field map.

Neither buys a return. See §3.

## 2. Why this does not repeal the scope boundaries

§2 forbade a tax calculation engine outright. It was narrowed on 2026-09-25 rather than
deleted, and the narrowing turns on four facts that were checked rather than assumed.

**The app still computes no tax.** There is no taxable-Social-Security worksheet, no §121
exclusion and no QBI calculation in `src/`. The arithmetic happens in a separate process that
this repo does not contain.

**Nothing new is disclosed to anybody.** The engine runs on the appliance, holds no credential
and makes no network call. The set of third parties that see taxpayer data is exactly what it
was, so §301.7216-2(d)'s analysis of the Router's providers is untouched. This is the load-bearing
point of the §7216 argument and it is worth stating plainly: **enabling the draft return adds no
egress at all.**

**The app still decides nothing.** A populated field the schema marks `judgmentRequired`
withholds its whole document from the engine. Applied per document by content, that is §9
exactly — and its sharpest consequence is that **an SSA-1099 is withheld every single time**,
because box 3 is always printed and the taxable portion of social security is precisely the
determination §11 forbids. Filing status, dependents, blindness and age over 65 come from the
reviewer. The app never infers a filing status from a pile of forms.

**The prepared return is still never ingested.** `src/draft/compare.ts` compares the app's own
two derivations of the same source documents. No MeF XML is parsed, and none is emitted — the
engine can produce MeF XML and a filled PDF, and this app uses neither.

**What is still open.** `docs/wisp-amendment.md` §4 says the system "makes no substantive
determinations", and that sentence is what the firm's §7216 position rests on. It is no longer
accurate and must be revised and signed off by whoever owns the WISP. That is QUESTIONS.md Q21,
it gates P17's exit, and it is why the flag is off.

## 3. The omissions contract

**A draft return computed from a source-document bundle can never be a return.** A bundle cannot
know filing status, dependents, itemised deductions, basis, estimated payments or carryovers. A
draft that looked authoritative while silently missing half a taxpayer's position would be worse
than no draft at all — it would invert the tool's entire purpose, which is surfacing omissions.

So incompleteness is a first-class output. `buildDraftInput` returns `omissions[]` beside the
nodes, `complete` is false whenever anything at all was withheld, and every surface renders both.
The six rules are in §14. The first one deserves repeating here because it is the one that could
go wrong quietly:

> **A blank is never a zero.** A calculation engine wants numbers, and `null` arriving as `0`
> would destroy the distinction §5 exists to preserve — silently, and in the one place where
> nobody would look. A blank box is left off the payload entirely. Where the engine *requires*
> the field, the whole document is withheld rather than zero-filled. A partially read 1095-A year
> is never padded with zero-premium months, because that would report a month of no coverage as a
> month of no premium.

`test/draft-translate.test.ts` pins this, and the guard has been checked by mutation: switched
off, exactly three tests fail. **Do not weaken it to make a draft look more complete.** If a
draft is too sparse to be useful, the answer is better extraction or more reviewer-stated inputs,
never a default of zero.

### The reason this list is load-bearing

**Verified against engine 2.0.4, not reasoned about.** A withheld document leaves two traces:

- The **source line** it would have fed is **absent** from the engine's output — not zero.
  Absent reads as "the documents reported nothing on this line", so a withheld SSA-1099 looks
  like a taxpayer with no social security income.
- Every **computed total is still a confident number**. AGI, taxable income, total tax and the
  refund are computed as though the document did not exist. A draft can show a plausible refund
  that is wrong by the whole of a pension, and no figure on the page hints at it.

An earlier version of this file claimed the engine returns a *zero* for an unfed line. That was
wrong, and instructive about how: it was true of the stand-in binary the tests ran against, so
every test agreed with the mistake and none of them could catch it. The engine returns `0` only
for computed aggregates (`line10_adjustments`, `line21_credits_total`) that genuinely total to
nothing.

So the omissions go **above** the figures in the UI panel, on the **same sheet** as the figures
in the workbook, and in `draft_return_omissions` beside `draft_return_lines` in the database.
Every surface says in words that the figures are wrong by whatever was left out. Moving them to
a second screen, a second sheet or a footnote would undo the feature's only real safeguard.

## 4. The node map

`data/opentax-nodes/<year>.json`, loaded by `src/draft/nodes.ts`. Data, not code, for the same
reason line mappings are (§10): it changes every season.

**The engine's field names are not derivable by convention.** Its catalogue calls the first money
box `box1_wages` on `w2`, `box1` on `f1099int`, `box1_oid` on `f1099oid` and `box_1_unemployment`
on `f1099g`. Every pair is written out explicitly and checked at load. Do not try to be clever
here; a convention that is right 90% of the time misfiles the other 10% in silence.

Two load-time rules, both refusals rather than warnings:

- **Every registered form type is declared**, either in `forms` or in `unmappable` with a reason a
  preparer can read. A form type nobody thought about fails at startup.
- **Every field of a mapped form type is accounted for exactly once**, across `fields`,
  `codeGroups`, `monthlyArrays` and `ignored`. A box that reaches no engine field and nobody
  decided that is the silent-omission class this whole app exists to prevent. Every
  `sensitive: 'tin'` field must be `ignored` with reason `tin_withheld` — a TIN is never
  forwarded (§7).

And one rule the same in spirit that **cannot** be a load-time refusal: **every line the engine
returns is accounted for once**, in `lines.comparable`, `lines.computedOnly` or
`lines.ignoredLines`. Enumerating a release's output lines means computing a return, so it is
checked on every draft and reported in the log rather than at startup — §7 step 8. The `ignored`
side takes a reason from a closed set (`echoes_an_input`, `not_a_money_figure`,
`superseded_by_another_line`) plus prose, so it stays a decision rather than a way to silence a
figure.

### Shapes beyond a flat rename

- `codeGroups` — W-2 boxes 12a–12d are four code/amount pairs here and one
  `box12_entries: [{code, amount}]` array in the engine. A code with no amount, or an amount with
  no code, is half a fact and becomes an omission rather than a guess.
- `monthlyArrays` — 1095-A's twelve monthly boxes become one fixed-length-12 engine array. All
  twelve or none; see §3.
- `constants` — values the binding itself implies rather than reads off a page. RRB-1099's
  `is_rrb` is the only one.

### Two traps found writing the 2025 map

**The engine's `w2g` node numbers boxes differently from the 2025 W-2G revision this app reads.**
Its `box2` is a wager type where the form's box 2 is a date won. Mapping by number would have
moved a date into a wager type and nothing would have complained. Boxes 2, 3, 5, 6, 7, 8 and 10
are `ignored` with reason `engine_box_numbering_differs`. **If a future season maps them, verify
against the form revision, not against the box number.**

**RRB-1099 binds to `ssa1099`, not to `rrb1099r`.** The engine's `rrb1099r` node is the RRB-1099-R
pension statement. RRB-1099 is the tier-1 SSEB benefit statement — the SSA-1099 equivalent — and
the `ssa1099` node carries an `is_rrb` flag for exactly this. Box 4 (net SSEB tier 1 paid) is the
gross benefit and box 5 is the repayment. In practice the document is withheld anyway, because
box 4 is `judgmentRequired`.

### What the engine cannot take, and why

Each of these is a real limit, recorded so nobody re-litigates it from scratch:

| Form type | Reason | Why |
|---|---|---|
| 1099-B | `engine_shape_mismatch` | The engine's `f1099b` node is **per-lot** and requires description, dates, proceeds and basis per transaction. This app extracts Form 8949 section subtotals only (§8). |
| 1098-T, 1099-S, 1099-SA, 1099-Q, 1099-LTC, 5498, 5498-SA | `no_engine_node` | No input node exists. `f8863` takes already-determined qualified expenses, which is the netting question §9 refuses; `ltc_premium` is a premium deduction, not the benefit statement. |
| K-1-1065, K-1-1120S, K-1-1041 | `policy_boxes_as_printed` | Nodes exist and are deliberately unused. §8 keeps K-1s as printed with no line dispersion. |
| SSA-1042S | `policy_boxes_as_printed` | No 1040 line mapping at all (§8, Q16). Whether it belongs on a 1040 or a 1040-NR is not decided here. |
| 1099-CONSOLIDATED | `container` | Its sub-forms are separate documents and map on their own. |

## 5. Adding a season

1. Diff the engine's input-node catalogue — `forms/f1040/<year>/nodes/inputs/` in its repository,
   or `opentax node list` and `opentax node inspect --node_type <type>`.
2. Copy `data/opentax-nodes/<prev>.json` to `<year>.json`, bump `version`, and update `engine`.
3. Change what moved. The loader will refuse the file if a registered form type is undeclared or
   a box is neither mapped nor ignored, so the failure mode is a startup error, not a wrong number.
4. `npx vitest run test/draft-nodes.test.ts`.
5. Run the harness before believing any of it:

```bash
npm run draft -- --truth            # node map + engine, extraction not involved
npm run draft -- --truth --bundle irs-official-forms-2025
npm run draft -- <bundleId>         # extraction + node map + engine, together
```

`--truth` builds engine input straight from the fixture manifest's ground-truth values, so it
needs no database and no pipeline run. The difference between the two modes is the point: a line
that is right under `--truth` and wrong for a real bundle is an **extraction** defect; wrong in
both is the **node map or the engine**. That separation is the thing STATE.md has been unable to
measure since the build began.

Expected 1040 line values live in `expectedDraftReturn` in `test/fixtures/manifest.json`, derived
by addition from the printed boxes — never by running this repo's code, or the harness would be
scoring the mapping against itself. `engineVisible` is what the engine should see after §14
withholding; where it differs from `worksheetReported`, `withheldBecause` names the rule.

## 6. Operator notes

**The engine is off unless you turn it on.** `DRAFT_RETURN_ENABLED=false` is the default, and
the compose service is behind a profile so nothing pulls it:

```bash
# build the engine image against a pinned release
docker compose --profile draft-return build \
  --build-arg OPENTAX_VERSION=v2.0.4 \
  --build-arg OPENTAX_SHA256=7f0911050f7f34e10c149330e4bff9a1001a9eba5a70f50621e7c2c3aaaa02d4 \
  opentax
docker compose --profile draft-return up -d opentax
# then set DRAFT_RETURN_ENABLED=true and OPENTAX_VERSION=2.0.4 in .env and restart the api
```

`OPENTAX_VERSION` is compared against what the sidecar reports, and a mismatch is logged loudly
on every draft — a node map must not drift under the engine. Check `/health`: it carries a
`draftReturn` block saying `off`, or the engine's reachability and version.

- The engine will be a **separate `opentax` compose service** on a glibc base. The app's runtime
  image is `node:24-alpine` and a `deno compile` binary will not run there. The queue-style
  process boundary also matches the Python sidecar pattern and keeps the integration severable
  for the licence reasons in §7.
- **Pin the release and verify the SHA-256.** Never `curl install.sh | sh` into a floating latest.
  This is a young, largely AI-maintained tax engine — an arithmetic bug has already been filed and
  closed against it (its issue #8, Form 8959 reading the wrong Schedule SE line). Version-pinning
  is what makes a harness score mean anything.

  **Verified 2026-09-25**, by downloading the asset and running it. The pair is checked in at
  `opentax/pinned.json`, which is what CI builds the image from — a checksum that lives only in
  a table is one nothing verifies:

  | release | asset | SHA-256 | `opentax version` prints |
  |---|---|---|---|
  | `v2.0.4` | `opentax-linux-x64` | `7f0911050f7f34e10c149330e4bff9a1001a9eba5a70f50621e7c2c3aaaa02d4` | `opentax 2.0.4` |

  Two forms of the version, and they are not interchangeable: the download URL wants the **tag**
  (`v2.0.4`), while the binary reports `2.0.4` and that is what `OPENTAX_VERSION` is compared
  against. The app strips a leading `v` before comparing, so either form is accepted.
- With the engine stopped the app **degrades and says so** at `/health`, as it does with the Router
  down. It never fails a bundle over a missing draft return.
- Draft returns are **derived taxpayer data**: they purge on the retention schedule and vanish with
  `DELETE /api/bundles/:id`, logged to the same `purge_log` a policy purge writes (§11).

### Known engine behaviour, and how it is surfaced

The engine's output is **never corrected here**. A draft return that edited the engine's figures
would be a check on nothing: the whole value of the thing is that two independent derivations of
the same documents are put side by side. Where a figure is confident and, read alone, misleading,
the node map carries a `note` on that line instead — rendered beside the figure in the panel,
stored on the line, and carried onto the `Draft Return` workbook sheet.

One such note ships today. **Engine 2.0.4 reports `line12c_deduction_total` as the itemised
total even when the standard deduction is larger and is what the same run applied to taxable
income.** Observed twice on different bundles: most recently 18,349 on line 12c against a 31,500
married-filing-jointly standard deduction, with taxable income correctly computed on 31,500. The
two lines therefore need not reconcile on the face of the draft. Worth reporting upstream; it is
recorded in STATE.md's risk register and does not affect any line the harness scores.

**What resolves it on the face of the draft is the pair beside it**, declared in the map since
P18: `line12a_standard_deduction` and `line12e_itemized_deductions`. 12e is the itemised amount
the engine actually applied, so 12e at zero beside a figure on 12a says the standard deduction
won, and 12e equal to 12c says it did not. Measured on one bundle both ways: itemising at 33,005
against a 31,500 standard deduction, then the same bundle with all four age and blindness flags
set, which lifted 12a to 37,900 and made the standard deduction win. That is reporting the
engine's own output more completely, not correcting it.

### Looking at the panel

The panel lives in the review aside, which is about 290 CSS pixels wide. That is narrow enough
to be worth remembering when changing it: the first browser render showed a four-column money
table breaking every 1040 line label one word per line and clipping the agreement column off the
right edge, which is why the comparison is stacked blocks rather than a table. It compiled and
type-checked in that state for a week.

## 7. Upgrading the engine

A **new engine release** is a different job from §5's new tax *year*, and it is the more
dangerous of the two, because most of what can go wrong is silent.

### What is pinned, and what each pin means

| Pin | Where | Answers |
|---|---|---|
| `OPENTAX_VERSION` | environment | what this deployment *intends* to run |
| `engine.pinnedVersion` | `data/opentax-nodes/<year>.json` | what the node map was *written against* |
| `OPENTAX_VERSION` + `OPENTAX_SHA256` | `opentax/Dockerfile` build args | what is actually installed, verified by checksum |

`src/draft/generate.ts` compares the binary's own reported version against the first two on
every draft and warns, naming which pin disagrees. It is deliberately not fatal: a version
string is weaker evidence than the harness.

### The failure this procedure exists to prevent

**A renamed field is not symmetrical.** Verified against 2.0.4 by probe, not reasoned about:

- A **required** field renamed → `form add` refuses the node, the wrapper reports it in
  `rejected`, and it lands in the omissions. Loud, and already handled.
- An **optional** field renamed → the engine accepts the payload and **ignores the unknown
  key**. The amount never reaches the return. The line comes back **absent**, and absent is
  precisely what "the documents reported nothing on this line" looks like (§3).

A 1099-INT box 1 of 12,345 sent as `box1_interest` instead of `box1` leaves
`line2b_taxable_interest` missing, every total confidently wrong, and nothing — not `rejected`,
not the diagnostics, not the omissions list — saying so. The omissions contract does not cover
it, because from the translator's side the field was sent successfully.

So `src/draft/catalog.ts` compares the names the map intends to send against the names the
engine reports through `node inspect --node_type X --json`. A rename becomes an error at
upgrade time instead of a number that quietly disappears. Blocking findings **withhold draft
returns** until resolved; the worksheet is never affected.

### The procedure

1. **Read the engine's release notes** for renamed or removed input fields and node types.
2. **Get the new asset's SHA-256** and record the pair in §6's table. Never `install.sh | sh`.
3. **Rebuild the sidecar image** with the new `OPENTAX_VERSION` and `OPENTAX_SHA256` build
   args, and bring it up.
4. **Re-derive `test/helpers/fake-opentax.mjs` against the new binary.** This is the step that
   is easiest to skip and most important. That file encodes the engine's wire shapes — the flat
   `lines` map, array-valued lines, absent source lines, the `node inspect` listing's
   formatting. It once encoded a shape the engine does not use and **all 328 tests agreed with
   the mistake**. A stand-in that shares your misunderstanding tests nothing.
5. **Run the catalogue check.** Admin → Draft engine, or:
   ```bash
   curl -s "$OPENTAX_URL/catalog?nodes=w2,f1099int,f1099r,general" | jq
   ```
   Fix every blocking finding in `data/opentax-nodes/<year>.json`, then bump its
   `engine.pinnedVersion` and `OPENTAX_VERSION`. Advisory findings are not blockers but are
   worth clearing: a stale `engineRequired` either refuses documents the engine would have
   taken, or sends ones it will refuse whole.
6. **Run the harness**, which is the only thing here that measures *behaviour*:
   ```bash
   npm run draft -- --truth
   ```
   The catalogue check is a **name** check. It cannot see a field that kept its name and
   changed its meaning, or arithmetic that moved. An upgrade needs both.
7. **Run the suite** (`npx vitest run`) and re-read `lines.comparable` and `lines.computedOnly`
   in the node map: an engine that surfaces new 1040 lines may make a `notCompared` line
   comparable, and one that stops surfacing a line will make a comparison go quietly silent.
8. **Compute one draft and read the log for undeclared lines.** Every draft reports the engine
   lines the node map accounts for in no way — not `comparable`, not `computedOnly`, not
   `ignoredLines` — because the only way to enumerate the lines a release emits is to compute a
   return, so unlike the field check this cannot run at load time:
   ```
   [draft] engine 2.0.4 returned 1 line(s) that data/opentax-nodes/2025.json declares nowhere,
   so nothing shows them: line20_nonrefundable_credits
   ```
   Declare each one in `computedOnly` with a label, or in `ignoredLines` with a reason a
   preparer could read. This is the mirror image of the rename failure above and arrives through
   the engine's *output*: the figure is netted into the totals either way, so a draft looks
   complete while a line is missing from every surface. It is how the child tax credit went
   unseen when preparer-supplied dependents first landed — the credit changed total tax, and
   nothing showed that a dependent had been counted.

### The hand check

P17's remaining exit criterion is a person checking a draft line by line against a known
packet. Generating a worksheet for a bundle that has a draft return now adds a **`Hand check`**
sheet to the workbook for exactly that: each line carries what the documents report, what the
engine computed, and the box on the named document each contributing figure was read from, so
the check is ticking rather than hunting. Landscape, fitted to one page wide, headers repeated,
omissions first, and somewhere to sign.

The figures come from the **stored** draft, not a freshly computed one — the point is to check
the draft the preparer is looking at. The provenance is rebuilt from the documents as they
stand now, so if a field has been corrected since, the checker sees that rather than having it
hidden.

### What Admin → Draft engine does and does not do

It reports: which binary is running, what both pins say, and every catalogue finding with its
remedy. **It does not upgrade anything, and there is no button that would.** The version is
pinned and checksum-verified at image build precisely so nothing can replace the binary at
runtime; a click that downloaded and swapped an engine would be `install.sh | sh` with better
manners, and §14's pin-and-verify rule exists to forbid exactly that. The page is the part of
this procedure a person can see without a shell — see QUESTIONS.md Q23.

### What CI verifies about the image

`opentax-image` builds `opentax/Dockerfile` from `opentax/pinned.json` and then, in the
**runtime** stage rather than the build stage, checks four things a comment cannot:

1. The engine runs at all — `deno compile` output on `node:24-bookworm-slim`, as a non-root
   user, with no build tooling present.
2. It reports the pinned version, so a moved release or a wrong checksum fails here.
3. **Its AGPL licence is in the image and is the AGPL.** The binary is conveyed in this image,
   so its licence has to travel with it (§8, Q22). It is fetched in the build stage from the
   release tag — not from `main`, which moves — with `curl -f`, so a 404 or an error page fails
   the build instead of being baked in as the licence text.
4. The sidecar comes up and `/health` and `/catalog` answer correctly, which is how the app
   reaches it.

## 8. Licence posture

This app was relicensed **AGPL-3.0-only** on 2026-09-25, from a BUSL-1.1 declaration that never
had licence text committed. OpenTax is verbatim AGPL v3 with no linking exception, and the
Alliance's framing is "open products use it free, closed products pay for it". Relicensing makes
the integration unambiguous instead of arguable, and costs nothing today.

Three things follow. They are open in QUESTIONS.md Q22 and none of them blocks building.

1. **Corresponding Source has to cover the first-party packages.** `@kisaes/vibe-ai-client` is on
   no registry; `@kisaesdevlab/vibe-auth` needs a `read:packages` token even to read. Both are
   Kisaes's to license, but the decision belongs to those repositories.
2. **The AGPL does not require a public repository** — only source offered to those who use the
   service over a network. That matters: this repo is private on the specific ground that
   `docs/wisp-amendment.md` documents firm compliance posture that is not for publication. Staying
   private and offering source on request is compliant. Going public is a separate decision and
   should not be taken before moving or sanitising that file and `docs/sso.md`.
3. **A proprietary licence for the combined work is no longer Kisaes's alone to grant.** Kisaes can
   dual-license its own code; it cannot offer a proprietary licence for a work incorporating AGPL
   OpenTax code without a commercial licence from Filed (`otta@filed.com`). §13 wants a licensed
   Vibe product later, so this is a real fork in the road.

The build is arranged to keep that road open: the engine is invoked as a **separate process over
JSON**, it is a severable optional service rather than a dependency, and with
`DRAFT_RETURN_ENABLED` unset the app contains and ships no OpenTax code at all. Whether that
severability suffices is a lawyer's question, not this file's. **Do not move the integration
in-process, and do not vendor the engine's source into `src/`, without answering Q22.**
