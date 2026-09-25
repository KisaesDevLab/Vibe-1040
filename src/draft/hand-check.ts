/**
 * The hand-check sheet (P17 exit criterion).
 *
 * P17 cannot exit until a person has checked a draft return line by line against a known
 * packet. Everything else about the draft return has been measured by machine — the harness
 * scores 13 lines against the real engine, the catalogue check compares field names, the
 * translator's withholding rules are mutation-checked — and none of that is the same as
 * somebody holding the forms and agreeing.
 *
 * This exists to make that check a ticking exercise rather than a hunting one. For every line
 * it puts three things on one row:
 *
 *   1. what the documents report, which is the worksheet's own total;
 *   2. what the engine computed from the same documents;
 *   3. **which box on which document each contributing figure came from**, so the checker can
 *      go straight to the paper instead of working backwards from a total.
 *
 * (3) is the part that makes it worth generating. `worksheet_contributions` already records
 * it — per line, the document, the field and the amount — and it is otherwise only visible
 * expanded in the review UI, one line at a time.
 *
 * **The omissions come first**, as everywhere else (§14). A checker reconciling figures that
 * are wrong by a withheld pension, without being told a pension was withheld, would be
 * checking the wrong thing carefully.
 *
 * **And what the preparer typed is listed apart from what was read** (P18). The two are checked
 * differently: a document figure is checked against the paper, and a preparer's is checked
 * against whatever they worked it out from, which is not in the packet. A checker who could not
 * tell them apart would go hunting for a form that was never there — and would have no way to
 * see that a 1098 in the pile was deliberately displaced.
 */
import { buildWorksheetModel } from '../mapping/engine.ts';
import { loadMappedDocuments } from '../worksheet/generate.ts';
import type {
  HandCheckModel,
  HandCheckPreparerFigure,
  HandCheckRow,
  HandCheckSource,
} from '../worksheet/draft-sheet.ts';
import { latestDraftReturn } from './generate.ts';
import { documentBackedScheduleALines, draftInputsForBundle } from './inputs.ts';
import { loadNodeMap } from './nodes.ts';

/**
 * Build the sheet for a bundle's most recent draft return, or null when none exists.
 *
 * Reads the stored draft rather than recomputing one: the point is to check the draft the
 * preparer is looking at, and a freshly computed one could differ if a field was corrected in
 * between. The contributions are rebuilt from the documents because they are the *current*
 * provenance — if those have moved under the stored draft, the checker should see that rather
 * than have it hidden.
 */
export async function handCheckForBundle(bundleId: string): Promise<HandCheckModel | null> {
  const stored = await latestDraftReturn(bundleId);
  if (!stored) return null;

  const { taxYear, mapped, documentLabels } = await loadMappedDocuments(bundleId);
  const worksheet = await buildWorksheetModel(taxYear, mapped);

  const sourcesByRef = new Map<string, HandCheckSource[]>();
  for (const line of worksheet.lines) {
    if (line.contributions.length === 0) continue;
    sourcesByRef.set(
      line.lineRef,
      line.contributions.map((c) => ({
        document: documentLabels.get(c.documentId) ?? c.formType,
        // The box number as well as its name. A checker with the form in hand looks for
        // "box 1", not for "Wages, tips, other compensation" — and the field key already
        // carries it, so no schema lookup is needed to say both.
        fieldLabel: `${c.fieldKey.replace(/_/g, ' ')} · ${c.fieldLabel}`,
        valueCents: c.valueCents,
        wasCorrected: c.wasCorrected,
        judgmentReason: c.judgmentReason,
      })),
    );
  }

  const rows: HandCheckRow[] = stored.lines
    // Engine-only figures (AGI, total tax, the refund) have no line ref and nothing on the
    // documents to trace to, so there is nothing for a checker to tick them against. They are
    // on the Draft Return sheet already; repeating them here would be a column of blanks.
    .filter((l) => l.lineRef !== null && l.verdict !== 'both_blank')
    .map((l) => ({
      lineRef: l.lineRef!,
      label: l.lineLabel,
      reportedCents: l.reportedCents,
      computedCents: l.computedCents,
      verdict: l.verdict,
      note: l.note,
      sources: sourcesByRef.get(l.lineRef!) ?? [],
    }));

  return {
    preparerFigures: await preparerFigures(bundleId, taxYear),
    taxYear: stored.draftReturn.taxYear,
    engineVersion: stored.draftReturn.engineVersion,
    nodeMapVersion: stored.draftReturn.nodeMapVersion,
    mappingVersion: stored.draftReturn.mappingVersion,
    filingStatus: stored.draftReturn.filingStatus,
    complete: stored.draftReturn.complete,
    documentsIncluded: stored.draftReturn.documentsIncluded,
    documentsWithheld: stored.draftReturn.documentsWithheld,
    generatedAt: stored.draftReturn.createdAt,
    omissions: [...stored.omissions]
      .sort((a, b) => Number(a.reason === 'not_in_bundle') - Number(b.reason === 'not_in_bundle'))
      .map((o) => ({
        formType: o.formType,
        fieldKey: o.fieldKey,
        reason: o.reason,
        detail: o.detail,
      })),
    rows,
  };
}

/**
 * What the preparer stated for this bundle, flattened for one block of the sheet.
 *
 * Labels come from the node map, as they do on the entry surface, so the sheet and the screen
 * cannot drift apart — and a Schedule A line added to the map appears here without anybody
 * remembering to add it.
 *
 * A line the preparer left blank is left out. This is a list of what was stated, and 19 rows of
 * "blank" would bury the four that say something.
 */
async function preparerFigures(
  bundleId: string,
  taxYear: number,
): Promise<HandCheckPreparerFigure[]> {
  const stored = await draftInputsForBundle(bundleId);
  const file = await loadNodeMap(taxYear).catch(() => null);
  const out: HandCheckPreparerFigure[] = [];

  const statement = (group: string, label: string, stated: string | null): void => {
    if (stated !== null) out.push({ group, label, valueCents: null, stated, supersedes: null });
  };
  const yesNo = (v: boolean | null): string | null => (v === null ? null : v ? 'Yes' : 'No');

  statement(
    'This return',
    'Filing status',
    stored.filingStatus === null
      ? null
      : (file?.filingStatuses.find((f) => f.code === stored.filingStatus)?.label ??
        stored.filingStatus),
  );
  statement('This return', 'Taxpayer is 65 or older', yesNo(stored.taxpayerAge65OrOlder));
  statement('This return', 'Spouse is 65 or older', yesNo(stored.spouseAge65OrOlder));
  statement('This return', 'Taxpayer is blind', yesNo(stored.taxpayerBlind));
  statement('This return', 'Spouse is blind', yesNo(stored.spouseBlind));

  for (const d of stored.dependents) {
    const relationship =
      file?.preparerInputs?.dependents.relationships.find((r) => r.code === d.relationship)?.label ??
      d.relationship;
    out.push({
      group: 'Dependents',
      label: `${d.firstName} ${d.lastName} — ${relationship}, born ${d.dob}, ${d.monthsInHome} month(s) in the home`,
      valueCents: null,
      // The determination that decides whether a credit is computed, said in full. "Not stated"
      // is the answer that earns no credit while looking like nothing at all.
      stated:
        d.qualifyingChildForCtc === null
          ? 'Qualifying child for the child tax credit: not stated — no credit is computed'
          : `Qualifying child for the child tax credit: ${d.qualifyingChildForCtc ? 'yes' : 'no'}`,
      supersedes: null,
    });
  }

  const inputs = file?.preparerInputs;
  if (stored.scheduleA && inputs) {
    const backed = new Map(
      (await documentBackedScheduleALines(bundleId, taxYear)).map((b) => [b.column, b]),
    );
    for (const field of [...inputs.scheduleA.fields, ...inputs.scheduleA.flags]) {
      const value = stored.scheduleA[field.column];
      if (value === null || value === undefined) continue;
      const conflict = backed.get(field.column);
      out.push({
        group: 'Itemised deductions',
        label: field.label,
        valueCents: typeof value === 'number' ? value : null,
        stated: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : null,
        supersedes:
          conflict === undefined
            ? null
            : conflict.sources
                .map((sc) => `${sc.documentLabel} (${sc.fieldKey.replace(/_/g, ' ')})`)
                .join('; '),
      });
    }
  }

  for (const a of stored.activities) {
    const kind = inputs?.activities.find((k) => k.kind === a.kind)?.label ?? a.kind;
    const gross = a.grossCents ?? null;
    const expenses = a.expensesCents ?? null;
    out.push({
      group: 'Businesses and rentals',
      label: `${a.description} — ${kind}`,
      // The net, which is what reaches the 1040. Expenses left blank net nothing off, which is
      // different from expenses of zero only in what the sheet says beside it.
      valueCents: gross === null ? null : gross - (expenses ?? 0),
      stated:
        gross === null
          ? 'No gross stated'
          : `gross ${(gross / 100).toFixed(2)} less expenses ${
              expenses === null ? 'not stated' : (expenses / 100).toFixed(2)
            }`,
      supersedes: null,
    });
  }

  return out;
}
