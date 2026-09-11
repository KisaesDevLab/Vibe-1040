import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api, formatCents } from './api';
import { FieldEditor } from './components/FieldEditor';
import { PageOverlay } from './components/PageOverlay';
import { Admin } from './components/Admin';
import type { Bundle, CheckRow, DocumentRow, FactorState, FieldRow, PageRow, SpanRow, WorksheetLine } from './types';

type View = 'login' | 'mfa' | 'forgot' | 'bundles' | 'review' | 'admin';

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
            {(me.role === 'admin' || me.role === 'partner') && (
              <button onClick={() => setView(view === 'admin' ? 'bundles' : 'admin')}>
                {view === 'admin' ? 'Bundles' : 'Admin'}
              </button>
            )}
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

      {view === 'login' && (
        <Login onNext={() => setView('mfa')} onForgot={() => setView('forgot')} onError={setError} />
      )}
      {view === 'forgot' && <Forgot onDone={() => setView('login')} onError={setError} />}
      {view === 'mfa' && (
        <Mfa
          onDone={() => {
            void api.me().then((u) => {
              setMe(u);
              setView('bundles');
            });
          }}
          onError={setError}
          onRestart={() => setView('login')}
        />
      )}
      {view === 'bundles' && <BundleList onOpen={() => setView('review')} onError={setError} />}
      {view === 'review' && <Review onBack={() => setView('bundles')} onError={setError} />}
      {view === 'admin' && <Admin onError={setError} />}
    </div>
  );
}

// ── auth ─────────────────────────────────────────────────────────────────────

function Login({
  onNext,
  onForgot,
  onError,
}: {
  onNext: () => void;
  onForgot: () => void;
  onError: (m: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const go = () => api.login(email, password).then(onNext).catch((e: Error) => onError(e.message));

  return (
    <div className="centered card">
      <h1>Sign in</h1>
      <p className="muted">
        Staff access only. A second factor is always required. An authenticator app needs
        nothing set up by the firm, so you can enrol one on this sign-in.
      </p>
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        placeholder="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void go(); }}
      />
      <button onClick={() => void go()}>Continue</button>
      <button className="link" onClick={onForgot}>Forgot your password?</button>
    </div>
  );
}

/**
 * Second factor. MFA is mandatory, so this screen has no skip — what varies is only which
 * factor the user is enrolled on.
 */
function Mfa({
  onDone,
  onError,
  onRestart,
}: {
  onDone: () => void;
  onError: (m: string) => void;
  onRestart: () => void;
}) {
  const [factor, setFactor] = useState<FactorState | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    uri: string;
    account: string;
    issuer: string;
  } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A failure here used to leave the screen on "Checking your second factor…" forever,
  // because nothing set `factor` and nothing recorded that the call had failed. The most
  // common cause is a session cookie the browser accepted and will not send back, which
  // makes this request 401 — so the one message that would have explained it was the one
  // the user never saw. Show it, and offer the way back.
  useEffect(() => {
    api
      .factor()
      .then(setFactor)
      .catch((e: Error) => {
        setLoadFailed(e.message);
        onError(e.message);
      });
  }, [onError]);

  const send = useCallback(() => {
    setBusy(true);
    api
      .sendCode()
      .then((r) => setSentTo(r.destination))
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  }, [onError]);

  // An emailed or texted factor needs a code in hand before anything can be typed.
  useEffect(() => {
    if (factor && factor.method !== 'totp' && factor.usable && sentTo === null) send();
  }, [factor, sentTo, send]);

  if (loadFailed) {
    return (
      <div className="centered card">
        <h1>Could not check your second factor</h1>
        <p className="warn-note">{loadFailed}</p>
        <p className="muted">
          If that says authentication is required, your browser is not returning the session
          cookie. Over plain HTTP that happens when the server marks the cookie Secure; see
          SESSION_SECURE in the runbook.
        </p>
        <button onClick={onRestart}>Back to sign in</button>
      </div>
    );
  }

  if (!factor) return <div className="centered card">Checking your second factor…</div>;

  // A factor that cannot be delivered is not a dead end while authenticators are permitted:
  // enrolling one needs no SMTP, no SMS gateway, and no administrator. MFA is still
  // mandatory — this changes which factor you use, never whether you need one.
  if (!factor.usable && !factor.totpAvailable) {
    return (
      <div className="centered card">
        <h1>Second factor unavailable</h1>
        <p className="warn-note">{factor.why ?? 'Your second factor is not usable.'}</p>
        <p className="muted">Ask a firm administrator to reset it under Admin → Users.</p>
      </div>
    );
  }

  const fallingBack = !factor.usable;
  const isTotp = factor.method === 'totp' || fallingBack;
  const submit = () => {
    setBusy(true);
    const call = isTotp ? api.verifyMfa(code) : api.verifyCode(code);
    call.then(onDone).catch((e: Error) => onError(e.message)).finally(() => setBusy(false));
  };

  return (
    <div className="centered card">
      <h1>Second factor</h1>

      {fallingBack && (
        <p className="warn-note">
          {factor.why ?? 'Your assigned second factor is not usable.'} Set up an authenticator
          app instead — it needs nothing configured, and it becomes your second factor from
          now on.
        </p>
      )}

      {isTotp && !factor.totpEnrolled && !enrollment && (
        <>
          <p className="muted">You need to enrol an authenticator before you can sign in.</p>
          <button onClick={() => api.enrollMfa().then(setEnrollment).catch((e: Error) => onError(e.message))}>
            Set up authenticator
          </button>
        </>
      )}

      {enrollment && (
        <div className="enrollment">
          <p className="muted">
            Scan this with your authenticator app, then enter the six-digit code it shows.
          </p>
          <div className="qr">
            {/* The otpauth URI carries the issuer and the account, so the app labels the
                entry itself. Typing the key by hand loses that, which is why the QR is the
                primary path and the key is the fallback. */}
            <QRCodeSVG value={enrollment.uri} size={168} level="M" marginSize={2} />
          </div>
          <p className="enrollment__account">
            {enrollment.issuer} · {enrollment.account}
          </p>
          <details className="enrollment__manual">
            <summary>Can't scan? Enter the key by hand</summary>
            <code>{enrollment.secret}</code>
            <p className="muted">
              Choose "enter a setup key" in your authenticator, and name it
              {' '}{enrollment.issuer}.
            </p>
          </details>
        </div>
      )}

      {isTotp && factor.totpEnrolled && (
        <p className="muted">Enter the current code from your authenticator app.</p>
      )}

      {!isTotp && (
        <p className="muted">
          {sentTo ? <>We sent a code to <strong>{sentTo}</strong>. It expires shortly.</> : 'Sending a code…'}
        </p>
      )}

      <input
        placeholder="6-digit code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && code) submit(); }}
        autoFocus
      />
      <button disabled={busy || !code} onClick={submit}>Verify</button>

      {!isTotp && (
        <button className="link" disabled={busy} onClick={send}>Send another code</button>
      )}
    </div>
  );
}

function Forgot({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [stage, setStage] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="centered card">
      <h1>Reset your password</h1>

      {stage === 'request' ? (
        <>
          <p className="muted">
            Enter your work email. If it belongs to an account, we will send a reset code.
          </p>
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button
            disabled={!email}
            onClick={() =>
              api
                .forgotPassword(email)
                .then((r) => { setMessage(r.message); setStage('reset'); })
                .catch((e: Error) => onError(e.message))
            }
          >
            Send reset code
          </button>
        </>
      ) : (
        <>
          {message && <p className="muted">{message}</p>}
          <input placeholder="reset code" value={code} onChange={(e) => setCode(e.target.value)} />
          <input
            type="password"
            placeholder="new password (12+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            disabled={!code || password.length < 12}
            onClick={() =>
              api
                .resetPassword(email, code, password)
                .then(() => onDone())
                .catch((e: Error) => onError(e.message))
            }
          >
            Set new password
          </button>
        </>
      )}

      <button className="link" onClick={onDone}>Back to sign in</button>
    </div>
  );
}

// ── bundle list ──────────────────────────────────────────────────────────────

let selectedBundleId: string | null = null;

function BundleList({ onOpen, onError }: { onOpen: () => void; onError: (m: string) => void }) {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<{ filename: string; reason: string }[]>([]);

  const refresh = useCallback(() => {
    api.bundles().then(setBundles).catch((e: Error) => onError(e.message));
  }, [onError]);

  useEffect(refresh, [refresh]);

  return (
    <div className="page">
      <div className="card">
        <h2>New bundle</h2>
        <p className="muted">One client, one bundle. Use this when a packet spans several files.</p>
        <input placeholder="Client / bundle label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input
          type="file"
          multiple
          accept="application/pdf,image/*"
          disabled={busy}
          onChange={(e) => {
            if (!e.target.files?.length) return;
            setBusy(true);
            api
              .upload(label || 'Untitled bundle', e.target.files)
              .then(refresh)
              .catch((err: Error) => onError(err.message))
              .finally(() => setBusy(false));
          }}
        />
      </div>

      <div className="card">
        <h2>Bulk upload</h2>
        <p className="muted">
          One bundle per file, for a folder of client packets. Each is named from its filename
          and renamed to the taxpayer once identity is proposed, so there is nothing to type.
        </p>
        <input
          type="file"
          multiple
          accept="application/pdf,image/*"
          disabled={busy}
          onChange={(e) => {
            if (!e.target.files?.length) return;
            setBusy(true);
            setRejected([]);
            api
              .uploadBulk(e.target.files)
              .then((r) => {
                setRejected(r.rejected);
                refresh();
              })
              .catch((err: Error) => onError(err.message))
              .finally(() => setBusy(false));
          }}
        />
        {busy && <p className="muted">Uploading…</p>}
        {rejected.length > 0 && (
          <div className="warn-note">
            <strong>{rejected.length} file(s) were not ingested.</strong> The rest went through.
            <ul>
              {rejected.map((r) => (
                <li key={r.filename}>
                  {r.filename}: {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
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
  const [taxpayers, setTaxpayers] = useState<
    { taxpayerId: string; displayName: string | null; tinLast4: string; role: string; proposed: boolean }[]
  >([]);
  const [confirming, setConfirming] = useState(false);

  const refreshBundle = useCallback(() => {
    api
      .bundle(bundleId)
      .then((data) => {
        setBundle(data.bundle);
        setDocuments(data.documents);
        setChecks(data.checks);
        setBlocking(data.blocking);
        setRouterDown(data.routerDown);
        setTaxpayers(data.taxpayers);
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
        <button
          title="Re-run the pipeline over the page images already stored. Costs inference."
          onClick={() => {
            api
              .reprocess(bundleId, 'classify')
              .then(refreshBundle)
              .catch((e: Error) => onError(e.message));
          }}
        >
          Reprocess
        </button>
      </div>

      {/*
        The §7 gate. Nothing extracts until a human confirms who this bundle belongs to, so a
        bundle sitting at awaiting_identity_confirmation has no field values and a worksheet
        of empty lines. That is correct behaviour with no way to clear it until this panel
        exists, which is why it is a banner rather than something tucked in a side pane.
      */}
      {bundle?.status === 'awaiting_identity_confirmation' && (
        <div className="banner blocking identity-gate">
          <strong>Confirm who this bundle belongs to before anything is extracted.</strong>
          <p className="muted">
            Proposed from the documents. Names are a tiebreaker, never the key — the join key is
            a salted hash of the taxpayer identification number.
          </p>
          {taxpayers.length === 0 && (
            <p className="warn-note">
              No taxpayer identification number could be read from these documents, so there is
              nobody to propose. This is normal for scanned or photographed pages, where the
              numbers are pixels until the layout pass runs. Confirming the tax year alone
              starts extraction, and the client is proposed again from what it reads.
            </p>
          )}
          <table className="grid">
            <thead>
              <tr><th>Name</th><th>TIN</th><th>Role</th></tr>
            </thead>
            <tbody>
              {taxpayers.map((t) => (
                <tr key={t.taxpayerId}>
                  <td>{t.displayName ?? <em className="muted">no name on the documents</em>}</td>
                  <td>•••-••-{t.tinLast4}</td>
                  <td>
                    <select
                      value={t.role}
                      onChange={(e) =>
                        setTaxpayers((prev) =>
                          prev.map((p) =>
                            p.taxpayerId === t.taxpayerId ? { ...p, role: e.target.value } : p,
                          ),
                        )
                      }
                    >
                      <option value="primary">Primary</option>
                      <option value="spouse">Spouse</option>
                      <option value="other">Other</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Tax year <strong>{bundle.taxYear ?? 'not detected'}</strong>, the majority across these
            documents. Any document with a different year is flagged.
          </p>
          <button
            /*
             * Deliberately NOT disabled on an empty taxpayer list. Requiring a proposed
             * taxpayer is what turned a missing proposal into a bundle nobody could move,
             * and §7's gate is that a human looked — the client can be confirmed on the
             * refined proposal after extraction.
             */
            disabled={confirming || bundle.taxYear === null}
            onClick={() => {
              setConfirming(true);
              api
                .confirmIdentity(
                  bundleId,
                  bundle.taxYear!,
                  taxpayers.map((t) => ({ taxpayerId: t.taxpayerId, role: t.role })),
                )
                .then(refreshBundle)
                .catch((e: Error) => onError(e.message))
                .finally(() => setConfirming(false));
            }}
          >
            {confirming
              ? 'Confirming…'
              : taxpayers.length
                ? 'Confirm and start extraction'
                : 'Confirm tax year and start extraction'}
          </button>
        </div>
      )}

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
