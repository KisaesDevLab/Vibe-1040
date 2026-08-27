import { useCallback, useEffect, useState } from 'react';
import { api, formatCents } from './api';
import { FieldEditor } from './components/FieldEditor';
import { PageOverlay } from './components/PageOverlay';
import type { Bundle, CheckRow, DocumentRow, FieldRow, PageRow, SpanRow, WorksheetLine } from './types';

type View = 'login' | 'mfa' | 'bundles' | 'review';

export default function App() {
  const [view, setView] = useState<View>('login');
  const [me, setMe] = useState<{ displayName: string; role: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then((u) => {
        setMe(u);
        setView('bundles');
      })
      .catch(() => setView('login'));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Vibe 1040</div>
        <div className="spacer" />
        {me && (
          <>
            <span className="who">{me.displayName}</span>
            <button
              onClick={() => {
                void api.logout().then(() => {
                  setMe(null);
                  setView('login');
                });
              }}
            >
              Sign out
            </button>
          </>
        )}
      </header>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      {view === 'login' && <Login onNext={() => setView('mfa')} onError={setError} />}
      {view === 'mfa' && (
        <Mfa
          onDone={() => {
            void api.me().then((u) => {
              setMe(u);
              setView('bundles');
            });
          }}
          onError={setError}
        />
      )}
      {view === 'bundles' && <BundleList onOpen={() => setView('review')} onError={setError} />}
      {view === 'review' && <Review onBack={() => setView('bundles')} onError={setError} />}
    </div>
  );
}

// ── auth ─────────────────────────────────────────────────────────────────────

function Login({ onNext, onError }: { onNext: () => void; onError: (m: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <div className="centered card">
      <h1>Sign in</h1>
      <p className="muted">Staff access only. A second factor is required.</p>
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        placeholder="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button
        onClick={() => {
          api.login(email, password).then(onNext).catch((e: Error) => onError(e.message));
        }}
      >
        Continue
      </button>
    </div>
  );
}

function Mfa({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [token, setToken] = useState('');
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string } | null>(null);

  return (
    <div className="centered card">
      <h1>Second factor</h1>
      {enrollment && (
        <div className="enrollment">
          <p className="muted">Add this secret to your authenticator, then enter the code.</p>
          <code>{enrollment.secret}</code>
        </div>
      )}
      <input placeholder="6-digit code" value={token} onChange={(e) => setToken(e.target.value)} />
      <button onClick={() => api.verifyMfa(token).then(onDone).catch((e: Error) => onError(e.message))}>
        Verify
      </button>
      <button
        className="link"
        onClick={() => api.enrollMfa().then(setEnrollment).catch((e: Error) => onError(e.message))}
      >
        Enrol a new authenticator
      </button>
    </div>
  );
}

// ── bundle list ──────────────────────────────────────────────────────────────

let selectedBundleId: string | null = null;

function BundleList({ onOpen, onError }: { onOpen: () => void; onError: (m: string) => void }) {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [label, setLabel] = useState('');

  const refresh = useCallback(() => {
    api.bundles().then(setBundles).catch((e: Error) => onError(e.message));
  }, [onError]);

  useEffect(refresh, [refresh]);

  return (
    <div className="page">
      <div className="card">
        <h2>New bundle</h2>
        <input placeholder="Client / bundle label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input
          type="file"
          multiple
          accept="application/pdf,image/*"
          onChange={(e) => {
            if (!e.target.files?.length) return;
            api
              .upload(label || 'Untitled bundle', e.target.files)
              .then(refresh)
              .catch((err: Error) => onError(err.message));
          }}
        />
      </div>

      <div className="card">
        <h2>Bundles</h2>
        <table className="grid">
          <thead>
            <tr><th>Label</th><th>Status</th><th>Tax year</th><th></th></tr>
          </thead>
          <tbody>
            {bundles.map((b) => (
              <tr key={b.id}>
                <td>
                  {b.label}
                  {b.duplicateOfBundleId && <span className="pill warn">duplicate</span>}
                </td>
                <td><span className={`pill status-${b.status}`}>{b.status}</span></td>
                <td>{b.taxYear ?? '—'}</td>
                <td>
                  <button
                    onClick={() => {
                      selectedBundleId = b.id;
                      onOpen();
                    }}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── review ───────────────────────────────────────────────────────────────────

function Review({ onBack, onError }: { onBack: () => void; onError: (m: string) => void }) {
  const bundleId = selectedBundleId!;
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [blocking, setBlocking] = useState<{ id: string; checkKey: string; message: string }[]>([]);
  const [routerDown, setRouterDown] = useState(false);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ pages: PageRow[]; fields: FieldRow[]; spans: SpanRow[] } | null>(null);
  const [selectedField, setSelectedField] = useState<FieldRow | null>(null);
  const [lines, setLines] = useState<WorksheetLine[]>([]);

  const refreshBundle = useCallback(() => {
    api
      .bundle(bundleId)
      .then((data) => {
        setBundle(data.bundle);
        setDocuments(data.documents);
        setChecks(data.checks);
        setBlocking(data.blocking);
        setRouterDown(data.routerDown);
      })
      .catch((e: Error) => onError(e.message));
    api
      .worksheetPreview(bundleId)
      .then((p) => setLines(p.model.lines))
      .catch(() => setLines([]));
  }, [bundleId, onError]);

  useEffect(refreshBundle, [refreshBundle]);

  const openDoc = (id: string) => {
    setActiveDoc(id);
    api
      .document(id)
      .then((d) => {
        setDetail({ pages: d.pages, fields: d.fields, spans: d.spans });
        setSelectedField(d.fields.find((f) => f.needsReview) ?? d.fields[0] ?? null);
      })
      .catch((e: Error) => onError(e.message));
  };

  const refreshDoc = () => {
    if (activeDoc) openDoc(activeDoc);
    refreshBundle();
  };

  return (
    <div className="review">
      <div className="review-header">
        <button onClick={onBack}>← Bundles</button>
        <h2>{bundle?.label}</h2>
        <span className={`pill status-${bundle?.status}`}>{bundle?.status}</span>
        {routerDown && <span className="pill error">Router unreachable — work is parked</span>}
        <div className="spacer" />
        <button
          disabled={blocking.length > 0}
          title={blocking.length > 0 ? 'Disposition the hard failures first' : 'Generate the worksheet'}
          onClick={() => {
            api
              .generateWorksheet(bundleId)
              .then(() => refreshBundle())
              .catch((e: Error) => onError(e.message));
          }}
        >
          Generate worksheet
        </button>
      </div>

      {blocking.length > 0 && (
        <div className="banner blocking">
          <strong>{blocking.length} hard failure(s) block this worksheet.</strong> Each must be
          dispositioned by a human before a worksheet is produced.
        </div>
      )}

      <div className="review-body">
        <aside className="doc-list">
          <h3>Documents</h3>
          {documents.map((d) => (
            <button
              key={d.id}
              className={d.id === activeDoc ? 'doc active' : 'doc'}
              onClick={() => openDoc(d.id)}
            >
              <span className="doc-type">{d.formType ?? 'unclassified'}</span>
              {d.payerName && <span className="doc-payer">{d.payerName}</span>}
              <span className="doc-flags">
                {d.corrected && <span className="pill warn">CORRECTED</span>}
                {d.void && <span className="pill warn">VOID</span>}
                {d.taxYearMismatch && <span className="pill warn">year {d.taxYear}</span>}
                {d.parentDocumentId && <span className="pill">sub-form</span>}
              </span>
            </button>
          ))}

          <h3>Checks</h3>
          {checks.filter((c) => c.outcome === 'fail').map((c) => (
            <DispositionRow key={c.id} check={c} onDone={refreshBundle} onError={onError} />
          ))}
        </aside>

        <main className="doc-detail">
          {detail && detail.pages[0] ? (
            <PageOverlay
              pageId={detail.pages[0].id}
              spans={detail.spans}
              highlightedSpanIds={selectedField?.spanIds ?? []}
            />
          ) : (
            <div className="empty">Select a document.</div>
          )}
        </main>

        <aside className="field-pane">
          <h3>Fields</h3>
          {detail?.fields.map((f) => (
            <FieldEditor
              key={f.fieldId}
              field={f}
              label={f.fieldKey}
              isMoney={f.cents !== null || (f.text === null && f.bool === null)}
              selected={selectedField?.fieldId === f.fieldId}
              onSelect={() => setSelectedField(f)}
              onChanged={refreshDoc}
            />
          ))}
        </aside>

        <aside className="worksheet-pane">
          <h3>Worksheet preview</h3>
          {lines
            .filter((l) => l.contributorCount > 0 || l.isJudgmentRequired)
            .map((line) => (
              <div key={line.lineRef} className={line.isJudgmentRequired ? 'ws-line judgment' : 'ws-line'}>
                <div className="ws-head">
                  <span className="ws-ref">{line.lineRef}</span>
                  <span className="ws-total">
                    {line.notComputed ? 'not computed' : formatCents(line.totalCents)}
                  </span>
                </div>
                <div className="ws-label">{line.label}</div>
                {line.nullContributorCount > 0 && (
                  <div className="ws-nulls">{line.nullContributorCount} contributing box(es) blank</div>
                )}
              </div>
            ))}
        </aside>
      </div>
    </div>
  );
}

function DispositionRow({
  check,
  onDone,
  onError,
}: {
  check: CheckRow;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <div className={check.severity === 'hard' ? 'check hard' : 'check soft'}>
      <div className="check-key">{check.checkKey}</div>
      <div className="check-message">{check.message}</div>
      {check.severity === 'hard' &&
        (open ? (
          <div className="check-actions">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="why is this acceptable?" />
            {(['accepted_as_is', 'corrected', 'document_excluded'] as const).map((kind) => (
              <button
                key={kind}
                disabled={!note}
                onClick={() =>
                  api
                    .disposition(check.id, kind, note)
                    .then(onDone)
                    .catch((e: Error) => onError(e.message))
                }
              >
                {kind.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        ) : (
          <button onClick={() => setOpen(true)}>Disposition</button>
        ))}
    </div>
  );
}
