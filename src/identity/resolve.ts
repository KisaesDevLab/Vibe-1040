/**
 * Identity resolution (P5).
 *
 * There is no client master (§7). Client and tax year are **proposed** from the bundle and
 * **confirmed by a reviewer** before extraction results commit.
 *
 * Expect several TINs in one bundle: a joint return has two, plus trusts and dependents.
 * Name matching is a tiebreaker for display only — the join key is always the hashed TIN,
 * because "SMITH FAMILY TRUST" and "ROBERT J SMITH" are the same client's documents and no
 * amount of string similarity reliably says so.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { bundleTaxpayers, bundles, documents, taxpayers } from '../db/schema.ts';
import { blockingFailures } from '../reconcile/gate.ts';
import { hashTin, isPlausibleTin, last4, normalizeTin } from './tin.ts';

export interface TinObservation {
  documentId: string;
  /** Plaintext, in memory only. Never persisted, never logged. */
  rawTin: string;
  name: string | null;
  formType: string | null;
}

export interface ProposedTaxpayer {
  tinHash: string;
  tinLast4: string;
  displayName: string | null;
  documentIds: string[];
  /** Highest when it appears on a W-2 or 1099-R — forms that name one person. */
  score: number;
}

export interface IdentityProposal {
  taxpayers: ProposedTaxpayer[];
  taxYear: number | null;
  taxYearMismatches: { documentId: string; taxYear: number }[];
  /** TINs we saw but could not use — masked, or implausible. */
  unusable: { documentId: string; reason: 'masked' | 'implausible' | 'unparseable'; last4: string | null }[];
}

/** Forms that identify a single individual carry more weight than an account statement. */
const FORM_WEIGHT: Record<string, number> = {
  'W-2': 10,
  'SSA-1099': 9,
  '1099-R': 8,
  '1095-A': 8,
  '1098': 5,
  '1099-INT': 3,
  '1099-DIV': 3,
  '1099-B': 3,
  '1099-CONSOLIDATED': 3,
};

export function proposeIdentity(
  observations: readonly TinObservation[],
  documentYears: readonly { documentId: string; taxYear: number | null }[],
): IdentityProposal {
  const byHash = new Map<string, ProposedTaxpayer>();
  const unusable: IdentityProposal['unusable'] = [];

  for (const obs of observations) {
    const normalized = normalizeTin(obs.rawTin);

    if (!normalized) {
      // A masked TIN (XXX-XX-6789) still tells us the last four, which is worth showing the
      // reviewer even though it cannot join anything.
      unusable.push({
        documentId: obs.documentId,
        reason: /[xX*]/.test(obs.rawTin) ? 'masked' : 'unparseable',
        last4: last4(obs.rawTin),
      });
      continue;
    }
    if (!isPlausibleTin(normalized)) {
      unusable.push({ documentId: obs.documentId, reason: 'implausible', last4: normalized.slice(-4) });
      continue;
    }

    const identity = hashTin(normalized);
    if (!identity) continue;

    const existing = byHash.get(identity.tinHash);
    const weight = FORM_WEIGHT[obs.formType ?? ''] ?? 1;

    if (existing) {
      existing.documentIds.push(obs.documentId);
      existing.score += weight;
      // Prefer the name from the highest-weight form seen so far.
      if (obs.name && weight >= 8) existing.displayName = obs.name;
    } else {
      byHash.set(identity.tinHash, {
        tinHash: identity.tinHash,
        tinLast4: identity.tinLast4,
        displayName: obs.name,
        documentIds: [obs.documentId],
        score: weight,
      });
    }
  }

  // Majority tax year across documents; everything else is flagged (§7).
  const counts = new Map<number, number>();
  for (const d of documentYears) {
    if (d.taxYear === null) continue;
    counts.set(d.taxYear, (counts.get(d.taxYear) ?? 0) + 1);
  }
  const taxYear = counts.size
    ? [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0]
    : null;

  const taxYearMismatches = documentYears
    .filter((d) => d.taxYear !== null && taxYear !== null && d.taxYear !== taxYear)
    .map((d) => ({ documentId: d.documentId, taxYear: d.taxYear! }));

  return {
    taxpayers: [...byHash.values()].sort((a, b) => b.score - a.score),
    taxYear,
    taxYearMismatches,
    unusable,
  };
}

/**
 * Persist a proposal as *proposed*. Nothing is confirmed here — `confirmIdentity` is a
 * separate, human-driven step, and extraction results must not commit before it (§7).
 */
export async function saveProposal(
  bundleId: string,
  proposal: IdentityProposal,
  options: { setTaxYear: boolean } = { setTaxYear: true },
): Promise<void> {
  for (const [index, proposed] of proposal.taxpayers.entries()) {
    const [row] = await db
      .insert(taxpayers)
      .values({
        tinHash: proposed.tinHash,
        tinLast4: proposed.tinLast4,
        displayName: proposed.displayName,
      })
      .onConflictDoUpdate({
        target: taxpayers.tinHash,
        set: { displayName: proposed.displayName, updatedAt: new Date() },
      })
      .returning({ id: taxpayers.id });

    const taxpayerId = row!.id;

    await db
      .insert(bundleTaxpayers)
      .values({
        bundleId,
        taxpayerId,
        role: index === 0 ? 'primary' : index === 1 ? 'spouse' : 'other',
        proposed: true,
      })
      .onConflictDoNothing();

    for (const documentId of proposed.documentIds) {
      await db.update(documents).set({ taxpayerId }).where(eq(documents.id, documentId));
    }
  }

  for (const mismatch of proposal.taxYearMismatches) {
    await db
      .update(documents)
      .set({ taxYearMismatch: true })
      .where(eq(documents.id, mismatch.documentId));
  }

  /**
   * The bundle year is the majority across the whole bundle, proposed at classification.
   * A later proposal made from one document — the post-extraction refinement carries a single
   * document's year — must not replace it: with a 5498 read as 2026 in a 2025 pile, whichever
   * document extracted last used to become the bundle year. Status is left alone here too;
   * the pipeline owns it.
   */
  if (options.setTaxYear && proposal.taxYear !== null) {
    await db
      .update(bundles)
      .set({ taxYear: proposal.taxYear, updatedAt: new Date() })
      .where(eq(bundles.id, bundleId));
  }

  await renameBundleFromPrimaryTaxpayer(bundleId, proposal);
}

/**
 * Give a bulk-uploaded bundle the primary taxpayer's name.
 *
 * Only ever replaces a label the app wrote itself (`labelAuto`). A reviewer who renamed a
 * bundle has said what it is called, and a later identity pass must not argue.
 *
 * The name is still a proposal at this point, and deliberately so: a reviewer scanning a
 * list of forty bundles needs to see whose is whose *before* confirming each one, and the
 * name is what they recognise. It is a label, never a key — §7's join key is the salted TIN
 * hash and nothing here changes that.
 */
async function renameBundleFromPrimaryTaxpayer(
  bundleId: string,
  proposal: IdentityProposal,
): Promise<void> {
  const primaryName = proposal.taxpayers[0]?.displayName?.trim();
  if (!primaryName) return;

  const [bundle] = await db
    .select({ labelAuto: bundles.labelAuto })
    .from(bundles)
    .where(eq(bundles.id, bundleId))
    .limit(1);
  if (!bundle?.labelAuto) return;

  await db
    .update(bundles)
    .set({ label: primaryName, updatedAt: new Date() })
    .where(eq(bundles.id, bundleId));
}

/** The human gate. Until this runs, the bundle does not proceed to extraction (§7). */
export async function confirmIdentity(
  bundleId: string,
  userId: string,
  confirmed: { taxpayerId: string; role: string }[],
  taxYear: number,
): Promise<void> {
  for (const entry of confirmed) {
    await db
      .update(bundleTaxpayers)
      .set({ proposed: false, role: entry.role, updatedAt: new Date() })
      .where(eq(bundleTaxpayers.taxpayerId, entry.taxpayerId));
  }

  /**
   * Confirmation no longer starts anything. Extraction has already run, which is the point:
   * the reviewer confirms against the forms the app actually read rather than against a guess
   * made before it read anything. What confirmation now buys is the worksheet — see
   * `assertIdentityConfirmed` (§7, decision 2026-09-10).
   */
  const blocking = await blockingFailures(bundleId);

  await db
    .update(bundles)
    .set({
      identityConfirmedAt: new Date(),
      identityConfirmedBy: userId,
      taxYear,
      status: blocking.length > 0 ? 'blocked' : 'in_review',
      updatedAt: new Date(),
    })
    .where(eq(bundles.id, bundleId));

  // The reviewer's year is the bundle year. Re-flag every document against it, so a
  // proposal that was wrong does not leave stale mismatch marks behind.
  const docs = await db.select({ id: documents.id, taxYear: documents.taxYear }).from(documents).where(eq(documents.bundleId, bundleId));
  for (const doc of docs) {
    await db
      .update(documents)
      .set({ taxYearMismatch: doc.taxYear !== null && doc.taxYear !== taxYear })
      .where(eq(documents.id, doc.id));
  }
}
