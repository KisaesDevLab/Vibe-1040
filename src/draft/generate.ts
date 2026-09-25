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
import { engineCatalogCheck, formatFindings, type CatalogCheck } from './catalog.ts';
import { draftInputsForBundle } from './inputs.ts';
import { type FilingStatusOption, loadNodeMap, resolveNodeMap } from './nodes.ts';
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

/**
 * Raised when the node map names fields the running engine does not have.
 *
 * Refusing is proportionate rather than cautious. The failure it prevents is a draft whose
 * numbers are confidently wrong with nothing anywhere saying so — an unknown *optional* field
 * is accepted and ignored by the engine, so the amount vanishes and the line reads as absent
 * (see `src/draft/catalog.ts`). A wrong draft is worse than no draft, and nothing else is
 * withheld: the worksheet, which is the product, does not go through here at all.
 */
export class DraftEngineMismatchError extends Error {
  readonly check: CatalogCheck;

  constructor(check: CatalogCheck) {
    super(
      `the OpenTax node map does not match engine ${check.engineVersion}: ` +
        `${check.blocking.length} blocking mismatch(es). ` +
        formatFindings(check).join(' | '),
    );
    this.name = 'DraftEngineMismatchError';
    this.check = check;
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

  // Before anything is sent: do the names in this map exist on the engine that will receive
  // them? Memoized per engine version and map version, so this is one round trip per process.
  const catalogCheck = await engineCatalogCheck(file);
  if (!catalogCheck.ok) throw new DraftEngineMismatchError(catalogCheck);

  /**
   * What the preparer has stored, with anything passed on this call layered on top (P18).
   *
   * Stored is the source of truth — a preparer does not retype a Schedule C to recompute — but
   * an explicit `params` still wins, so an existing caller that passes a filing status behaves
   * exactly as it did before this feature existed.
   */
  const stored = await draftInputsForBundle(bundleId);
  const effective: DraftParams = {
    ...(stored.filingStatus !== null ? { filingStatus: stored.filingStatus } : {}),
    ...(stored.taxpayerAge65OrOlder !== null ? { taxpayerAge65OrOlder: stored.taxpayerAge65OrOlder } : {}),
    ...(stored.spouseAge65OrOlder !== null ? { spouseAge65OrOlder: stored.spouseAge65OrOlder } : {}),
    ...(stored.taxpayerBlind !== null ? { taxpayerBlind: stored.taxpayerBlind } : {}),
    ...(stored.spouseBlind !== null ? { spouseBlind: stored.spouseBlind } : {}),
    ...(stored.dependents.length > 0 ? { dependents: stored.dependents } : {}),
    ...(stored.scheduleA ? { scheduleA: stored.scheduleA } : {}),
    ...(stored.activities.length > 0 ? { activities: stored.activities } : {}),
    ...params,
  };

  const input = buildDraftInput(file, mapped, effective);

  // The worksheet's own totals, built from the same documents through the same loader, so a
  // disagreement can only be the mapping or the engine — never a different set of documents.
  const worksheet = await buildWorksheetModel(taxYear, mapped);

  const result = await computeReturn(taxYear, input.nodes);

  // Two pins, and they answer different questions: the node map says which engine release it
  // was *written against*, and OPENTAX_VERSION says what this deployment *intends* to run.
  // Either disagreeing with what the engine actually reports means a mapping may have drifted
  // under it, which produces plausible wrong numbers — the one outcome worth shouting about.
  // Not fatal, because a version string is weaker evidence than the harness, but never silent.
  if (result.engineVersion !== 'unknown') {
    // A release tag is `v2.0.4` and the binary reports `2.0.4`; the same version either way.
    const bare = (v: string): string => v.replace(/^v/, '');
    const reported = bare(result.engineVersion);
    const disagrees: string[] = [];
    if (reported !== bare(file.engine.pinnedVersion)) {
      disagrees.push(`the ${file.version} node map was written against ${file.engine.pinnedVersion}`);
    }
    if (reported !== bare(env.OPENTAX_VERSION)) {
      disagrees.push(`OPENTAX_VERSION pins ${env.OPENTAX_VERSION}`);
    }
    if (disagrees.length > 0) {
      console.warn(
        `[draft] the engine reports ${result.engineVersion}, but ${disagrees.join(' and ')}. ` +
          'Re-check the node map and run `npm run draft -- --truth` before trusting these figures.',
      );
    }
  }

  // The firm's own rounding tolerance (§6), not a second one invented here.
  const tolerance = await setting<number>('reconcile.tolerance_cents');
  const comparison = compareDraft(file, worksheet, result, tolerance);

  // An engine line the node map declares nowhere is a figure the engine computed and this app
  // shows no one. It is netted into the totals either way, so the draft looks complete and is
  // quietly missing a line — which is how the child tax credit went unseen when dependents
  // first landed. Loud, and named, because the remedy is a one-line data change: declare it in
  // `lines.computedOnly`, or in `lines.ignoredLines` with a reason a preparer could read.
  if (comparison.undeclaredLines.length > 0) {
    console.warn(
      `[draft] engine ${result.engineVersion} returned ${comparison.undeclaredLines.length} ` +
        `line(s) that data/opentax-nodes/${taxYear}.json declares nowhere, so nothing shows ` +
        `them: ${comparison.undeclaredLines.join(', ')}. See docs/opentax-draft-return.md §7.`,
    );
  }

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
      // The status the run actually used, which is the stored one unless this call overrode
      // it. Recording the per-request value here would leave a draft built from stored inputs
      // claiming no filing status at all.
      filingStatus: effective.filingStatus ?? null,
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
      // Carried, so the caveat is stored beside the figure and reaches the workbook too —
      // §14 requires the omissions and the caveats on the same sheet as the numbers.
      note: c.note ?? null,
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
export async function draftReturnStatus(taxYear?: number): Promise<{
  enabled: boolean;
  engine: Awaited<ReturnType<typeof engineHealth>> | null;
  expectedVersion: string;
  /**
   * The engine's own filing-status vocabulary, served so the UI cannot hardcode codes that
   * differ from the engine's. Hardcoding them once already meant every draft would have been
   * refused at the `general` node.
   */
  filingStatuses: FilingStatusOption[];
  /**
   * Which year's node map the vocabulary came from, and `null` when there is no map at all.
   *
   * Reported rather than swallowed. An empty `filingStatuses` renders a select with no options
   * and a button that can never be pressed, so the panel has to be able to say why instead of
   * offering a dead control — and the cause is a missing data file, which names its own fix.
   */
  filingStatusYear: number | null;
}> {
  // The vocabulary is a property of the engine release, not of the tax year, so the newest map
  // on disk is a correct source for it — which is what `resolveNodeMap` falls back to when the
  // caller names a year with no map, and when it names no year at all. Never
  // `new Date().getFullYear()`: the calendar year is 2026 while the season being prepared is
  // 2025, and asking for 2026 returned nothing at all.
  const resolved = await resolveNodeMap(taxYear ?? Number.NaN);
  const filingStatuses = resolved?.file.filingStatuses ?? [];
  const filingStatusYear = resolved?.year ?? null;
  if (!env.DRAFT_RETURN_ENABLED) {
    return { enabled: false, engine: null, expectedVersion: env.OPENTAX_VERSION, filingStatuses, filingStatusYear };
  }
  return {
    enabled: true,
    engine: await engineHealth(),
    expectedVersion: env.OPENTAX_VERSION,
    filingStatuses,
    filingStatusYear,
  };
}

export interface EngineReadiness {
  enabled: boolean;
  engine: Awaited<ReturnType<typeof engineHealth>>;
  /** What `OPENTAX_VERSION` pins, and what the node map was written against. */
  pins: { environment: string; nodeMap: string | null; nodeMapVersion: string | null };
  /** True when the running binary agrees with both pins. */
  versionsAgree: boolean;
  check: CatalogCheck | null;
  /** Populated when the catalogue could not be read at all. */
  error: string | null;
}

/**
 * The full upgrade-time picture: which engine is running, what the two pins say, and whether
 * the node map's field names still exist on it.
 *
 * Deliberately **not** folded into `draftReturnStatus`, which `/health` and every bundle view
 * call. This reads the engine's catalogue — fifteen child processes on a cold cache — and that
 * does not belong on a liveness path.
 *
 * It reports and changes nothing. Replacing the binary is not something this app does: the
 * version is pinned and checksum-verified at image build precisely so that nothing can swap it
 * at runtime (CLAUDE.md §14), and a click is not an upgrade.
 */
export async function engineReadiness(taxYear?: number): Promise<EngineReadiness> {
  const resolved = await resolveNodeMap(taxYear ?? Number.NaN);
  const pins = {
    environment: env.OPENTAX_VERSION,
    nodeMap: resolved?.file.engine.pinnedVersion ?? null,
    nodeMapVersion: resolved?.file.version ?? null,
  };

  if (!env.DRAFT_RETURN_ENABLED) {
    return {
      enabled: false,
      engine: { ok: false, version: null, reason: 'draft return is not enabled' },
      pins,
      versionsAgree: false,
      check: null,
      error: null,
    };
  }

  const engine = await engineHealth();
  const bare = (v: string | null): string | null => (v === null ? null : v.replace(/^v/, ''));
  const running = bare(engine.version);
  const versionsAgree =
    running !== null && running === bare(pins.environment) && running === bare(pins.nodeMap);

  if (!engine.ok || !resolved) {
    return { enabled: true, engine, pins, versionsAgree, check: null, error: null };
  }

  try {
    return { enabled: true, engine, pins, versionsAgree, check: await engineCatalogCheck(resolved.file), error: null };
  } catch (err) {
    return {
      enabled: true,
      engine,
      pins,
      versionsAgree,
      check: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export { DraftEngineError };
