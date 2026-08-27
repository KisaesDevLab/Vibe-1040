/**
 * Resolving a document's field values (P11).
 *
 * Corrections **layer over** model output rather than replacing it (§P11). The
 * `extracted_fields` row keeps exactly what the model produced, forever; the latest
 * non-superseded `field_corrections` row wins at read time. That is what makes "the
 * original model output remains recoverable after correction" true by construction rather
 * than by discipline.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { extractedFields, fieldCorrections } from '../db/schema.ts';
import type { FieldValue } from '../reconcile/checks.ts';

export interface ResolvedField extends FieldValue {
  fieldKey: string;
  fieldId: string;
  pageId: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  disagreed: boolean;
  wasCorrected: boolean;
  /** What the model said, kept alongside the effective value for the review UI. */
  original: { cents: number | null; text: string | null; bool: boolean | null };
}

export interface ResolvedDocument {
  documentId: string;
  fields: Map<string, ResolvedField>;
  correctedFieldKeys: Set<string>;
}

export async function resolveDocumentFields(documentId: string): Promise<ResolvedDocument> {
  const rows = await db
    .select()
    .from(extractedFields)
    .where(eq(extractedFields.documentId, documentId))
    .orderBy(asc(extractedFields.fieldKey));

  const fields = new Map<string, ResolvedField>();
  const correctedFieldKeys = new Set<string>();

  for (const row of rows) {
    const [correction] = await db
      .select()
      .from(fieldCorrections)
      .where(and(eq(fieldCorrections.fieldId, row.id), isNull(fieldCorrections.supersededAt)))
      .orderBy(desc(fieldCorrections.createdAt))
      .limit(1);

    const original = { cents: row.valueCents, text: row.valueText, bool: row.valueBool };

    let cents = row.valueCents;
    let text = row.valueText;
    let bool = row.valueBool;

    if (correction) {
      correctedFieldKeys.add(row.fieldKey);
      if (correction.setToNull) {
        // A reviewer can legitimately correct a misread value back to blank — that is not
        // the same as "no correction", which is why setToNull is explicit.
        cents = null;
        text = null;
        bool = null;
      } else {
        cents = correction.valueCents;
        text = correction.valueText;
        bool = correction.valueBool;
      }
    }

    const present = cents !== null || text !== null || bool !== null;

    fields.set(row.fieldKey, {
      fieldKey: row.fieldKey,
      fieldId: row.id,
      cents,
      text,
      bool,
      present,
      spanIds: row.spanIds,
      pageId: row.pageId,
      needsReview: row.needsReview,
      reviewReason: row.reviewReason,
      disagreed: row.disagreed,
      wasCorrected: correction !== undefined,
      original,
    });
  }

  return { documentId, fields, correctedFieldKeys };
}

/** Record a correction. Never mutates the model's row. */
export async function correctField(
  fieldId: string,
  userId: string,
  next: {
    cents?: number | null | undefined;
    text?: string | null | undefined;
    bool?: boolean | null | undefined;
    setToNull?: boolean | undefined;
  },
  note?: string,
): Promise<{ correctionId: string; before: ResolvedField['original'] }> {
  const [row] = await db.select().from(extractedFields).where(eq(extractedFields.id, fieldId)).limit(1);
  if (!row) throw new Error(`no such field: ${fieldId}`);

  // Supersede any prior correction so history is a chain rather than a set of rivals.
  await db
    .update(fieldCorrections)
    .set({ supersededAt: new Date() })
    .where(and(eq(fieldCorrections.fieldId, fieldId), isNull(fieldCorrections.supersededAt)));

  const [inserted] = await db
    .insert(fieldCorrections)
    .values({
      fieldId,
      valueCents: next.setToNull ? null : (next.cents ?? null),
      valueText: next.setToNull ? null : (next.text ?? null),
      valueBool: next.setToNull ? null : (next.bool ?? null),
      setToNull: next.setToNull ?? false,
      correctedBy: userId,
      note: note ?? null,
    })
    .returning({ id: fieldCorrections.id });

  // A corrected field has been looked at by a human; it no longer needs review.
  await db
    .update(extractedFields)
    .set({ needsReview: false, updatedAt: new Date() })
    .where(eq(extractedFields.id, fieldId));

  return {
    correctionId: inserted!.id,
    before: { cents: row.valueCents, text: row.valueText, bool: row.valueBool },
  };
}
