/**
 * The blocking gate (§6, P9).
 *
 * "A bundle with a hard failure does not produce a worksheet until a human dispositions
 * the failure." That sentence is implemented here, in one place, and every worksheet path
 * must go through `assertWorksheetAllowed`. There is deliberately no `force` parameter and
 * no severity override — P9's exit criterion is that the gate cannot be bypassed by any
 * code path, and an escape hatch would be exactly that path.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { checkResults, dispositions } from '../db/schema.ts';

export class WorksheetBlockedError extends Error {
  readonly bundleId: string;
  readonly blocking: { id: string; checkKey: string; message: string }[];

  constructor(bundleId: string, blocking: { id: string; checkKey: string; message: string }[]) {
    super(
      `bundle ${bundleId} has ${blocking.length} undispositioned hard failure(s): ` +
        blocking.map((b) => b.checkKey).join(', '),
    );
    this.name = 'WorksheetBlockedError';
    this.bundleId = bundleId;
    this.blocking = blocking;
  }
}

/** Hard failures with no disposition row. These are what block. */
export async function blockingFailures(
  bundleId: string,
): Promise<{ id: string; checkKey: string; message: string }[]> {
  const rows = await db
    .select({
      id: checkResults.id,
      checkKey: checkResults.checkKey,
      message: checkResults.message,
      dispositionId: dispositions.id,
    })
    .from(checkResults)
    .leftJoin(dispositions, eq(dispositions.checkResultId, checkResults.id))
    .where(
      and(
        eq(checkResults.bundleId, bundleId),
        eq(checkResults.severity, 'hard'),
        eq(checkResults.outcome, 'fail'),
        isNull(dispositions.id),
      ),
    );

  return rows.map((r) => ({ id: r.id, checkKey: r.checkKey, message: r.message }));
}

/**
 * Call before generating any worksheet artifact. Throws if the bundle is blocked.
 *
 * Not a boolean-returning helper on purpose: a caller who forgets to check a boolean gets
 * a worksheet, whereas a caller who forgets to await this gets an unhandled rejection.
 */
export async function assertWorksheetAllowed(bundleId: string): Promise<void> {
  const blocking = await blockingFailures(bundleId);
  if (blocking.length > 0) throw new WorksheetBlockedError(bundleId, blocking);
}

/** Soft failures annotate the worksheet and proceed (§6). */
export async function softAnnotations(
  bundleId: string,
): Promise<{ checkKey: string; message: string; documentId: string | null }[]> {
  const rows = await db
    .select({
      checkKey: checkResults.checkKey,
      message: checkResults.message,
      documentId: checkResults.documentId,
    })
    .from(checkResults)
    .where(
      and(
        eq(checkResults.bundleId, bundleId),
        eq(checkResults.severity, 'soft'),
        eq(checkResults.outcome, 'fail'),
      ),
    );
  return rows;
}
