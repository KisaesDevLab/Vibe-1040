import { useEffect, useState } from 'react';
import { api, formatCents } from '../api.ts';
import type { DraftReturn, DraftVerdict } from '../types.ts';

/**
 * The draft return panel (P17, CLAUDE.md §14).
 *
 * The hard part here is not rendering numbers, it is making sure nobody reads them as a
 * return. Four things carry that weight, and none is decoration:
 *
 *  - The panel is **absent entirely** unless the deployment enabled the feature and the engine
 *    is reachable. A dead control that says "engine unavailable" invites a retry loop; saying
 *    nothing is better.
 *  - The reviewer **states the filing status** before anything computes. No document carries
 *    it, so the app must not infer one — and making it a required first step puts the
 *    determination where §11 requires it.
 *  - **Omissions are open by default**, above the figures, because a withheld document leaves
 *    no mark on them: the line it would have fed is absent, and every computed total is a
 *    confident number regardless. The same treatment Judgment Required gets.
 *  - A **disagreement the design expects** (a withheld SSA-1099, a 1099-B the engine cannot
 *    take) is labelled as expected, because a panel that cries wolf gets ignored wholesale.
 */

const VERDICT_LABEL: Record<DraftVerdict, string> = {
  agrees: 'agrees',
  differs: 'differs',
  engine_silent: 'engine has nothing',
  worksheet_silent: 'worksheet has nothing',
  both_blank: 'neither',
  computed_only: 'computed',
};

export function DraftReturnPanel({
  bundleId,
  onError,
}: {
  bundleId: string;
  onError: (message: string) => void;
}) {
  // The filing-status codes come from the server, which reads them out of the node map.
  // Hardcoding them here once meant every draft would have been refused at the engine's
  // `general` node — the codes are the engine's vocabulary and change per release.
  const [status, setStatus] = useState<{
    enabled: boolean;
    engine: { ok: boolean; version: string | null; reason?: string } | null;
    filingStatuses: { code: string; label: string }[];
  } | null>(null);
  const [filingStatus, setFilingStatus] = useState('');
  const [draft, setDraft] = useState<DraftReturn | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .draftReturnStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, engine: null, filingStatuses: [] }));
  }, []);

  // Not enabled here, or the engine is not up: show nothing at all rather than a dead
  // control. This is an optional checking aid and its absence is not an error state.
  if (!status?.enabled || !status.engine?.ok) return null;

  const compute = () => {
    if (!filingStatus) return;
    setBusy(true);
    api
      .computeDraftReturn(bundleId, filingStatus)
      .then(setDraft)
      .catch((err: Error) => onError(err.message))
      .finally(() => setBusy(false));
  };

  const shown = draft?.comparison.lines.filter(
    (l) => l.verdict !== 'both_blank',
  );

  return (
    <section className="draft-pane">
      <h3>Draft return</h3>
      <p className="draft-caveat">
        Computed by the OpenTax engine {status.engine.version} from the amounts read off these
        documents, on this appliance. <strong>Advisory, and never a finished return.</strong>{' '}
        Vibe 1040 computes no tax itself and decides nothing: everything that needs a
        preparer&rsquo;s judgment is withheld from the engine and listed below.
      </p>

      {!draft && (
        <div className="draft-start">
          <label>
            Filing status
            <select value={filingStatus} onChange={(e) => setFilingStatus(e.target.value)}>
              <option value="">Choose…</option>
              {status.filingStatuses.map((f) => (
                <option key={f.code} value={f.code}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <p className="draft-hint">
            No source document says what the filing status is, so you have to. Nothing computes
            until you do.
          </p>
          <button type="button" onClick={compute} disabled={!filingStatus || busy}>
            {busy ? 'Computing…' : 'Compute draft return'}
          </button>
        </div>
      )}

      {draft && (
        <>
          <div className="draft-meta">
            {draft.documentsIncluded} document(s) computed, {draft.documentsWithheld} withheld ·
            node map {draft.nodeMapVersion} ·{' '}
            {draft.complete ? 'complete' : <strong>incomplete</strong>}
          </div>

          {/* Above the figures, open, because the figures are wrong by whatever is in here. */}
          <details className="draft-omissions" open>
            <summary>
              Not in this draft — {draft.omissions.length} item(s)
            </summary>
            <p className="draft-hint">
              The figures below are wrong by whatever these would have contributed. The line each
              one would have fed is simply absent, and every total &mdash; adjusted gross income,
              taxable income, total tax, the refund &mdash; was computed as though it did not
              exist. Nothing in the numbers says so.
            </p>
            {draft.omissions.map((o, i) => (
              <div key={`${o.documentId ?? 'bundle'}-${o.fieldKey ?? i}`} className="draft-omission">
                <div className="draft-omission-head">
                  <span>{o.formType ?? 'Not on any document'}</span>
                  <span className="draft-reason">{o.reason.replace(/_/g, ' ')}</span>
                </div>
                <div className="draft-omission-why">{o.detail}</div>
              </div>
            ))}
          </details>

          {draft.comparison.differing.length > 0 && (
            <div className="draft-differs">
              {draft.comparison.differing.length} line(s) where the engine and the worksheet
              disagree by more than {formatCents(draft.comparison.toleranceCents)}.
            </div>
          )}

          <table className="draft-table">
            <thead>
              <tr>
                <th>Line</th>
                <th>Documents report</th>
                <th>Engine computes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown?.map((line) => (
                <tr key={line.lineRef} className={line.verdict === 'differs' ? 'draft-row-differs' : undefined}>
                  <td>
                    <span className="draft-ref">{line.lineRef}</span>
                    <span className="draft-label">{line.label}</span>
                    {line.note && <span className="draft-note">Expected: {line.note}</span>}
                  </td>
                  <td className="draft-num">{formatCents(line.reportedCents)}</td>
                  <td className="draft-num draft-computed">{formatCents(line.computedCents)}</td>
                  <td className="draft-verdict">{VERDICT_LABEL[line.verdict]}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>Computed by the engine, with nothing on the worksheet to compare</h4>
          <table className="draft-table">
            <tbody>
              {draft.comparison.computedOnly.map((c) => (
                <tr key={`${c.engineForm}.${c.engineLine}`}>
                  <td>
                    <span className="draft-label">{c.label}</span>
                  </td>
                  <td className="draft-num draft-computed">{formatCents(c.computedCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {(draft.validation.hard.length > 0 || draft.validation.soft.length > 0) && (
            <details className="draft-validation">
              <summary>
                Engine business-rule diagnostics — {draft.validation.hard.length} blocking,{' '}
                {draft.validation.soft.length} advisory
              </summary>
              {[...draft.validation.hard, ...draft.validation.soft].map((v, i) => (
                <div key={`${v.code}-${i}`} className="draft-diag">
                  <code>{v.code}</code> {v.message}
                </div>
              ))}
            </details>
          )}

          <button type="button" onClick={() => setDraft(null)} className="draft-again">
            Start over
          </button>
        </>
      )}
    </section>
  );
}
