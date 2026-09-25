# WISP amendment — Vibe 1040

**Status: DRAFT. Requires review by whoever owns the firm's WISP before live client data.**
Tracked as QUESTIONS.md **Q12** (unscrubbed page-image egress) and **Q21** (§4.1, the optional
draft return). §4.1 in particular is proposed language that has not been reviewed.

This document states what Vibe 1040 actually does with taxpayer data, so the firm's Written
Information Security Program can describe it accurately. It is written to be pasted into
the WISP with edits, not to stand alone as a policy.

---

## 1. What the system does

Vibe 1040 accepts a bundle of a client's tax source documents (W-2s, 1099s, 1098s, 1095-A,
5498s, K-1s), reads the printed dollar amounts, and produces a worksheet of totals keyed to
Form 1040 and schedule line numbers. Firm staff upload the documents; there is no
client-facing interface and no client account.

The system performs **data capture**. It makes no substantive determination about filing
status, income characterization, deductions, or credits. Items whose treatment requires
professional judgment are listed, unresolved, in a "Judgment Required" section of the
worksheet.

**Since 2026-09-25 the system can also produce an optional draft Form 1040** by passing the
amounts it read to a separate calculation engine that runs on the appliance. It is off by
default, and §4.1 below describes it and the §7216 analysis it requires. Nothing about that
feature causes taxpayer data to reach any party that did not already receive it.

## 2. Categories of information processed

| Category | Where it lives | Retention |
|---|---|---|
| Source documents as uploaded (PDF, images) | Encrypted blob storage | `RETENTION_DOCUMENT_DAYS` (default 7 years) |
| Rasterized page images (derived) | Encrypted blob storage | `RETENTION_RASTER_DAYS` (default 90 days) |
| Extracted field values (dollar amounts, dates, codes) | Postgres | With the source documents |
| Layout spans (text + coordinates) | Postgres | With the source documents |
| Taxpayer identifying numbers | **Salted HMAC-SHA256 hash plus last four digits only** | With the source documents |
| Staff access log | Postgres, append-only | Per firm policy |

**No plaintext SSN or ITIN is written to the database.** The plaintext exists in process
memory only long enough to derive the hash and the last four digits, and is then discarded.
The schema has no column capable of holding one, and the audit logger redacts any
TIN-shaped string before writing.

## 3. Service providers and where data goes

Inference is performed by models reached through **Vibe AI Router**, a separately deployed
firm-controlled service. Vibe 1040 holds no provider credentials and contacts no AI provider
directly.

The router routes each request according to firm policy. Depending on that policy, the
providers may include:

- **local models** running on firm hardware (no egress), and
- **DigitalOcean serverless inference, running open-source models** — currently GLM-5.3
  Flash (classification and layout) and Qwen 3.5 397B (field extraction) — hosted entirely
  within DigitalOcean's infrastructure.

DigitalOcean's published terms for its hosted models, verified 2026-09-01 against
docs.digitalocean.com/products/inference/details/data-privacy: request inputs and outputs
are not stored on DigitalOcean infrastructure; the data is not used to train, retrain, or
fine-tune any model and is not shared with third parties for that purpose; input is never
sent to the original model creator; and "inference requests for DigitalOcean-hosted models
run entirely within DigitalOcean's infrastructure."

**Deliberately excluded from policy for these task classes:** models DigitalOcean hosts on
behalf of Anthropic (Claude Fable carries a mandatory 30-day retention of prompts and
completions for trust-and-safety review) and OpenAI (zero data retention is not available on
DigitalOcean serverless inference). Selecting either would add a second service provider
with its own retention window. The router's policy editor is the control that keeps them
out; that binding is an audited firm-admin action.

**Region.** DigitalOcean publishes no region selection for serverless inference. The only
locational assurance is the "within DigitalOcean's infrastructure" statement above.
DigitalOcean's dedicated inference product is region-addressable (US regions include NYC,
SFO, ATL, RIC) and is the route to a provable US location if the firm ever needs one.

The WISP must name DigitalOcean as a service provider on these terms, and an executed DPA
with DigitalOcean is required before live client data.

### 3.1 What is transmitted — read this paragraph carefully

For cloud-routed requests, **complete rasterized images of the client's tax documents are
transmitted to the cloud provider**, inline in the request body. Those page images contain
everything printed on the document, including the taxpayer's Social Security number, the
employer's EIN, account numbers, and addresses.

The router's redaction ("scrubber") operates on **text** content only. It does not and
cannot redact content inside an image. This is a known and accepted limitation, recorded in
the router repository as Q-087 and accepted for this deployment on 2026-08-26.

Consequences the WISP must state plainly:

- Unredacted taxpayer identifying information leaves the firm's premises for any task class
  bound to a cloud provider.
- The mitigation is contractual (DPA, no-training and no-retention terms) and
  configurational (which provider policy binds these task classes), not technical.
- The firm may eliminate this exposure entirely by leaving the three `v1040_*` task classes
  bound to local models, in which case no document image leaves the appliance.

## 4. §7216 position

Because the system performs data capture and makes no substantive determinations, the
processing is intended to fall within the auxiliary service provider treatment of
Treas. Reg. §301.7216-2(d), which does not require separate written taxpayer consent.

**That treatment depends on processing remaining inside the United States.** Vibe 1040
asserts at startup that the router reports US-region pinning for its task classes and
refuses to start otherwise.

> **Open gap, accepted by decision on 2026-09-02.** As of router v0.0.24 the router has no
> region concept and cannot report pinning state, and DigitalOcean serverless inference has
> no region control for the router to report even once it does. The assertion therefore
> cannot pass, and this deployment runs with it disabled (`ROUTER_REQUIRE_US_REGION=false`)
> as a recorded decision — STATE.md decision log and QUESTIONS.md Q13 — not as an oversight.
> The firm has no technical control guaranteeing US-only processing for cloud-routed
> requests; the §7216 position rests on DigitalOcean's published terms (§3) and the executed
> DPA. Revisit when Router R6 lands (QUESTIONS.md Q11) or if the firm moves to DigitalOcean
> dedicated inference in a named US region.

### 4.1 The optional draft return (added 2026-09-25 — DRAFT LANGUAGE, NOT YET APPROVED)

> **This subsection is a proposal.** It was drafted by the engineer who built the feature and
> **has not been reviewed or approved by the firm.** It is tracked as QUESTIONS.md **Q21**, which
> is open. Until Q21 is answered, the feature is disabled (`DRAFT_RETURN_ENABLED=false`) in any
> deployment holding live client data, and the paragraphs below must not be relied on.

The system can pass the dollar amounts it has read to **OpenTax**, an open-source federal Form
1040 calculation engine (AGPL v3), and display the lines that engine computes beside the
system's own reported totals. A preparer uses it to check the two against each other.

**No new disclosure occurs.** This is the material point for §7216. The engine is a single
binary running on the firm's own appliance, alongside the application and inside the same
network boundary. It holds no credentials, opens no outbound connection, and transmits nothing.
The set of third parties that receive taxpayer information is therefore **exactly the same with
the feature on as with it off** — the service providers listed in §3, and no others. The
§301.7216-2(d) analysis in §3 and above is unaffected.

**The system still makes no substantive determination.** Three controls enforce this, and all
three are in code rather than in guidance:

1. **Anything requiring professional judgment is withheld from the engine entirely**, by
   document and not by field. If any box on a document is one the system marks as needing a
   preparer's judgment and that box is filled in, the **whole document** is withheld. In
   practice this means an SSA-1099 or RRB-1099 never reaches the engine at all, because the
   gross-benefit box is always printed and the taxable portion of Social Security is precisely
   the determination the system does not make. The same applies to every Schedule K-1, to
   SSA-1042S, to a 1099-R marked "taxable amount not determined", and to a 1099-G reporting a
   state or local tax refund.
2. **Filing status is supplied by the preparer**, not inferred. No source document states it,
   and the system will not guess: it asks, and computes nothing until a person answers.
   Age-65, blindness and dependent information come from the preparer on the same basis.
3. **A value no person has accepted does not feed the computation.** A figure flagged for
   review, or one the system cannot tie back to a specific location on the page, withholds its
   document.

**Every figure is presented as advisory and incomplete.** A draft produced from source
documents alone cannot be a return: no bundle carries itemised deductions, estimated tax
payments, cost basis, prior-year carryovers or dependents. The system therefore lists
everything it left out, beside the figures rather than in a footnote, and states on each
surface that the totals are wrong by whatever was withheld. The engine and its version are
named on the artifact.

**No return is transmitted or filed.** The engine is capable of producing an e-file (MeF) XML
document; the system does not use that capability, does not transmit anything to the IRS or to
any transmitter, and has no electronic filing identification number or related surface.

**The position, stated plainly and for the firm to accept or reject.** What changed on
2026-09-25 is that the system now performs *arithmetic* over amounts a preparer has accepted,
from inputs a preparer has stated, on the firm's own hardware. It did not previously do so. The
firm's position is that computing arithmetic from stated inputs is not a substantive
determination about filing status, income characterization, deductions or credits — the
determinations are made by the preparer, before the arithmetic runs, and every question the
system cannot answer without making one is withheld and reported instead. **Whoever owns this
WISP should satisfy themselves that this distinction is one the firm is prepared to defend**,
because it is the distinction the §301.7216-2(d) treatment now rests on.

**One question deliberately left open.** §3 lists the parties that receive taxpayer
information. OpenTax receives none — it is software installed on the appliance, not a service
provider, and on that reading it does not belong in §3 at all. It may nonetheless be worth
naming there for completeness, so that a reader of the WISP knows what is installed and
computing on the appliance. That is an editorial choice for the WISP's owner.


## 5. Safeguards Rule controls implemented in this system

| Control | Implementation |
|---|---|
| Access control | Staff accounts only; no client accounts; role-gated admin functions |
| Multi-factor authentication | TOTP, mandatory — a session is unusable until the second factor is satisfied |
| Encryption in transit | HTTPS at the reverse proxy **in domain mode only** — plain HTTP on the LAN in the appliance's other two network modes, see §5.1; router reached over the internal Docker network |
| Encryption at rest | AES-256-GCM on every blob, applied above the storage driver so it holds for local and B2 alike; Postgres on an encrypted volume |
| Access logging | Every route touching taxpayer data writes an audit row: actor, action, entity, IP, timestamp |
| Change logging | Every correction records before, after, actor, and timestamp; the model's original output is never overwritten |
| Retention and disposal | Enforcing job with a documented schedule; derived page images purge earlier than sources; every disposal is logged |
| Least data | TIN stored as a hash plus last four; no client master; no data collected beyond what the documents carry |

### 5.1 Staff-to-appliance transport is not always encrypted

The encryption-in-transit control above holds only when the appliance runs in domain mode,
where Caddy terminates TLS and a Cloudflare Tunnel is the public ingress. It does not hold in
the appliance's other two network modes, and the firm must know which mode its deployment
runs in.

This application is served at the root of its own subdomain and cannot be mounted under a
path prefix. That has a consequence for transport:

- **LAN mode.** The appliance serves plain HTTP only. Staff reach this app at
  `http://<server-ip>:5177/`. Sign-in credentials, second-factor codes, session cookies,
  page images, and worksheets all cross the office network unencrypted.
- **Tailscale mode.** `tailscale serve` provides TLS for path-mounted apps, but this app
  cannot be path-mounted, so its only address is the same plain-HTTP port. The traffic is
  unencrypted at the HTTP layer and encrypted by WireGuard at the network layer.
- **Domain mode.** HTTPS end to end. The plain-HTTP port remains available as a
  status-check fallback and is not the normal access path.

The compensating controls where TLS is absent are network controls, not application
controls. The appliance firewall restricts the emergency ports to RFC1918 private ranges and
the Tailscale CGNAT range, so they are unreachable from the public internet. In Tailscale
mode the traffic additionally rides inside a WireGuard tunnel.

The application is configured to match. `SESSION_SECURE` marks the staff session cookie
`Secure` only where the transport actually is HTTPS, because a `Secure` cookie on a
plain-HTTP origin is accepted by the browser and never returned, which makes sign-in
impossible rather than more secure. The value is set by the appliance per network mode, and
the application records which way it resolved in its startup log on every boot.

**The firm should run domain mode for daily work if the office network is not otherwise
trusted.** LAN mode is appropriate for a single-site office on firm-controlled network
equipment, and is the documented recovery path when the tunnel is down.

## 6. Disposal

The retention job (`npm run retention`) purges on policy match only, records every disposal
in `purge_log` with the policy and the age that justified it, and supports a dry run. Page
images purge on their own earlier schedule because they are the largest and most sensitive
derivative and nothing downstream needs them once review is complete.

## 7. Incident considerations specific to this system

- **Router compromise** would expose whatever passes through it. Rotate the app token
  (`VIBE_AI_TOKEN`) and review the router's routing audit log for the affected period.
- **`TIN_HASH_SALT` disclosure** makes the stored hashes enumerable, since the TIN space is
  small. Treat salt disclosure as equivalent to disclosure of the TINs themselves.
- **Blob key disclosure** (`STORAGE_ENCRYPTION_KEY`) exposes every stored document and page
  image. It is the single highest-value secret in the deployment.
