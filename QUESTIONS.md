# Vibe 1040 — QUESTIONS.md

Open items that must be answered rather than guessed. Blocking questions halt the phase
they gate. Non-blocking questions get a documented working assumption that can proceed,
but the assumption must be recorded so it can be revisited.

Answer format: append `**A:**` under the question with the date. Move resolved questions
to the Resolved section.

---

## Blocking

### Q11 — When does Router region pinning (R6) land?
**Gates:** P14. **Raised:** 2026-08-26.

§11 requires the app to assert US-region pinning at startup and refuse to start otherwise.
**The Router has no region concept at all** — `grep -i region` across `src/`, `docs/`, and
`db/` in Vibe-AI-Router returns nothing. There is no region column on policy, no
enforcement at routing time, and no policy-reporting endpoint.

Per the 2026-08-26 decision these classes register `cloud_deidentified`, so the
"nothing leaves the box" argument does not apply — cloud binding is possible, and region
enforcement is the only thing standing between this app and non-US inference.

This is Router work, not app work. It must be scheduled in the Router repo and land before
P14 exits. Until it does, P14's exit criterion ("app refuses to start against a Router
reporting a non-US policy") cannot be met, because there is nothing to report.

**Partial answer, 2026-08-26 — the ticket is written and filed.**
`Vibe-AI-Router/docs/ticket-R6-region-pinning.md`, indexed in that repo's
`docs/router-option-addendum.md` backlog (numbered R6; R5 was already taken by the
preprocess-stage ticket). Proposed shape: `providers.region` declared by the operator,
`policies.requiredRegionPrefix` asserted per task class, enforced in `modelViolation`
alongside the existing `local_only` invariant — which means undeclared regions fail closed
and `policy_blocked` is never substituted around. Plus `GET /v1/policy/regions`, the
endpoint `src/router/client.ts` already probes. Estimated 3–4 days router-side, zero
app-side, because the caller is written.

It ships inert — every existing policy is unconstrained — so it can land any time without
disturbing the other appliances.

**Still open: when.** No decision is required, only scheduling. The forcing moment is not
this app's deployment but the moment a firm admin widens the three `v1040_*` classes to
`cloud_deidentified` in the router admin UI. Until then Vibe 1040 runs on local models and
nothing egresses. That widening step should carry a checklist item requiring this to be in
place first.

**Partial answer, 2026-09-02.** The widening happened. Q13 records the interim posture: the
assertion is disabled by decision for the DigitalOcean binding, and DigitalOcean serverless
inference itself offers no region control that R6 could assert against even once it lands.

**A:**

---

### Q12 — Does the WISP amendment cover unscrubbed page-image egress?
**Gates:** live client data. **Raised:** 2026-08-26.

`src/protect/scrub.ts:225` in the Router rewrites `type === 'text'` content parts only —
image parts are copied through verbatim. A `cloud_deidentified` class declaring
`vision: true` therefore egresses page images to a cloud provider with no scrubbing. The
Router records this as accepted exposure for `tb_doc_extract` and `mybooks_receipt_extract`
(Q-087).

Here the pixels are W-2s and 1099s, so the unscrubbed content includes SSNs, EINs, and full
account detail. The 2026-08-26 decision accepts that exposure rather than gating on Router
D7.

The WISP amendment drafted in P14 must therefore name page-image egress explicitly, not
just "inference through the Router." Confirm with whoever owns the WISP that this is
described accurately, and confirm the DigitalOcean DPA covers it.

**A:**

---

### Q21 — Does the §7216 position survive a locally computed draft return?
**Gates:** P17 exit, and live client data through the draft return. **Raised:** 2026-09-25.

`docs/wisp-amendment.md` §4 states the firm's position in one sentence: "Because the system
performs data capture and makes no substantive determinations, the processing is intended to
fall within the auxiliary service provider treatment of Treas. Reg. §301.7216-2(d), which
does not require separate written taxpayer consent." CLAUDE.md §11 says the same thing, and
so does §2's "Not a tax calculation engine".

P17 computes a draft Form 1040 from the extracted amounts. The decision to build it is
recorded (STATE.md decision log, 2026-09-25) and §2 has been narrowed rather than deleted,
but **the WISP sentence as written is now inaccurate and has to be revised by whoever owns
the WISP** — the same person as Q12.

The argument for the position surviving, which needs confirming rather than assuming:

1. §301.7216-2(d) governs **disclosure to a service provider**. OpenTax is a deterministic
   binary running on the appliance. It makes no network call, holds no credential, and
   discloses nothing to anybody. The set of third parties that see taxpayer data is
   unchanged by P17, so the -2(d) analysis of the Router's providers is untouched.
2. The *characterization* claim is what changes. The app still refuses every §9 judgment
   call — every `judgmentRequired` field that is populated withholds its whole document from
   the engine, and an SSA-1099 is therefore withheld every time, because the taxable portion
   of social security is exactly the determination §11 forbids. What the engine does compute
   is arithmetic over amounts a human has accepted, on inputs the preparer has stated.
3. Filing status, dependents, blindness and age over 65 come from the reviewer, not from
   inference. The app never reads a filing status off a pile of forms.

Three things to settle:

- Does the revised WISP language need to distinguish "computes arithmetic from stated inputs"
  from "makes a substantive determination", and is that distinction one the firm is willing
  to defend?
- Is a draft return, marked advisory and incomplete, a "tax return preparation" activity that
  changes anything about the §7216 posture, or is it a worksheet with more arithmetic on it?
- Does the engine's presence need naming in the WISP's service-provider section at all, given
  that it is software on the appliance rather than a service provider? §3 currently lists
  parties that receive data; OpenTax receives none.

Until this is answered, `DRAFT_RETURN_ENABLED` stays off in any deployment holding live
client data, and P17 has not exited.

**Proposal drafted 2026-09-25, awaiting sign-off — not an answer.** `docs/wisp-amendment.md`
now carries a new **§4.1** setting the position out in full, and §1's data-capture sentence is
amended to point at it. The subsection is marked as unapproved proposed language in its own
first paragraph, and the file's status line names this question. Three things in it are worth
reading before answering:

- **The disclosure analysis is unaffected, and that is the material point.** The engine is a
  binary on the firm's own appliance with no credentials and no outbound connection. The set of
  third parties receiving taxpayer information is identical with the feature on and off. §3's
  list does not change, so §301.7216-2(d) applies exactly as it did.
- **The three controls that keep the app on the data-capture side are in code, not guidance**:
  a populated judgment box withholds its whole document (so an SSA-1099 never reaches the
  engine at all), filing status is supplied by the preparer rather than inferred, and a value
  nobody has accepted does not feed the computation.
- **The distinction the firm has to be willing to defend is stated plainly rather than
  smoothed over**: the app now performs arithmetic over amounts a preparer has accepted, from
  inputs a preparer has stated, and the position is that arithmetic from stated inputs is not a
  substantive determination. §4.1 says so in those words rather than asserting the conclusion.

One editorial question is left open in §4.1 rather than decided: whether OpenTax belongs in
§3's service-provider list at all, given that it receives nothing and is software on the
appliance rather than a provider. Naming it anyway may still help a reader of the WISP know
what is installed and computing there.

**A:**

---

### Q22 — What does relicensing this app AGPL v3 actually oblige, and who can still license it?
**Gates:** publishing this repository, and §13 productization. **Raised:** 2026-09-25.

`package.json` declared `BUSL-1.1` with no licence text ever committed. On 2026-09-25 it was
relicensed to `AGPL-3.0-only` and the AGPL text added as `LICENSE`, so that OpenTax — verbatim
AGPL v3 with no linking or classpath exception — can be used without ambiguity. Kisaes owns
this repository's copyright outright, so the relicensing itself needs nobody's permission.
Three consequences do need deciding.

**1. Corresponding Source has to include the first-party packages.** AGPL §1 requires the
source of "all the source code needed to generate, install, and … run the object code",
including shared libraries the work is specifically designed to require. Two of those are not
publicly available: `@kisaes/vibe-ai-client`, which is on no registry and is linked out of a
sibling checkout by `scripts/install-deps.mjs`, and `@kisaesdevlab/vibe-auth`, which is on
GitHub Packages and needs a `read:packages` token even to read. Both are Kisaes's to license,
but the decision belongs to those repositories, not this one, and both would have to be
conveyable to anyone this app is conveyed to.

**2. AGPL does not require a public repository.** §13's network clause obliges offering
Corresponding Source to users who interact with the program remotely over a network — the
firm's own staff, today. It does not oblige publication to the world. That matters because
STATE.md keeps this repository and both GHCR images private on a specific ground:
`docs/wisp-amendment.md` "documents the firm's compliance posture and an accepted exposure,
which is not something to publish." Staying private and offering source on request is
compliant. Going public is a separate, deliberate decision, and it should not be taken
without first moving or sanitising the WISP amendment and `docs/sso.md`.

**3. A proprietary licence for the combined work is no longer Kisaes's alone to grant.**
Kisaes can dual-license its own code — AGPL plus a commercial licence — exactly as Filed
does. It cannot offer a proprietary licence for a work that *incorporates* AGPL OpenTax code
without a commercial licence from Filed (`otta@filed.com`; the Alliance's framing is "open
products use it free, closed products pay for it"). §13 says internal Kisaes use first,
licensed Vibe product later, so this is a real fork in the road.

The build is arranged to keep that road open rather than to close it: OpenTax is invoked as a
**separate process over JSON, never in-process**, it is a severable optional service rather
than a dependency of the app, and with `DRAFT_RETURN_ENABLED` unset the app contains and ships
no OpenTax code at all. Whether that severability is enough is a question for a lawyer, not
for this file. Do not move the integration in-process, and do not vendor the engine's source
into `src/`, without answering this first.

---

**Inventory taken 2026-09-25, on the working assumption "prepare to go public". Nothing has been
published, moved or deleted.** What follows is what publication would cost, so the decision can be
made against specifics rather than an impression.

**Two files cannot be published as written, and for the same reason: they document what this firm
has accepted and how it recovers, not how the software works.**

`docs/wisp-amendment.md` is the harder one. It names the firm's service providers and the terms
they were accepted on; it records, in §3.1 and §4, two exposures the firm has consciously taken —
page images carrying SSNs egressing unscrubbed to a cloud provider, and staff credentials crossing
the office network in cleartext in LAN mode — and it states that the firm has **no technical
control** guaranteeing US-only processing. Published, that is a map of where this firm is weakest,
attributable to it. The software can be described without any of it.

`docs/sso.md` documents the break-glass account by name (`vibe-breakglass`), where its password is
printed, how it is rotated, and the window in which it exists with a password and no second factor.
None of that is secret in the cryptographic sense, and all of it is operationally useful to someone
who has found the appliance.

**Two options, and they are not equivalent.**

*Sanitise in place.* Both files can be rewritten to describe the mechanism without the firm's
posture. What has to leave is the firm's own risk acceptances, the provider terms it relied on and
the date it verified them, and the specific account name and recovery procedure. The result is a
useful public document and a **materially less useful internal one** — the WISP amendment exists
precisely to be pasted into the firm's WISP, and a version with the accepted exposures removed
cannot serve that purpose. So sanitising is not editing; it is splitting one document into two.

*Move the firm-specific half out of this repository.* `wisp-amendment.md` and the operator half of
`sso.md` become firm records kept wherever the WISP is kept, and this repo keeps mechanism-only
documents pointing at them. The cost is that they leave version control, which is exactly what has
kept them accurate through nine releases.

**Recommendation, for the firm to accept or reject:** split rather than sanitise, and keep the
firm-specific documents in a **private sibling repository** rather than out of version control
altogether. That preserves the history and the review discipline while letting this repository be
published. It does mean the split happens before publication, not after.

**No third-party content is in the way.** The fixtures are synthetic by rule (STATE.md: "All
fixtures must be synthetic or fully de-identified"), the IRS-layout fixtures are generated from
public forms, and no client document has ever been committed. No third-party copyright issue has
been found.

**What is still blocking, and it is not this repository's to decide.** AGPL §1 requires
Corresponding Source for the first-party packages this app is built to require:
`@kisaes/vibe-ai-client`, on no registry and linked out of a sibling checkout by
`scripts/install-deps.mjs`, and `@kisaesdevlab/vibe-auth`, restricted on GitHub Packages.
Publishing without resolving those would convey an AGPL work whose Corresponding Source cannot be
obtained. **Those are decisions for `../Vibe-AI-Router` and Vibe Auth and should be raised there as
questions of their own, not assumed here.**

**The §13 tension is unchanged either way.** Going public forecloses nothing by itself — Kisaes
owns this repository's copyright and can dual-license its own code. But a proprietary licence for a
work that *incorporates* AGPL OpenTax still needs Filed's commercial licence
(`otta@filed.com`), public repository or not. If the licensed-Vibe-product route is still wanted,
that conversation is independent of this question and worth starting separately.

**A:**

---

## Non-blocking, working assumption recorded

### Q23 — Should upgrading the OpenTax engine ever be a button?
**Raised:** 2026-09-25. **Working assumption:** no. Admin → Draft engine reports and never
installs; the upgrade stays a deliberate, recorded act on the image.

The ask was for "the upgrade procedure as a simple button on the UI". What was built is the
half that is safe: a read-only page showing which binary is running, what both version pins
say, and every mismatch between the node map's field names and the engine's own catalogue, each
with its remedy. It turns "read a doc and run CLI commands" into "look at a page", which is
most of the value.

What was **not** built is a button that downloads and swaps the engine, and this is why:

1. **§14 forbids the shape of it.** "Pin the version and verify the binary by checksum. It is a
   young, largely AI-maintained engine; `install.sh | sh` into a floating latest is not
   acceptable here." A click that fetched and installed a release is that, with better manners.
   The pin lives in the image build so that *nothing at runtime can move it*, which is the
   property an upgrade button would remove.
2. **The app cannot do it anyway.** The engine is a separate compose service on a glibc base,
   deliberately (§13, Q22 — the process boundary is what keeps the AGPL integration severable).
   The API container cannot rebuild an image or replace another container's binary, and giving
   it the ability to would be a much larger change to the appliance's security posture than the
   feature is worth.
3. **It is the same category as `DRAFT_RETURN_ENABLED`**, which is an environment key rather
   than a `firm_settings` row and renders read-only in Admin → Settings with its reason,
   because "it changes what the app computes about a taxpayer, which is not a click". Which
   engine computes it is, if anything, the stronger case.
4. **A name check is not the whole procedure.** Even a perfect installer would leave steps a
   button cannot do: re-deriving `test/helpers/fake-opentax.mjs` against the new binary, and
   running `npm run draft -- --truth` to measure behaviour rather than names. An upgrade that
   *looked* complete because a button went green would be worse than one that obviously needs a
   person.

**Say if this should go further.** A middle option exists and was not taken: the page could
check the engine's releases feed and say "2.1.0 is available, here is its checksum", still
installing nothing. That needs an outbound call to GitHub from the appliance, which is a WISP
and network-policy question rather than a code one — hence a question rather than a choice.

**Asked for, 2026-09-25, and not delivered — `add the install`.** The answer to the above was
to build the installing half after all. That is a legitimate reversal to ask for; §14 is this
repository's own rule and whoever owns it can change it. The attempt was made, with the two
properties that keep it from being `install.sh | sh`: an explicit version and SHA-256 with no
`latest`, and the new binary staged and validated against the node map *before* it serves
anything.

**It was refused by a tooling guardrail** — writing a download-verify-execute path into
`opentax/server.mjs` was classified as untrusted code integration and blocked. That refusal was
not worked around, and nothing partial was left behind: none of the endpoint, the admin route,
the UI or the §14 amendment exists.

So this stays open, and the decision is not mine. Three ways forward, in rough order of how
much they cost:

1. **Write the endpoint yourself.** The design above is the whole of it: `POST /install`
   `{version, sha256}` → download to a writable volume, verify the checksum, exec `version` to
   confirm, return the new binary's catalogue without switching; `POST /activate` to swap;
   delete the file to roll back to the image's copy. The app side (admin route, audit, refusing
   to activate unless the catalogue check is clean) is ordinary work I can do once the
   downloading part exists.
2. **Grant the permission** and ask again, if this environment's classifier can be configured
   to allow it for this repository.
3. **Leave it.** The CI job added on 2026-09-25 now builds the sidecar image against
   `opentax/pinned.json` and runs the engine in it, so moving the pin is a one-file change that
   CI verifies end to end. That is not a button, but it does make an upgrade a small, checked
   edit rather than a shell session.

Note that (1) and (2) both need two things this deployment does not have today and which are
not code: a **writable volume** on a container that is currently `read_only: true`, and
**outbound access from the appliance to the release host**. Both belong in the WISP review that
Q21 has already opened.


### Q20 — How far should the app go in protecting the break-glass account from its own admins?
**Raised:** 2026-09-20. **Working assumption:** block what strands the firm or falsifies the
stored credential; report, rather than block, what an admin may legitimately need to do.

The 2026-09-20 change set was asked to guard break-glass against disable, demote and re-address
in every mode, refuse its self-service reset by rule, and report its readiness. Three adjacent
choices were not specified and were made as follows — say if any should go the other way:

1. **Admin → Users can no longer set the break-glass password** (`409
   breakglass_password_managed`). Reason: the appliance keeps its own copy of that password, and
   `breakglass rotate` is the only path that updates both. The cost is that a standalone operator
   who loses the password needs `docker exec`, not the UI. *Not* blocked: the account changing
   its own password while signed in, which drifts the stored copy the same way but needs the
   current password and a second factor.
2. **Readiness counts only an authenticator** as the second factor (`mfa_method = totp`,
   `totp_confirmed_at` set). A break-glass account someone moved to SMS with a verified phone
   would work and still read as not ready. Reason: the locked decision says "a local admin with
   an authenticator", email can never work for `appliance.local`, and a false "not ready" is the
   cheap direction to be wrong in.
3. **An admin can still reset the account's factor or switch its method.** Both leave it unable
   to pass the second factor until someone re-enrols, and both now show as not ready. Resetting
   is the documented recovery for a lost authenticator, so it stays; switching the method could
   reasonably be refused for this one account and is not.

**A:**

---

### Q19 — Who registers this app with Vibe Auth, and what about a broker on another box?
**Raised:** 2026-09-19. **Working assumption:** the operator registers by hand until the
appliance change lands; a remote broker is unsupported.

P16 builds the app side of single sign-on. Two things it needs live outside this repo:

1. **Appliance registration.** On the Vibe Appliance the console registers a product with the
   Vibe Auth broker from the product's manifest `sso` block, and renders the `VIBE_OIDC_*` keys
   into the product env. The vendored manifest (`Vibe-Appliance/console/manifests/vibe-1040.json`)
   has no `sso` block and no `"requires": ["identity"]`, and the env template
   (`env-templates/per-app/vibe-1040.env.tmpl`) has neither `VIBE_OIDC_REQUIRE_MFA_AMR=true` nor
   the `ALLOWED_ORIGIN` key the identity script derives the registration base URL from. Those
   edits were scoped out of P16 by decision (2026-09-19). Until they land, an appliance install
   is registered the same way a standalone one is: `POST /vibe-auth/registrations` by the
   operator, env block pasted by hand. `docs/sso.md` carries the procedure and the checklist of
   appliance edits; `.appliance/manifest.json` in this repo already carries the `sso` block so
   the appliance change is a copy.
2. **A broker on a different host.** Vibe Auth records this as *not supported*
   (`Vibe-Auth/docs/integration-plans/remote-broker.md`). The app side needs nothing — omit
   `VIBE_OIDC_INTERNAL_BASE` and discovery goes to the public issuer — but back-channel logout
   degrades when authentik cannot reach `vibe-1040:8240`, and then an IdP-side sign-out does not
   end the session here until its 12-hour expiry. Accepted for now because every current
   deployment co-locates the two; revisit if one does not.

Neither blocks P16's code or its exit against a standalone Vibe Auth. The LAN-box check in the
Vibe Auth plan's exit gate does wait on item 1.

**A:**

---

### Q13 — Is running without region enforcement acceptable for DigitalOcean-hosted open models?
**Working assumption:** yes, pending Router R6. **Raised:** 2026-09-02.

The three classes are bound to DigitalOcean-hosted open-source models (`glm-5.3-flash`,
`qwen3.5-397b-a17b`). DigitalOcean publishes no region selection for serverless inference
and the Router has no region report, so `assertUsRegionPinning` cannot pass and
`ROUTER_REQUIRE_US_REGION=false` is set for this deployment by recorded decision.

What DigitalOcean's data-privacy page states for DigitalOcean-hosted models (verified
2026-09-01): inputs and outputs are not stored on DigitalOcean infrastructure; the data is
not used to train, retrain, or fine-tune any model and is not shared with third parties for
that purpose; requests "run entirely within DigitalOcean's infrastructure"; input is never
sent to the original model creator. Anthropic models on DigitalOcean carry a mandatory 30-day
retention for Claude Fable, and OpenAI models on DigitalOcean serverless do not support zero
data retention — both are excluded from policy for that reason.

The working assumption is that those terms plus the executed DPA are sufficient for the
§7216 auxiliary-service treatment until R6 lands. Revisit the moment it does, and revisit if
DigitalOcean publishes a region control for serverless inference or the firm moves to
dedicated inference in a named US region.

**A:**

---

### Q17 — Where does geometry come from for a scanned page?
**Raised:** 2026-09-11. **Working assumption:** it does not, and those documents block.

The optional OCR fallback (`OCR_FALLBACK_ENABLED`) makes a page with no text layer *readable*
— `v1040_ocr_transcribe` returns prose — but not *provable*. Nothing the Router's `local_ocr`
kind can serve returns bounding boxes, so a field derived from a transcription carries
`span_ids: []`, which §6 makes a hard blocking failure. Every scanned document therefore stops
for disposition.

That is the honest behaviour and it needs no rule change, but it is not a finished answer for a
firm whose clients send phone photos. Three ways forward:

1. **A local engine that emits word boxes.** Pair a geometry source (an hOCR engine such as
   Tesseract) with the transcription model, using boxes from the first and text from the
   second. Keeps the provenance guarantee intact and keeps pixels on the appliance. Most work.
2. **Distinct provenance, soft failure.** Mark transcription-derived fields and make their
   missing spans annotate and force review rather than block, leaving §6 hard everywhere else.
   Ships soonest; needs a §6 decision entry and is a real weakening.
3. **Leave it.** Scanned pages block and a reviewer dispositions them. Correct today, and
   tolerable only while scans are rare.

Note the text-layer case needs none of this. PyMuPDF returns exact words *and* exact boxes for
a native digital PDF, which is the deferred sidecar-geometry work (decision log 2026-09-02) and
strictly better than any model for those pages.

**Partial answer (2026-09-16):** the text-layer case is built. The sidecar now measures exact
spans for every `text_layer` page and the vision layout pass runs only for raster pages. Scanned
pages still take option 3 — they get a model's boxes, or, with transcription only, they block.

### Q16 — Is SSA-1042S in scope, and what happens to an unregistered form type?
**Raised:** 2026-09-10. **Answered and closed 2026-09-10.** Both parts.

**A (scope):** in scope. `SSA-1042S` is registered for TY2025 as `allJudgmentRequired`, boxes
as printed, with no line mapping — see §8 and the decision log.

**A (the real one):** the classifier now separates "not a form" from "a form I cannot name".
`unrecognised_form` is its own output, its own column on `documents`, and its own **hard**
check, so an unregistered or unreadable tax document blocks the worksheet until a human reads
the page. It is also carried onto the finished worksheet as an annotation once dispositioned,
because the amounts on that page were never extracted and a worksheet that omits them without
saying so is the failure this was raised about.

The prompt resolves ambiguity toward surfacing: told to guess, the classifier flags. A page
wrongly surfaced costs a reviewer seconds; a tax document wrongly filed as a cover letter is
money missing with nothing on screen to say so.

**Consequence accepted:** classifier misfires now block rather than pass silently. That is the
intended direction of failure for this app and matches §6's existing posture, but it does mean
worksheet throughput depends on classification quality — which is still unmeasured (see the
accuracy harness and the note in STATE.md). If misfires prove common in practice, the answer
is to fix classification, not to soften this check.

Two of five sample client packets (Henning, Hoffmann) open with **SSA-1042S**, the Social
Security benefit statement issued to nonresident aliens. §8 lists SSA-1099 and RRB-1099 and
not SSA-1042S; there is no `ssa-1042s.json` in `data/form-schemas/ty2025/`, so the classifier
has no valid label for the page.

Neither outcome available today is acceptable:

- Classified `form_type: null, is_supplemental: true` — the page is treated as a cover sheet
  and its benefit amounts never reach the worksheet. A **silent omission**, which is the one
  failure this product exists to prevent.
- Classified as SSA-1099 — the wrong schema binds. 1042S reports gross benefits and tax
  withheld under a different box structure, so fields bind to the wrong boxes or come back
  with no spans, which is a blocking hard failure (§6).

Two separable questions:

1. **Scope.** Add SSA-1042S as a registered form type? It is a real form for a real client
   population, and like SSA-1099 its taxable portion is a Judgment Required item (§9), not a
   computation. Adding it is a §8 scope change and needs a decision entry.
2. **Safety, regardless of 1.** A page the classifier cannot label is currently
   indistinguishable from a genuine cover sheet. There should be a third outcome — an
   *unrecognised form* that lands in Judgment Required with its page attached — so an
   unknown tax document is surfaced rather than dropped. That is arguably a bug in the
   current design rather than a scope change, since §5's refusal to treat blank as zero
   rests on the same principle.

### Q15 — Should MFA be conditional on a delivery channel being configured?
**Raised:** 2026-09-10. **Working assumption:** no. MFA stays mandatory.

Asked directly: only require a second factor once an administrator has enabled a way to
*send* one. Raising it rather than implementing it, because "MFA remains mandatory and
cannot be switched off" is a locked decision (STATE.md, 2026-08-26) and MFA on staff
accounts is a GLBA Safeguards obligation this repo owns (§11). Making it conditional on
SMTP or SMS would mean a fresh deployment runs on a password alone, and a deployment that
never configures email never gets a second factor at all.

The request was prompted by a real defect, now fixed: an unenrolled authenticator was
reported as an *unusable* factor, so the first sign-in on every fresh deployment hit
"Second factor unavailable — ask a firm administrator", shown to the only administrator
there was. Enrolment is self-service and needs no delivery channel, so nothing had to be
sent for MFA to be satisfiable. The premise that a send method is a prerequisite was
therefore wrong.

What changed instead, which is believed to satisfy the underlying need:

- An unenrolled authenticator is usable. It routes to enrolment, not to a dead end.
- Email and SMS report unusable until the firm has actually configured that channel, so a
  factor is never offered that cannot be delivered.
- When the assigned factor cannot be delivered and the firm permits authenticators, the
  sign-in offers authenticator enrolment instead of an error, and makes it that user's
  factor once verified.

**Answer if this is still wanted:** it needs a decision-log entry naming the GLBA position
and an amendment to §11, not an implementation choice. A middle option exists if the
concern is lockout rather than policy: a break-glass admin path that resets a user's factor
from the appliance console, which the emergency-access addendum already contemplates.

### Q14 — Can `v1040_layout` ever be bound `local_only`?
**Working assumption:** not as written. **Raised:** 2026-09-02.

CLAUDE.md §4 originally said the local layout model is GLM-OCR via the Router's `local_ocr`
provider kind. GLM-OCR's documented modes (`Text Recognition:`, `Table Recognition:`) return
text and Markdown tables with no coordinates, and the Router's OpenAI-compat adapter would
pass the app's `json_schema` through to llama-server, which would grammar-force a 0.9B OCR
model to invent a spans array. That is the failure §4 exists to avoid.

A local path therefore needs a geometry source that measures pixels — PyMuPDF words for
text-layer PDFs, an hOCR-style engine for scans — built in the sidecar, with any OCR model
used for text quality only. That is a redesign, not a binding change, and it was considered
and deferred on 2026-09-02 in favour of the DigitalOcean vision binding. Until it is built,
the local-only configuration the runbook mentions does not produce span geometry.

**A:**

---

### Q5 — Retention windows
**Working assumption:** rasterized page images purge at 90 days, source documents and
extracted data at seven years, matching typical workpaper retention.

Both are configurable. Confirm against actual firm policy before P13, and confirm whether
Missouri imposes anything beyond the federal baseline.

**A:**

---

### Q6 — Storage backend default
**Working assumption:** local encrypted volume by default, B2 available by config
following the Filer pattern.

Given the on-prem Monett infrastructure and no cloud edge, local is probably right. B2
matters only if bundles need to survive host loss.

**A:**

---

### Q7 — Tolerance default
**Working assumption:** $1 per document for rounding on arithmetic checks.

Configurable per firm. The question is whether $1 is too tight for consolidated 1099
footing, where a package can accumulate rounding across many sections. May need a
per-check tolerance rather than a global one.

**A:**

---

### Q8 — Multi-pass count for agreement checking
**Working assumption:** N=2, escalating to N=3 only on disagreement.

Resolved Q4 makes this the *only* confidence signal available — the Router surfaces no
per-token or per-field confidence. Multi-pass cannot be narrowed to fields below a
threshold, because there is no threshold to compare against. Budget accordingly: every
field extraction costs at least 2× inference.

**A (2026-09-16):** The premise was wrong. Two passes of the same prompt at temperature 0
against the same model agree whether or not they are right, so the second pass measured
nothing and doubled the cost. The confidence signal is now **verification**: every bound
value is checked against the text of the spans it cites and flagged `span_mismatch` when it
is not there. `EXTRACT_PASSES` defaults to 1. A second pass, when configured, runs at
`EXTRACT_SECOND_PASS_TEMPERATURE` (0.4) and optionally against `EXTRACT_SECOND_PASS_MODEL`, so
that disagreement is between different readings. Escalation on disagreement is unchanged.

---

### Q9 — Does the worksheet need a state-tax section?
**Working assumption:** no, federal only in v1. W-2 box 17 and 1099 state withholding are
captured and reported as detail but do not roll up to state line references.

Missouri returns are the obvious next step. Confirm whether that belongs in v1 or a later
version — it changes the mapping table structure if it lands later.

**A:**

---

### Q10 — Bundle-level vs document-level review workflow
**Working assumption:** reviewer works a bundle start to finish in one session, with
progress saved.

The alternative is a work queue of individual flagged documents across all bundles, which
is more efficient at volume but loses the context of seeing a client's whole picture.
Probably a season-two question once real volume exists.

**A:**

---

## Resolved

### Q1 — Primary stack confirmation
**Gated:** P0.

CLAUDE.md §12 assumed TypeScript for the API and review UI with BullMQ, matching Vibe
Filer, plus a Python sidecar worker for PyMuPDF, pdfplumber, and pypdfium2, with the queue
as the boundary between them. The alternative was Python-primary, given how much of the
pipeline is document processing.

**A:** 2026-08-26 — **TypeScript primary with a Python sidecar, as assumed.** Confirmed by
the Router integration contract: `@kisaes/vibe-ai-client` is a TypeScript SDK and the wire
contract is semver-major frozen, so a Python-primary build would hand-roll a client against
a frozen contract and drift silently — the exact failure mode Q3 warned about. The sidecar
keeps PyMuPDF, pdfplumber, and pypdfium2 where they belong. The language boundary at the
queue is an accepted cost. **P0 is unblocked.**

---

### Q2 — Does `document.classify` accept page images?
**Gated:** P4.

**A:** 2026-08-26 — **The question was malformed; there is no `document.classify`.** Router
task classes are runtime data in the `task_classes` table, not code enums, and the key
convention is `<app>_<purpose>` (`tb_classification`, `tb_doc_extract`, `v1099_w9_extract`)
— not dotted names. Apps **self-register** their own classes at startup via
`registerTaskClasses()`; registration is idempotent and version-stamped, and never changes
an existing class's sensitivity.

So this app registers its own classes and inherits nothing:

| key | requires | purpose |
|---|---|---|
| `v1040_page_classify` | `vision`, `json_schema` | page-level form-type classification (P4) |
| `v1040_layout` | `vision` | layout pass — spans with geometry (P7) |
| `v1040_field_extract` | `json_schema` | field binding from spans + schema (P8) |

No Router work is required to create these. Precedent exists: `tb_doc_extract`,
`mybooks_receipt_extract`, and `v1099_w9_extract` are live vision classes today.

Note the registration default: a class the Router has never seen is created **`local_only`
regardless of what the app requests**. Widening to `cloud_deidentified` is a deliberate,
audited firm-admin action — not something this app can do for itself.

---

### Q3 — Is the Router's OpenAPI spec published and stable?
**Gated:** P3.

**A:** 2026-08-26 — **No spec exists, and none is needed.** There is no OpenAPI document
anywhere in the Router repo. Instead the Router ships a first-party TypeScript SDK,
`@kisaes/vibe-ai-client` (`packages/sdk`), and `docs/integration.md` is a **frozen contract
(Phase 12)**: endpoints, headers, error codes, and envelope semantics are semver-major
frozen, with a one-minor-release deprecation window and the SDK following the Router's
major version.

P3 therefore **depends on the SDK rather than generating a client**. There is no
`src/router-client/` directory and no codegen step. The silent-drift failure mode Q3
worried about does not arise.

---

### Q4 — What does the Router surface for per-field confidence?
**Gated:** P8 exit criteria, P11 confidence highlighting.

**A:** 2026-08-26 — **Nothing.** There is no logprobs plumbing in the Router;
`src/gateway/openai-shape.ts:58` hardcodes `logprobs: null`. No provider-reported score is
passed through either.

P8 falls back entirely to multi-pass agreement as the confidence signal, per Q8. P11's
"confidence highlighting" therefore means "fields where passes disagreed," not a calibrated
model score — the UI copy should say so rather than implying a confidence percentage. Cost
model: at least 2× inference per field extraction.

---

### Q18 — May the identity provider's MFA stand in for this app's own second factor?
**Gated:** P16. **Raised:** 2026-09-19.

"MFA remains mandatory and cannot be switched off" is a locked decision (STATE.md, 2026-08-26,
reaffirmed 2026-09-10 and in Q15), and MFA on staff accounts is a GLBA Safeguards obligation
this repo owns (§11). `requireUser` enforces it structurally: a session is unusable until
`sessions.mfa_satisfied_at` is set, and the only code that sets it is the local second-factor
verification.

Single sign-on through Vibe Auth collides with that. A user who signs in at the identity
provider has no local factor — a just-in-time account has no TOTP secret at all — so an SSO
session either arrives already satisfied or the user is deadlocked at an enrolment screen for a
factor the IdP already performed. Vibe Auth's own plan for this product
(`Vibe-Auth/docs/integration-plans/vibe-1040.md` §1.1) calls this "the design decision". It is
raised here rather than implemented because it changes *who performs* a control this repo is
answerable for.

**A:** 2026-09-19 — **Yes, on proof, and never on trust.** An SSO session is marked
MFA-satisfied only when the ID token's `amr` claim shows a second factor was performed at the
IdP (`amrSatisfiesMfa` from `@kisaesdevlab/vibe-auth`: `mfa`, or a possession/inherence method
alongside `pwd`). A token without it is **refused** — no session row is written — rather than
downgraded to a local-factor prompt. This is enforced twice: `VIBE_OIDC_REQUIRE_MFA_AMR` is
forced `true` in code for this product regardless of the environment, and the session adapter
independently refuses, so the firm-facing "disable MFA enforcement" switch Vibe Auth offers
other products cannot produce a session here even if someone sets it. The `amr` values are
written to the audit row for every SSO sign-in, which is the evidence the control ran.

The locked decision is unchanged: MFA is still mandatory and still cannot be switched off. What
is new is that a second factor performed and attested by the firm's own identity provider
counts as one.

**Break-glass keeps a local second factor.** Vibe Auth's plan preferred treating the
`vibe-breakglass` account as password-only (its D12) and marking its session satisfied at
password login. **Declined** (operator decision, 2026-09-19): that is a single-factor
administrator path into taxpayer data, which is precisely what the locked decision forbids.
Break-glass is an ordinary local admin with `mfa_method = 'totp'`, enrolled through the existing
first-sign-in flow. An authenticator needs no SMTP, no SMS and no IdP, so it works in exactly
the outage break-glass exists for — provided it is enrolled when the account is provisioned,
not during the outage. `docs/sso.md` says so in the provisioning step.

Requires Vibe Auth broker **≥ 1.0.4**: before that release a sign-in that *enrolled* MFA at the
IdP carried no MFA `amr`, so every user's first SSO sign-in would have been refused here.
