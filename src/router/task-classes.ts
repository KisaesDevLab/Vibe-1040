/**
 * The task classes this app declares (P3, resolved Q2).
 *
 * Keys follow the router's `<app>_<purpose>` convention. There is no inherited
 * `document.classify` and there are no dotted names — those were never how the router
 * names things.
 *
 * Registration is idempotent and version-stamped. A class the router has never seen is
 * created **local_only regardless of what we ask for**; widening is a deliberate,
 * audited firm-admin action that this app cannot perform for itself.
 */
import type { TaskClassDeclaration } from '@kisaes/vibe-ai-client';

import { startupSettings } from '../settings/runtime.ts';

export const APP_NAME = 'vibe-1040';

export const TASK_CLASS = {
  /** P4 — page-level form-type classification. */
  PAGE_CLASSIFY: 'v1040_page_classify',
  /** P7 — layout pass. Spans with page-relative geometry; the provenance substrate. */
  LAYOUT: 'v1040_layout',
  /** P8 — binds registered schema fields to span ids. */
  FIELD_EXTRACT: 'v1040_field_extract',
  /**
   * Optional. Transcribes a page image that has no text layer.
   *
   * Requires `vision` and deliberately **not** `json_schema`. That is the whole reason this
   * class exists separately: the router pins the `local_ocr` kind to `json_schema: false`,
   * so a class demanding a schema can never bind to a local OCR server. The router's own
   * note explains why the ceiling is there — a grammar constraint forces a small OCR model
   * to invent a spans array rather than refuse, which produced confident garbage. So this
   * class asks for prose and the app parses it.
   *
   * Registered only when `OCR_FALLBACK_ENABLED` is on, because a class nobody calls is
   * clutter in the router console.
   */
  OCR_TRANSCRIBE: 'v1040_ocr_transcribe',
} as const;

export type TaskClassKey = (typeof TASK_CLASS)[keyof typeof TASK_CLASS];

/**
 * Classes this app has an opinion about the sensitivity of.
 *
 * `OCR_TRANSCRIBE` is deliberately absent. The other three are vision or text classes the
 * firm runs in the cloud, so `ROUTER_EXPECTED_SENSITIVITY` is a meaningful expectation and a
 * mismatch is worth a warning. For transcription there is no right answer for this app to
 * hold: a firm may bind it to a local OCR server so no page image ever leaves the appliance,
 * or to a cloud vision model for accuracy. Both are legitimate, the trade is the firm's to
 * make, and the startup log reports which way it resolved rather than complaining about it.
 */
export const SENSITIVITY_CHECKED: readonly string[] = [
  TASK_CLASS.PAGE_CLASSIFY,
  TASK_CLASS.LAYOUT,
  TASK_CLASS.FIELD_EXTRACT,
];

/**
 * The classes this app registers, as a **function** rather than a constant.
 *
 * It has to be called rather than read because `v1040_field_extract`'s shape depends on
 * `extraction.attach_page_image`, which is now a setting: with the page image attached the class
 * requires `vision`, so policy refuses a text-only binding instead of a model silently ignoring
 * the image. A module-level constant would have been evaluated at import time — before boot read
 * the setting at all — so this was a `throw` on startup until it became a function.
 */
export function declarations(): TaskClassDeclaration[] {
  return [
  {
    key: TASK_CLASS.PAGE_CLASSIFY,
    description: 'Classify a rasterized page as a 1040 source form type',
    requires: { vision: true, json_schema: true },
    defaultMaxTokens: 512,
  },
  {
    key: TASK_CLASS.LAYOUT,
    description: 'Document-OCR layout pass: text spans with page-relative geometry',
    requires: { vision: true, json_schema: true },
    // A dense consolidated 1099 page carries a lot of spans. Undersizing this is how a
    // layout pass silently truncates and takes its provenance with it. The router re-reads
    // this value on every registration, so raising it here is sufficient; an operator can
    // clamp it down per deployment via the policy's maxTokensOverride.
    defaultMaxTokens: 16384,
  },
  {
    key: TASK_CLASS.FIELD_EXTRACT,
    description: startupSettings().attachPageImage
      ? 'Bind tax-form schema fields to layout span ids, reading the page image alongside'
      : 'Bind tax-form schema fields to positioned layout spans',
    // With the page image attached the binder needs a vision model; the requirement is
    // declared so policy refuses a text-only binding instead of the model silently ignoring
    // the image. Registration re-reads this on every start.
    requires: startupSettings().attachPageImage ? { vision: true, json_schema: true } : { json_schema: true },
    // 4096 truncated ten binding responses in the first week (router ledger, 2026-09-17): a
    // consolidated package's field list plus a verbose model overran it.
    defaultMaxTokens: 8192,
  },
  ];
}

/** Appended to `declarations()` only when the OCR fallback is enabled. */
export const OPTIONAL_DECLARATIONS: TaskClassDeclaration[] = [
  {
    key: TASK_CLASS.OCR_TRANSCRIBE,
    description: 'Transcribe a page image that carries no text layer. Prose out, no schema',
    requires: { vision: true },
    // A dense scanned page of prose. Smaller than the layout budget because there is no
    // span structure to emit, larger than classification because this returns the page.
    defaultMaxTokens: 8192,
  },
];
