/**
 * Return order for documents (added 2026-09-16).
 *
 * A preparer reads a packet the way the return is laid out: wages, interest, dividends,
 * retirement, Social Security, capital gains, and on down through the schedules. The
 * document list, the workbook's Documents and recap sheets, and the bookmarked sorted PDF
 * all follow one ordering, loaded from `data/form-order.json` so moving a form between
 * groups is a data change.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const orderFile = z
  .object({
    version: z.string(),
    notes: z.array(z.string()).default([]),
    groups: z.array(
      z.object({ label: z.string(), line: z.string().optional(), forms: z.array(z.string()).min(1) }).strict(),
    ),
  })
  .strict();

export type FormOrder = z.infer<typeof orderFile>;

export const OTHER_FORMS_GROUP = 'Other forms';
export const OTHER_PAGES_GROUP = 'Other pages';

let cached: FormOrder | null = null;

export function loadFormOrder(root = join(process.cwd(), 'data')): FormOrder {
  cached ??= orderFile.parse(JSON.parse(readFileSync(join(root, 'form-order.json'), 'utf8')));
  return cached;
}

/** Test seam. */
export function __setFormOrder(order: FormOrder | null): void {
  cached = order;
}

export interface Orderable {
  formType: string | null;
  isSupplemental?: boolean;
  payerName?: string | null;
  sectionCode?: string | null;
  createdAt?: Date | string | null;
}

export interface Placement {
  /** 0-based group index; unlisted forms come after the last group, non-forms after those. */
  groupIndex: number;
  groupLabel: string;
  /** Position within the group's form list. */
  formIndex: number;
}

export function placementOf(doc: Orderable, order: FormOrder = loadFormOrder()): Placement {
  if (!doc.formType || doc.isSupplemental) {
    return { groupIndex: order.groups.length + 1, groupLabel: OTHER_PAGES_GROUP, formIndex: 0 };
  }
  for (const [g, group] of order.groups.entries()) {
    const f = group.forms.indexOf(doc.formType);
    if (f >= 0) return { groupIndex: g, groupLabel: group.label, formIndex: f };
  }
  return { groupIndex: order.groups.length, groupLabel: OTHER_FORMS_GROUP, formIndex: 0 };
}

const text = (v: string | null | undefined): string => (v ?? '').toUpperCase();
const time = (v: Date | string | null | undefined): number => (v ? new Date(v).getTime() : 0);

/** Compare two documents in return order; stable on original order for ties. */
export function compareDocuments(a: Orderable, b: Orderable, order: FormOrder = loadFormOrder()): number {
  const pa = placementOf(a, order);
  const pb = placementOf(b, order);
  return (
    pa.groupIndex - pb.groupIndex ||
    pa.formIndex - pb.formIndex ||
    text(a.formType).localeCompare(text(b.formType)) ||
    text(a.payerName).localeCompare(text(b.payerName)) ||
    text(a.sectionCode).localeCompare(text(b.sectionCode)) ||
    time(a.createdAt) - time(b.createdAt)
  );
}

export function sortDocuments<T extends Orderable>(docs: readonly T[], order: FormOrder = loadFormOrder()): T[] {
  return [...docs].sort((a, b) => compareDocuments(a, b, order));
}

/** Rank of a form type alone, for ordering the workbook's per-form sheets. */
export function compareFormTypes(a: string, b: string, order: FormOrder = loadFormOrder()): number {
  return compareDocuments({ formType: a }, { formType: b }, order);
}
