# Vibe AI Router — PHASES addendum: multimodal and document task classes

> **⚠️ SUPERSEDED — 2026-08-26. Do not plan from this document.**
>
> Written against assumptions about the Router that were checked for the first time on
> 2026-08-26 against **Vibe-AI-Router v0.0.24**. Most of it was already wrong:
>
> | | Status |
> |---|---|
> | R1 — multimodal envelope | **already shipped** — `gateway/envelope.ts:122` |
> | R2 — capability matrix | **already shipped** — `catalog/service.ts`, live probing in `catalog/probe.ts` |
> | R3 — document task classes | **not Router work** — apps self-register their own; keys are `<app>_<purpose>`, never dotted |
> | R4 — body size limits | **not needed** — `ROUTER_MAX_BODY_BYTES` already defaults to 10 MiB |
> | R5 — US-region pinning | **still real, still absent.** The one genuine dependency. Gates P14 |
>
> STATE.md's External dependencies table is the current authority. The Router's own
> `docs/integration.md` is the frozen contract. R5 below is still worth reading; the rest is
> kept only as a record of what was assumed.

Addendum to the existing 15-phase Router plan. Five phases, R1–R5, adding the multimodal
capability that Vibe 1040 depends on. Numbered separately so they slot after whatever the
Router's current phase position is.

**Why this is its own phase block:** the existing `document.classify` class was built for
T&B document naming and almost certainly never forced a multimodal request envelope. If
that is right, this is not a small patch — the request schema, the provider adapters, the
policy engine's routing decisions, and the body-size limits all change together. Vibe 1040
is untestable past its P6 until R1–R3 land, so discovering this mid-build would stall both
repos.

---

## R1 — Multimodal request envelope

**Depends on:** nothing in this block.

The request schema accepts an ordered array of content blocks rather than a prompt string.
Text blocks and image blocks. Image blocks carry base64 data plus a declared media type,
constrained to PNG, JPEG, and WEBP.

Provider adapters translate the envelope to each provider's native shape and pass image
content through untouched. Verify the DigitalOcean Gradient adapter emits the
OpenAI-compatible `image_url` content block with a base64 data URI, and that the local
vibellm adapter reaches the PaddleOCR-VL endpoint correctly.

**Explicitly out of scope:** URL-based image references. The Router accepts inline base64
only. Accepting a URL would mean a provider reaching back into a caller's storage, which
is the exact pattern Vibe 1040 rejected for compliance reasons, and the Router should not
offer a footgun it does not want used.

**Exit:** the same multimodal request routes successfully to both a local vibellm model
and a DigitalOcean serverless multimodal model, with no caller-side branching. Text-only
requests continue to work unchanged — this is additive, and existing task classes must not
regress.

---

## R2 — Provider capability matrix

**Depends on:** R1.

Today the policy engine can route a task class to a provider without knowing whether that
provider can do the job. Once vision task classes exist, that becomes a runtime failure at
the provider rather than a routing decision.

Declare per model: modality support, maximum images per request, resolution ceiling,
maximum request body size, structured-output support, and whether per-token confidence
signals are available in the response.

The policy engine consults the matrix before routing and refuses to route a vision task
class to a text-only model, failing fast with a clear error rather than a provider-side
400 in March.

Expose the resolution ceiling and body limit to callers so a caller like Vibe 1040 can
size its rasterization to the target provider instead of guessing from config.

**Exit:** routing a vision task class against a text-only-configured policy fails at the
Router with an actionable error. A caller can query the effective capability for a task
class and get back the ceiling it should encode to. The matrix is data, not code.

---

## R3 — Document task classes

**Depends on:** R1, R2.

Register two new task classes alongside the existing `document.classify`:

**`document.layout`** — page image in, text spans with page-relative geometry out. Backed
by a document-OCR model that emits coordinates natively. PaddleOCR-VL local, with a
declared cloud fallback. The geometry contract is fixed and versioned: callers store these
spans as a provenance substrate and cannot tolerate coordinate-system drift between
providers. Normalize coordinates at the adapter so every provider returns the same
convention.

**`document.extract.tax_form`** — layout output plus a schema in, bound fields out. Each
emitted field references the span IDs it was bound to. The model is never asked to invent
a coordinate; it selects from spans it was given.

Both default local per the existing local-vibellm-default policy, with cloud opt-in.

If Q2 in the Vibe 1040 repo comes back saying `document.classify` cannot take page images,
add **`document.classify.page`** here as a third class rather than overloading the
existing one — T&B depends on the current behavior.

**Exit:** both classes route, execute, and return their contracted shapes against local
and cloud providers. Span geometry is identical in convention across providers for the
same input. Existing `document.classify` behavior is unchanged.

---

## R4 — Body size and streaming limits

**Depends on:** R1.

Inline base64 page images are roughly 800 KB each for a 300 DPI grayscale letter page.
Default body limits in most HTTP stacks sit well below what a season's traffic needs.

Raise limits deliberately at every hop: the Router's own ingress, any reverse proxy in
front of it, the provider adapters, and the job payload store if requests are queued
rather than handled inline. Add a request-size metric so the ceiling is observable before
it is hit.

Reject oversized requests with a clear error naming the limit, not a generic 413.

**Exit:** a 5 MB multimodal request round-trips end to end. The limit is documented, and
exceeding it produces an actionable error. Request size is visible in metrics.

---

## R5 — US-region pinning and policy reporting

**Depends on:** R2, R3.

Vibe 1040 depends on inference staying inside the US to remain within auxiliary service
provider treatment under Treas. Reg. §301.7216-2(d). That guarantee has to be enforceable
at the Router, since the Router is what actually picks the provider.

Per task class, allow a region constraint in policy. Enforce it at routing time, failing
closed rather than falling back to a non-compliant provider.

Expose a policy-reporting endpoint so a caller can assert at startup that the task classes
it consumes are US-pinned, and refuse to start if not. Vibe 1040's P3 and P14 both depend
on this endpoint existing.

Audit-log every routing decision for these task classes: task class, model, provider,
region, and timestamp. That log is what substantiates the compliance position if anyone
asks.

**Exit:** a task class pinned to US regions cannot be routed to a non-US provider by any
configuration path. The reporting endpoint returns accurate pinning state. Every document
task-class routing decision is audited with region recorded.

---

## Notes carried over from the Vibe 1040 requirements work

- **DigitalOcean's Files API must not be used** for any document task class. It has a
  separate retention model and is not auto-purged. Inline base64 only.
- **Avoid OpenAI models via DigitalOcean serverless** for any task class that carries
  taxpayer data — DigitalOcean's own limits documentation indicates those do not support
  zero data retention. DigitalOcean-hosted models are covered by the no-training,
  no-retention policy; passthrough commercial models may not be.
- **BYOM on Dedicated Inference appears to be text-only** — DigitalOcean's import
  documentation lists only `Qwen2ForCausalLM` and `Qwen3ForCausalLM`, with an architecture
  validation gate rejecting unlisted architectures. Do not plan on importing PaddleOCR-VL
  or dots.ocr to DigitalOcean. Confirm with DigitalOcean before assuming either way. This
  is why the cloud fallback for `document.layout` has to be a catalog multimodal model
  rather than the same OCR model running locally, and why span geometry normalization in
  R3 matters.
- **GPU Droplets bill while powered off.** If the Router ever provisions one for a
  dedicated document model, the lifecycle must destroy rather than stop.
