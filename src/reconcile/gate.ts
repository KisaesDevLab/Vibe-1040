/**
 * The blocking gate (§6, P9).
 *
 * "A bundle with a hard failure does not produce a worksheet until a human dispositions
 * the failure." That sentence is implemented here, in one place, and every worksheet path
 * must go through `assertWorksheetAllowed`. There is deliberately no `force` parameter and
 * no severity override — P9's exit criterion is that the gate cannot be bypassed by any
 * code path, and an escape hatch would be exactly that path.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { bundles, checkResults, dispositions } from '../db/schema.ts';

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
  await assertIdentityConfirmed(bundleId);
}

export class IdentityNotConfirmedError extends Error {
  readonly bundleId: string;
  constructor(bundleId: string) {
    super(`bundle ${bundleId} has no confirmed client; a worksheet cannot be attributed to one`);
    this.name = 'IdentityNotConfirmedError';
    this.bundleId = bundleId;
  }
}

/**
 * The §7 gate, as of the 2026-09-10 decision.
 *
 * It used to sit before extraction, where it stopped a bundle from being processed at all and
 * was read by nothing afterwards — a sequencing step wearing the costume of a control. Here it
 * is a real precondition: a worksheet is a statement about a named client's return, so it does
 * not get produced until a human has said which client that is.
 *
 * Extraction runs without it on purpose. Reading a document does not attribute it to anyone,
 * and the reviewer confirms far better against forms the app has read than against a guess it
 * made beforehand.
 */
export async function assertIdentityConfirmed(bundleId: string): Promise<void> {
  const [bundle] = await db
    .select({ identityConfirmedAt: bundles.identityConfirmedAt })
    .from(bundles)
    .where(eq(bundles.id, bundleId))
    .limit(1);
  if (!bundle?.identityConfirmedAt) throw new IdentityNotConfirmedError(bundleId);
}

/**
 * Soft failures annotate the worksheet and proceed (§6), plus one hard one.
 *
 * `unrecognised_form` is included deliberately. It blocks, so by the time a worksheet can be
 * generated a human has read the page and dispositioned it — but the amounts on that page
 * were still never extracted, and a worksheet that omits them without saying so is the exact
 * silent omission the blocking check was added to prevent. Carrying it through as an
 * annotation means the finished artifact records that a page was read and not extracted.
 */
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
        eq(checkResults.outcome, 'fail'),
        or(eq(checkResults.severity, 'soft'), eq(checkResults.checkKey, 'unrecognised_form')),
      ),
    );
  return rows;
}
