/**
 * Shared context for worksheet rendering (P12). Both renderers consume the same model and
 * the same context, which is what makes "both formats reconcile to each other and to the
 * UI" checkable rather than hopeful.
 */
export interface WorksheetContext {
  bundleId: string;
  bundleLabel: string;
  generatedAt: Date;
  generatedByName: string;
  documentCount: number;
  taxpayers: { displayName: string | null; tinLast4: string }[];
  /** documentId → human label, e.g. "W-2 — ACME CORP (p. 3)". */
  documentLabels: Map<string, string>;
  softAnnotations: { checkKey: string; message: string }[];
}
