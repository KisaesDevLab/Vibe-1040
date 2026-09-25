/**
 * Producing a draft return (P17 stage 2).
 *
 * One door, and the gate is nailed to it — the same structure P12 uses for the worksheet.
 * `assertWorksheetAllowed` runs first, so a bundle with an undispositioned hard failure gets
 * no draft return either. There is deliberately no `force` flag.
 *
 * Nothing here runs automatically. A draft return is an explicit, audited action; the pipeline
 * never computes one, because inference is not the cost — a number nobody asked for, presented
 * beside numbers a preparer trusts, is.
 */
import { and, desc, eq } from 'drizzle-orm';
import { audit } from '../audit/log.ts';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import {
  draftReturnLines,
  draftReturnOmissions,
  draftReturnValidations,
  draftReturns,
} from '../db/schema.ts';
import { buildWorksheetModel } from '../mapping/engine.ts';
import { assertWorksheetAllowed } from '../reconcile/gate.ts';
import { setting } from '../settings/store.ts';
import { loadMappedDocuments } from '../worksheet/generate.ts';
import { computeReturn, DraftEngineError, engineHealth, type EngineResult } from './client.ts';
import { compareDraft, type DraftComparison } from './compare.ts';
import { loadNodeMap } from './nodes.ts';
import { buildDraftInput, type DraftOmission, type DraftParams } from './translate.ts';

/** Raised when the draft return is not switched on for this deployment. */
export class DraftReturnDisabledError extends Error {
  constructor() {
    super(
      'the draft return is not enabled for this deployment. It is an environment key ' +
        '(DRAFT_RETURN_ENABLED) because it changes what the app computes about a taxpayer, and ' +
        'it must stay off wherever there is live client data until QUESTIONS.md Q21 is answered.',
    );
    this.name = 'DraftReturnDisabledError';
  }
}

export interface DraftReturnResult {
  draftReturnId: string;
  taxYear: number;
  engineVersion: string;
  nodeMapVersion: string;
  complete: boolean;
  documentsIncluded: number;
  documentsWithheld: number;
  comparison: DraftComparison;
  omissions: DraftOmission[];
  validation: EngineResult['validation'];
  engineSummary: Record<string, number>;
}

export async function generateDraftReturn(
  bundleId: string,
  userId: string,
  params: DraftParams = {},
): Promise<DraftReturnResult> {
  if (!env.DRAFT_RETURN_ENABLED) throw new DraftReturnDisabledError();

  // Same gate, same order, no bypass.
  await assertWorksheetAllowed(bundleId);

  const { taxYear, mapped } = await loadMappedDocuments(bundleId);
  const file = await loadNodeMap(taxYear);
  const input = buildDraftInput(file, mapped, params);

  // The worksheet's own totals, built from the same documents through the same loader, so a
  // disagreement can only be the mapping or the engine — never a different set of documents.
  const worksheet = await buildWorksheetModel(taxYear, mapped);

  const result = await computeReturn(taxYear, input.nodes);

  if (result.engineVersion !== env.OPENTAX_VERSION && result.engineVersion !== 'unknown') {
    // Not fatal, but never silent: a node map that drifts under the engine produces plausible
    // wrong numbers, which is the one outcome worth shouting about.
    console.warn(
      `[draft] engine reports ${result.engineVersion} but OPENTAX_VERSION is ` +
        `${env.OPENTAX_VERSION}; the ${file.version} node map was written against the latter. ` +
        'Re-check the map before trusting these figures.',
    );
  }

  // The firm's own rounding tolerance (§6), not a second one invented here.
  const tolerance = await setting<number>('reconcile.tolerance_cents');
  const comparison = compareDraft(file, worksheet, result, tolerance);

  // A node the engine refused is an omission too, and belongs in the same list — the reviewer
  // should not have to read two places to learn what is missing.
  const omissions: DraftOmission[] = [
    ...input.omissions,
    ...result.rejected.map((r) => ({
      documentId: r.documentId,
      formType: null,
      fieldKey: null,
      reason: 'engine_rejected' as DraftOmission['reason'],
      detail: `The engine refused the ${r.nodeType} node: ${r.message}`,
    })),
  ];
  const complete = omissions.length === 0;

  const [row] = await db
    .insert(draftReturns)
    .values({
      bundleId,
      taxYear,
      engineVersion: result.engineVersion,
      nodeMapVersion: file.version,
      mappingVersion: worksheet.mappingVersion,
      filingStatus: params.filingStatus ?? null,
      complete,
      documentsIncluded: input.documentsIncluded,
      documentsWithheld: input.documentsWithheld,
      engineSummary: result.summary,
      generatedBy: userId,
    })
    .returning({ id: draftReturns.id });
  if (!row) throw new Error('failed to insert the draft return row');
  const draftReturnId = row.id;

  const lineRows = [
    ...comparison.lines.map((l) => ({
      draftReturnId,
      lineRef: l.lineRef,
      lineLabel: l.label,
      sortOrder: l.sortOrder,
      engineForm: l.engineForm,
      engineLine: l.engineLine,
      reportedCents: l.reportedCents,
      computedCents: l.computedCents,
      verdict: l.verdict,
      note: l.note ?? null,
    })),
    ...comparison.computedOnly.map((c, i) => ({
      draftReturnId,
      lineRef: null,
      lineLabel: c.label,
      // After every compared line, in the order the map declares them.
      sortOrder: 100_000 + i,
      engineForm: c.engineForm,
      engineLine: c.engineLine,
      reportedCents: null,
      computedCents: c.computedCents,
      verdict: 'computed_only',
      note: null,
    })),
  ];
  if (lineRows.length > 0) await db.insert(draftReturnLines).values(lineRows);

  if (omissions.length > 0) {
    await db.insert(draftReturnOmissions).values(
      omissions.map((o) => ({
        draftReturnId,
        documentId: o.documentId,
        formType: o.formType,
        fieldKey: o.fieldKey,
        reason: o.reason,
        detail: o.detail,
      })),
    );
  }

  const diagnostics = [
    ...result.validation.hard.map((d) => ({ severity: 'hard', ...d })),
    ...result.validation.soft.map((d) => ({ severity: 'soft', ...d })),
  ];
  if (diagnostics.length > 0) {
    await db
      .insert(draftReturnValidations)
      .values(diagnostics.map((d) => ({ draftReturnId, severity: d.severity, code: d.code, message: d.message })));
  }

  await audit({
    userId,
    action: 'draft.generate',
    bundleId,
    entityType: 'draft_return',
    entityId: draftReturnId,
    detail: {
      engineVersion: result.engineVersion,
      nodeMapVersion: file.version,
      complete,
      documentsIncluded: input.documentsIncluded,
      documentsWithheld: input.documentsWithheld,
      differing: comparison.differing.length,
      omissions: omissions.length,
    },
  });

  return {
    draftReturnId,
    taxYear,
    engineVersion: result.engineVersion,
    nodeMapVersion: file.version,
    complete,
    documentsIncluded: input.documentsIncluded,
    documentsWithheld: input.documentsWithheld,
    comparison,
    omissions,
    validation: result.validation,
    engineSummary: result.summary,
  };
}

/** The most recent draft return for a bundle, as stored. */
export async function latestDraftReturn(bundleId: string): Promise<{
  draftReturn: typeof draftReturns.$inferSelect;
  lines: (typeof draftReturnLines.$inferSelect)[];
  omissions: (typeof draftReturnOmissions.$inferSelect)[];
  validations: (typeof draftReturnValidations.$inferSelect)[];
} | null> {
  const [row] = await db
    .select()
    .from(draftReturns)
    .where(eq(draftReturns.bundleId, bundleId))
    .orderBy(desc(draftReturns.createdAt))
    .limit(1);
  if (!row) return null;

  const [lines, omissions, validations] = await Promise.all([
    db.select().from(draftReturnLines).where(eq(draftReturnLines.draftReturnId, row.id)),
    db.select().from(draftReturnOmissions).where(eq(draftReturnOmissions.draftReturnId, row.id)),
    db.select().from(draftReturnValidations).where(eq(draftReturnValidations.draftReturnId, row.id)),
  ]);

  lines.sort((a, b) => a.sortOrder - b.sortOrder);
  return { draftReturn: row, lines, omissions, validations };
}

/**
 * Whether the draft return is available, for `/health` and for the UI.
 *
 * Reports rather than throws: an unreachable optional engine is a degraded state, not an
 * outage, and the same reasoning as router-down parking applies (§3).
 */
export async function draftReturnStatus(): Promise<{
  enabled: boolean;
  engine: Awaited<ReturnType<typeof engineHealth>> | null;
  expectedVersion: string;
}> {
  if (!env.DRAFT_RETURN_ENABLED) {
    return { enabled: false, engine: null, expectedVersion: env.OPENTAX_VERSION };
  }
  return { enabled: true, engine: await engineHealth(), expectedVersion: env.OPENTAX_VERSION };
}

export { DraftEngineError };
