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

export const APP_NAME = 'vibe-1040';

export const TASK_CLASS = {
  /** P4 — page-level form-type classification. */
  PAGE_CLASSIFY: 'v1040_page_classify',
  /** P7 — layout pass. Spans with page-relative geometry; the provenance substrate. */
  LAYOUT: 'v1040_layout',
  /** P8 — binds registered schema fields to span ids. */
  FIELD_EXTRACT: 'v1040_field_extract',
} as const;

export type TaskClassKey = (typeof TASK_CLASS)[keyof typeof TASK_CLASS];

export const DECLARATIONS: TaskClassDeclaration[] = [
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
    description: 'Bind tax-form schema fields to layout span ids',
    requires: { json_schema: true },
    defaultMaxTokens: 4096,
  },
];
