/**
 * Turning bound values into stored fields (P8).
 *
 * This module is where two of the project's hard rules are actually enforced:
 *
 *  - **No plaintext TIN reaches the database (§7).** A field the registry marked
 *    `sensitive: 'tin'` is handed to identity resolution and then dropped. It is never
 *    written to `extracted_fields`, and the caller gets it back separately, in memory only.
 *  - **Blank is not zero (§5).** `null` is stored for an empty box; `0` only when the form
 *    printed a zero. There is no default anywhere in this path.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { extractedFields } from '../db/schema.ts';
import { parseMoney } from '../lib/money.ts';
import type { FormSchema } from '../schemas/registry.ts';
import type { BindResult, BoundValue } from './binder.ts';

export interface PersistResult {
  written: number;
  flaggedForReview: number;
  /** Plaintext TINs, in memory only, for identity resolution to hash. Never persisted. */
  sensitiveValues: Map<string, string>;
  unparseable: string[];
}

function toBool(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (['x', 'yes', 'true', 'checked', '✓', '✔', '☑', '☒', 'on', '1'].includes(s)) return true;
  if (['', 'no', 'false', 'unchecked', 'off', '☐', 'n/a', '0'].includes(s)) return false;
  return null;
}

export async function persistBoundFields(
  documentId: string,
  schema: FormSchema,
  result: BindResult,
): Promise<PersistResult> {
  const sensitiveValues = new Map<string, string>();
  const unparseable: string[] = [];
  const rows: (typeof extractedFields.$inferInsert)[] = [];

  for (const field of schema.fields) {
    const bound: BoundValue | undefined = result.values.get(field.key);
    if (!bound) continue;

    // §7: consumed in memory, never stored.
    if (field.sensitive === 'tin') {
      if (bound.raw) sensitiveValues.set(field.key, bound.raw);
      continue;
    }

    const disagreed = result.disagreements.has(field.key);
    const mismatched = result.mismatches.has(field.key);
    const hasSpans = bound.spanIds.length > 0;
    const isBlank = bound.raw === null || bound.raw.trim() === '';

    let valueCents: number | null = null;
    let valueText: string | null = null;
    let valueBool: boolean | null = null;
    let parseFailed = false;

    if (!isBlank) {
      if (field.type === 'money') {
        const parsed = parseMoney(bound.raw);
        if (!/\d/.test(bound.raw!)) {
          /**
           * "$", "-", "—": the pre-printed currency sign or a dash the model copied out of an
           * empty box. No digit means no amount; the box is blank (§5). Not a review item —
           * the read is correct, only its spelling was not.
           */
        } else if (parsed.kind === 'amount' && parsed.cents === 0 && !hasSpans) {
          /**
           * A zero with nothing to cite is the model's rendering of an empty box (IRS forms
           * pre-print a "$" in every money box). A *printed* zero has a span — "0.00" or
           * "-0-" — and the binder is told to cite it; without one there is no evidence of
           * a zero, and §5's rule is that blank is the default and zero must be shown. Stored
           * blank, not flagged: a reviewer prompted on every empty box stops reading prompts.
           */
        } else if (parsed.kind === 'amount') valueCents = parsed.cents;
        else if (parsed.kind === 'unparseable') {
          parseFailed = true;
          valueText = bound.raw;
          unparseable.push(field.key);
        }
      } else if (field.type === 'bool') {
        valueBool = toBool(bound.raw!);
        if (valueBool === null) {
          parseFailed = true;
          valueText = bound.raw;
        }
      } else {
        valueText = bound.raw;
      }
    }

    /**
     * An unchecked checkbox is `false` and has nothing on the page to cite — the absence of
     * a mark is not a span. It is stored, it is not a review item, and it is not an orphan
     * under §4. A checked box must still cite the mark or its label.
     */
    const uncheckedBox = field.type === 'bool' && valueBool === false;
    const populated = (valueCents !== null || valueText !== null || valueBool !== null) && !uncheckedBox;

    // §4: no span means review, regardless of confidence. A value the cited spans do not
    // contain is a misread and is flagged before anything softer. Also flag a value we
    // could not parse, and anything the passes disagreed on.
    const needsReview = (populated && !hasSpans) || (populated && mismatched) || disagreed || parseFailed;
    const reviewReason = !hasSpans && populated
      ? ('no_span' as const)
      : populated && mismatched
        ? ('span_mismatch' as const)
        : disagreed
          ? ('pass_disagreement' as const)
          : parseFailed
            ? ('unmapped' as const)
            : null;

    rows.push({
      documentId,
      fieldKey: field.key,
      valueCents,
      valueText,
      valueBool,
      spanIds: bound.spanIds,
      pageId: bound.pageId,
      passCount: result.passCount,
      passAgreement: disagreed ? 0 : 1,
      disagreed,
      needsReview,
      reviewReason,
      producedByModel: result.model,
      routerRequestId: result.requestId,
    });
  }

  if (rows.length) {
    await db
      .insert(extractedFields)
      .values(rows)
      .onConflictDoUpdate({
        target: [extractedFields.documentId, extractedFields.fieldKey],
        set: {
          valueCents: sql`excluded.value_cents`,
          valueText: sql`excluded.value_text`,
          valueBool: sql`excluded.value_bool`,
          spanIds: sql`excluded.span_ids`,
          needsReview: sql`excluded.needs_review`,
          reviewReason: sql`excluded.review_reason`,
          passCount: sql`excluded.pass_count`,
          disagreed: sql`excluded.disagreed`,
          updatedAt: new Date(),
        },
      });
  }

  return {
    written: rows.length,
    flaggedForReview: rows.filter((r) => r.needsReview).length,
    sensitiveValues,
    unparseable,
  };
}
