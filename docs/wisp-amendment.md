# WISP amendment — Vibe 1040

**Status: DRAFT. Requires review by whoever owns the firm's WISP before live client data.**
Tracked as QUESTIONS.md Q12.

This document states what Vibe 1040 actually does with taxpayer data, so the firm's Written
Information Security Program can describe it accurately. It is written to be pasted into
the WISP with edits, not to stand alone as a policy.

---

## 1. What the system does

Vibe 1040 accepts a bundle of a client's tax source documents (W-2s, 1099s, 1098s, 1095-A,
5498s, K-1s), reads the printed dollar amounts, and produces a worksheet of totals keyed to
Form 1040 and schedule line numbers. Firm staff upload the documents; there is no
client-facing interface and no client account.

The system performs **data capture only**. It makes no substantive determination about
filing status, income characterization, deductions, or credits. Items whose treatment
requires professional judgment are listed, unresolved, in a "Judgment Required" section of
the worksheet.

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
- **cloud providers** contracted through the router, currently DigitalOcean.

The WISP must name the router's configured providers as service providers, and an executed
DPA with DigitalOcean is required before live client data.

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

> **Open gap.** As of router v0.0.24 the router has no region concept and cannot report
> pinning state. The assertion therefore cannot pass, and deployments are running with it
> disabled. Until the router implements region pinning (QUESTIONS.md Q11), the firm has no
> technical control guaranteeing US-only processing for cloud-routed requests, and the
> §7216 position rests on provider contracts alone. **This should be resolved before live
> client data is processed through a cloud-bound task class.**

## 5. Safeguards Rule controls implemented in this system

| Control | Implementation |
|---|---|
| Access control | Staff accounts only; no client accounts; role-gated admin functions |
| Multi-factor authentication | TOTP, mandatory — a session is unusable until the second factor is satisfied |
| Encryption in transit | HTTPS at the reverse proxy; router reached over the internal Docker network |
| Encryption at rest | AES-256-GCM on every blob, applied above the storage driver so it holds for local and B2 alike; Postgres on an encrypted volume |
| Access logging | Every route touching taxpayer data writes an audit row: actor, action, entity, IP, timestamp |
| Change logging | Every correction records before, after, actor, and timestamp; the model's original output is never overwritten |
| Retention and disposal | Enforcing job with a documented schedule; derived page images purge earlier than sources; every disposal is logged |
| Least data | TIN stored as a hash plus last four; no client master; no data collected beyond what the documents carry |

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
