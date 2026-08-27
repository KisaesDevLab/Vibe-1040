/**
 * Worksheet generation (P12) — the only path that produces worksheet artifacts.
 *
 * Every route into this module goes through `assertWorksheetAllowed` first. That is P9's
 * exit criterion ("the gate cannot be bypassed by any code path") expressed as structure:
 * there is one door, and the gate is nailed to it.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { audit } from '../audit/log.ts';
import { db } from '../db/client.ts';
import { bundleTaxpayers, bundles, documents, taxpayers, worksheetContributions, worksheetLines, worksheets } from '../db/schema.ts';
import { buildWorksheetModel, type MappedDocument, type WorksheetModel } from '../mapping/engine.ts';
import { resolveDocumentFields } from '../extract/resolve.ts';
import { assertWorksheetAllowed, softAnnotations } from '../reconcile/gate.ts';
import { registry } from '../schemas/registry.ts';
import { blobs, keys } from '../storage/index.ts';
import type { WorksheetContext } from './model.ts';
import { buildPdf } from './pdf.ts';
import { buildXlsx } from './xlsx.ts';

export interface GenerateResult {
  worksheetId: string;
  model: WorksheetModel;
  xlsxKey: string;
  pdfKey: string;
}

/** Assemble the model without rendering — used by the UI's live preview (P11). */
export async function buildModelForBundle(bundleId: string): Promise<{
  model: WorksheetModel;
  ctx: Omit<WorksheetContext, 'generatedByName' | 'generatedAt'>;
}> {
  const [bundle] = await db.select().from(bundles).where(eq(bundles.id, bundleId)).limit(1);
  if (!bundle) throw new Error(`no such bundle: ${bundleId}`);
  if (bundle.taxYear === null) throw new Error(`bundle ${bundleId} has no confirmed tax year`);

  const forms = await registry();
  const docRows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.bundleId, bundleId), isNull(documents.parentDocumentId)));

  // Sub-forms of a consolidated package roll up individually; the container itself
  // contributes only its summary, which the mapping marks informational.
  const allDocs = await db.select().from(documents).where(eq(documents.bundleId, bundleId));

  const mapped: MappedDocument[] = [];
  const documentLabels = new Map<string, string>();

  for (const doc of allDocs) {
    if (!doc.formType || doc.void) continue;
    const resolved = await registryResolve(forms, doc.formType, doc.taxYear ?? bundle.taxYear);
    if (!resolved) continue;

    const fields = await resolveDocumentFields(doc.id);
    mapped.push({
      documentId: doc.id,
      formType: doc.formType,
      taxYear: doc.taxYear ?? bundle.taxYear,
      schema: resolved,
      fields: fields.fields,
      correctedFieldKeys: fields.correctedFieldKeys,
    });
    documentLabels.set(
      doc.id,
      `${doc.formType}${doc.payerName ? ` — ${doc.payerName}` : ''}${doc.corrected ? ' [CORRECTED]' : ''}`,
    );
  }

  const model = await buildWorksheetModel(bundle.taxYear, mapped);

  const people = await db
    .select({ displayName: taxpayers.displayName, tinLast4: taxpayers.tinLast4 })
    .from(bundleTaxpayers)
    .innerJoin(taxpayers, eq(taxpayers.id, bundleTaxpayers.taxpayerId))
    .where(eq(bundleTaxpayers.bundleId, bundleId));

  return {
    model,
    ctx: {
      bundleId,
      bundleLabel: bundle.label,
      documentCount: docRows.length,
      taxpayers: people,
      documentLabels,
      softAnnotations: await softAnnotations(bundleId),
    },
  };
}

async function registryResolve(
  forms: Awaited<ReturnType<typeof registry>>,
  formType: string,
  taxYear: number,
) {
  return forms.resolve(formType, taxYear)?.schema;
}

export async function generateWorksheet(
  bundleId: string,
  user: { id: string; displayName: string },
): Promise<GenerateResult> {
  // The gate. Nothing below runs for a bundle with an undispositioned hard failure.
  await assertWorksheetAllowed(bundleId);

  const { model, ctx } = await buildModelForBundle(bundleId);
  const fullCtx: WorksheetContext = {
    ...ctx,
    generatedAt: new Date(),
    generatedByName: user.displayName,
  };

  const [worksheet] = await db
    .insert(worksheets)
    .values({
      bundleId,
      taxYear: model.taxYear,
      mappingVersion: model.mappingVersion,
      generatedBy: user.id,
    })
    .returning({ id: worksheets.id });
  const worksheetId = worksheet!.id;

  for (const line of model.lines) {
    const [lineRow] = await db
      .insert(worksheetLines)
      .values({
        worksheetId,
        lineRef: line.lineRef,
        lineLabel: line.label,
        sortOrder: line.sortOrder,
        totalCents: line.totalCents,
        nullContributorCount: line.nullContributorCount,
        contributorCount: line.contributorCount,
        isJudgmentRequired: line.isJudgmentRequired,
      })
      .returning({ id: worksheetLines.id });

    if (line.contributions.length) {
      await db.insert(worksheetContributions).values(
        line.contributions.map((c) => ({
          worksheetLineId: lineRow!.id,
          documentId: c.documentId,
          fieldKey: c.fieldKey,
          valueCents: c.valueCents,
          wasCorrected: c.wasCorrected,
          judgmentReason: c.judgmentReason ?? null,
        })),
      );
    }
  }

  const [xlsx, pdf] = await Promise.all([buildXlsx(model, fullCtx), buildPdf(model, fullCtx)]);
  const xlsxKey = keys.worksheetXlsx(bundleId, worksheetId);
  const pdfKey = keys.worksheetPdf(bundleId, worksheetId);
  await blobs.put(xlsxKey, xlsx);
  await blobs.put(pdfKey, pdf);

  await db
    .update(worksheets)
    .set({ xlsxStorageKey: xlsxKey, pdfStorageKey: pdfKey })
    .where(eq(worksheets.id, worksheetId));

  await db.update(bundles).set({ status: 'ready', updatedAt: new Date() }).where(eq(bundles.id, bundleId));

  await audit({
    action: 'worksheet.generate',
    userId: user.id,
    bundleId,
    entityType: 'worksheet',
    entityId: worksheetId,
    detail: { taxYear: model.taxYear, mappingVersion: model.mappingVersion, lines: model.lines.length },
  });

  return { worksheetId, model, xlsxKey, pdfKey };
}
