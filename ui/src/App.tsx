import { Fragment, useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { LoginPanel } from '@kisaesdevlab/vibe-auth/react';
import { api, formatCents } from './api';
import { FieldEditor } from './components/FieldEditor';
import { PageOverlay } from './components/PageOverlay';
import { Admin } from './components/Admin';
import type {
  Bundle,
  CheckRow,
  DocumentRow,
  FactorState,
  FieldRow,
  PageRow,
  BundleProgress,
  QueueFailure,
  RouterJobRow,
  SpanRow,
  WorksheetLine,
  WorksheetRow,
} from './types';

type View = 'login' | 'login-local' | 'mfa' | 'forgot' | 'bundles' | 'review' | 'admin';

/**
 * The break-glass sign-in (P16). This app has no router, so the one URL that matters is read
 * off the location: when the firm runs single sign-on only, the local form is hidden from
 * everyone and this path is how the emergency account reaches it.
 */
const BREAKGLASS_PATH = '/login/local';
const signInView = (): View => (window.location.pathname === BREAKGLASS_PATH ? 'login-local' : 'login');

export default function App() {
  const [view, setView] = useState<View>(signInView);
  const [me, setMe] = useState<{ displayName: string; role: string; sso: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then((u) => {
        setMe(u);
        setView('bundles');
      })
      .catch(() => setView(signInView()));
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
                // A session born at the identity provider is ended through Vibe Auth, so its
                // sign-out is audited under the same name as its sign-in. `local=1` ends this
                // app's session only: signing out of Vibe 1040 should not sign the user out
                // of every other Vibe product they have open.
                if (me.sso) {
                  window.location.assign('/auth/oidc/logout?local=1');
                  return;
                }
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

      {(view === 'login' || view === 'login-local') && (
        <Login
          breakglass={view === 'login-local'}
          onNext={() => setView('mfa')}
          onForgot={() => setView('forgot')}
          onError={setError}
        />
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
      {view === 'admin' && <Admin role={me?.role ?? 'staff'} onError={setError} />}
    </div>
  );
}

// ── auth ─────────────────────────────────────────────────────────────────────

function Login({
  breakglass,
  onNext,
  onForgot,
  onError,
}: {
  breakglass: boolean;
  onNext: () => void;
  onForgot: () => void;
  onError: (m: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const go = () => api.login(email, password).then(onNext).catch((e: Error) => onError(e.message));

  return (
    <div className="centered card">
      <h1>{breakglass ? 'Emergency sign in' : 'Sign in'}</h1>
      {/*
        LoginPanel reads /auth/status. With single sign-on off it renders the form below and
        nothing else, so a firm that never turns SSO on sees exactly what it saw before. In
        `both` it adds the identity-provider button; in `oidc_only` it hides the form, except
        on the break-glass path.
      */}
      <LoginPanel
        basePath=""
        returnTo="/"
        breakglass={breakglass}
        classNames={{ root: 'sso-panel', button: 'button sso-button', divider: 'sso-divider muted', note: 'muted sso-note' }}
      >
        <p className="muted">
          {breakglass
            ? 'For the emergency account, when single sign-on is unavailable. A second factor is ' +
              'still required: this account uses an authenticator app like any other.'
            : 'Staff access only. A second factor is always required. An authenticator app needs ' +
              'nothing set up by the firm, so you can enrol one on this sign-in.'}
        </p>
        <input
          placeholder={breakglass ? 'username' : 'email'}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void go(); }}
        />
        <button onClick={() => void go()}>Continue</button>
        {!breakglass && <button className="link" onClick={onForgot}>Forgot your password?</button>}
      </LoginPanel>
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
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [year, setYear] = useState('');

  const refresh = useCallback(() => {
    api
      .bundles({
        q: query || undefined,
        status: status || undefined,
        taxYear: year ? Number(year) : undefined,
      })
      .then(setBundles)
      .catch((e: Error) => onError(e.message));
  }, [onError, query, status, year]);

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
        <div className="filters">
          <input
            placeholder="Search label, client name, or last four digits"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {[
              'uploaded',
              'triaging',
              'classifying',
              'extracting',
              'reconciling',
              'awaiting_identity_confirmation',
              'blocked',
              'in_review',
              'ready',
              'failed',
            ].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <input
            className="year"
            placeholder="Tax year"
            inputMode="numeric"
            value={year}
            onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
          {(query || status || year) && (
            <button
              className="link"
              onClick={() => {
                setQuery('');
                setStatus('');
                setYear('');
              }}
            >
              Clear
            </button>
          )}
          <span className="muted">{bundles.length} shown</span>
        </div>
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
                  {/*
                    Typing the label back is the guard, not a confirm dialog. There is no undo:
                    the client's documents leave object storage rather than being flagged.
                  */}
                  <button
                    className="danger"
                    onClick={() => {
                      const typed = window.prompt(
                        `Deleting "${b.label}" removes its documents, page images and worksheets ` +
                          'permanently. There is no undo.\n\nType the label to confirm:',
                      );
                      if (typed === null) return;
                      api
                        .deleteBundle(b.id, typed)
                        .then(refresh)
                        .catch((e: Error) => onError(e.message));
                    }}
                  >
                    Delete
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
  const [routerJobs, setRouterJobs] = useState<RouterJobRow[]>([]);
  const [worksheets, setWorksheets] = useState<WorksheetRow[]>([]);
  const [progress, setProgress] = useState<BundleProgress | null>(null);
  const [queueFailures, setQueueFailures] = useState<QueueFailure[]>([]);
  const [sorting, setSorting] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ pages: PageRow[]; fields: FieldRow[]; spans: SpanRow[] } | null>(null);
  const [selectedField, setSelectedField] = useState<FieldRow | null>(null);
  const [lines, setLines] = useState<WorksheetLine[]>([]);
  const [docLabels, setDocLabels] = useState<Record<string, string>>({});
  const [taxpayers, setTaxpayers] = useState<
    { taxpayerId: string; displayName: string | null; tinLast4: string; role: string; proposed: boolean }[]
  >([]);
  const [confirming, setConfirming] = useState(false);
  const [yearInput, setYearInput] = useState<string>('');
  useEffect(() => setYearInput(bundle?.taxYear?.toString() ?? ''), [bundle?.taxYear]);

  const refreshBundle = useCallback(() => {
    api
      .bundle(bundleId)
      .then((data) => {
        setBundle(data.bundle);
        setDocuments(data.documents);
        setChecks(data.checks);
        setBlocking(data.blocking);
        setRouterDown(data.routerDown);
        setRouterJobs(data.routerJobs);
        setWorksheets(data.worksheets);
        setProgress(data.progress);
        setQueueFailures(data.queueFailures);
        setTaxpayers(data.taxpayers);
      })
      .catch((e: Error) => onError(e.message));
    api
      .worksheetPreview(bundleId)
      .then((p) => {
        setLines(p.model.lines);
        setDocLabels(p.documentLabels ?? {});
      })
      .catch(() => setLines([]));
  }, [bundleId, onError]);

  useEffect(refreshBundle, [refreshBundle]);
  useEffect(() => {
    const running = bundle && ['triaging', 'classifying', 'extracting', 'reconciling'].includes(bundle.status);
    if (!running) return undefined;
    const t = setInterval(refreshBundle, 8000);
    return () => clearInterval(t);
  }, [bundle?.status, refreshBundle]);

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
        {progress && bundle && ['classifying', 'extracting', 'reconciling'].includes(bundle.status) && (
          <span
            className="pill"
            title={`${progress.pagesFromTextLayer} page(s) with exact text-layer geometry, ${progress.pagesFromModel} laid out by the vision model. Refreshes every 8 s while running.`}
          >
            layout {progress.pagesLaidOut}/{progress.pages} pages · binding {progress.documentsDone}/{progress.documents} documents
          </span>
        )}
        {queueFailures.length > 0 && (
          <span
            className="pill error"
            title={queueFailures.map((f) => `${f.kind} (${f.attemptsMade} attempts): ${f.error}`).join('\n')}
          >
            {queueFailures.length} pipeline job(s) died — {queueFailures[0]!.error.slice(0, 80)}
          </span>
        )}
        {routerJobs.some((j) => j.state === 'failed') && (
          <span className="pill error" title={routerJobs.filter((j) => j.state === 'failed').map((j) => `${j.taskClass}: ${j.lastErrorCode ?? '?'} — ${j.lastErrorMessage ?? ''}`).join('\n')}>
            {routerJobs.filter((j) => j.state === 'failed').length} router job(s) failed
          </span>
        )}
        {(routerJobs.length > 0 || queueFailures.length > 0) && (
          <button
            disabled={requeueing}
            title="Send every parked or failed router job for this bundle back to the queue, at the stage it stopped in. Costs inference."
            onClick={() => {
              setRequeueing(true);
              api
                .requeueRouterJobs(bundleId)
                .then(refreshBundle)
                .catch((e: Error) => onError(e.message))
                .finally(() => setRequeueing(false));
            }}
          >
            {requeueing ? 'Requeueing…' : `Retry ${routerJobs.length + queueFailures.length} parked/failed job(s)`}
          </button>
        )}
        <div className="spacer" />
        <button
          disabled={
            blocking.length > 0 ||
            !bundle?.identityConfirmedAt ||
            ['triaging', 'classifying', 'extracting', 'reconciling'].includes(bundle?.status ?? '')
          }
          title={
            ['triaging', 'classifying', 'extracting', 'reconciling'].includes(bundle?.status ?? '')
              ? 'Extraction is still running; a worksheet now would be blank'
              : blocking.length > 0
                ? 'Disposition the hard failures first'
                : !bundle?.identityConfirmedAt
                  ? 'Confirm which client this bundle belongs to first'
                  : 'Generate the worksheet'
          }
          onClick={() => {
            api
              .generateWorksheet(bundleId)
              .then(() => refreshBundle())
              .catch((e: Error) => onError(e.message));
          }}
        >
          {worksheets.length ? 'Regenerate worksheet' : 'Generate worksheet'}
        </button>
        <button
          disabled={sorting}
          title="Build a PDF of every source page in return order — wages, interest, dividends, retirement … — with a bookmark naming each form and issuer."
          onClick={() => {
            setSorting(true);
            api
              .buildSortedPdf(bundleId)
              .then(() => {
                refreshBundle();
                window.location.assign(`/api/bundles/${bundleId}/sorted-pdf`);
              })
              .catch((e: Error) => onError(e.message))
              .finally(() => setSorting(false));
          }}
        >
          {sorting ? 'Sorting…' : bundle?.sortedPdfAt ? 'Rebuild sorted PDF' : 'Sorted PDF'}
        </button>
        {bundle?.sortedPdfAt && !sorting && (
          <a className="button" href={`/api/bundles/${bundleId}/sorted-pdf`} download title={`Built ${new Date(bundle.sortedPdfAt).toLocaleString()}`}>
            Download sorted PDF
          </a>
        )}
        {worksheets[0] && (
          <span className="downloads" title={`Generated ${new Date(worksheets[0].createdAt).toLocaleString()}${worksheets[0].generatedByName ? ` by ${worksheets[0].generatedByName}` : ''}`}>
            {worksheets[0].hasXlsx && (
              <a className="button" href={`/api/worksheets/${worksheets[0].id}/xlsx`} download>
                Download Excel
              </a>
            )}
            {worksheets[0].hasPdf && (
              <a className="button" href={`/api/worksheets/${worksheets[0].id}/pdf`} download>
                Download PDF
              </a>
            )}
            {worksheets.length > 1 && <span className="muted"> ({worksheets.length - 1} earlier)</span>}
          </span>
        )}
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
      {bundle && !bundle.identityConfirmedAt && (
        <div className="banner blocking identity-gate">
          <strong>Confirm who this bundle belongs to before generating a worksheet.</strong>
          <p className="muted">
            Proposed from the documents, and refined by what extraction actually read. Names are
            a tiebreaker, never the key — the join key is a salted hash of the taxpayer
            identification number. Extraction has already run; this decides whose return the
            worksheet says these numbers belong to.
          </p>
          {(bundle.identityHints ?? []).filter((h) => !taxpayers.some((t) => t.tinLast4 === h.last4)).length > 0 && (
            <div className="identity-hints">
              <strong>The documents show a number this app cannot use as a key:</strong>
              <ul>
                {(bundle.identityHints ?? [])
                  .filter((h) => !taxpayers.some((t) => t.tinLast4 === h.last4))
                  .map((h) => (
                    <li key={h.last4}>
                      •••-••-{h.last4}
                      {h.name ? ` — ${h.name}` : ''}
                      {h.formType ? ` (${h.formType})` : ''}
                      {h.source === 'text_layer' ? ', masked on the form' : ', read from the page but not hashable'}
                    </li>
                  ))}
              </ul>
              <span className="muted">Type the full nine-digit number below to attribute this bundle. Only the last four are kept.</span>
            </div>
          )}
          {taxpayers.length === 0 && !(bundle.identityHints ?? []).length && (
            <p className="warn-note">
              No taxpayer identification number could be read from these documents, so there is
              nobody to propose. Add the client below, or confirm the tax year alone — a
              worksheet can then be produced, but it will not be attributed to a client.
            </p>
          )}
          <TaxpayerEditor
            bundleId={bundleId}
            taxpayers={taxpayers}
            onRoleChange={(taxpayerId, role) =>
              setTaxpayers((prev) => prev.map((p) => (p.taxpayerId === taxpayerId ? { ...p, role } : p)))
            }
            onChanged={refreshBundle}
            onError={onError}
          />
          <p className="muted">
            Tax year{' '}
            <input
              value={yearInput}
              onChange={(e) => setYearInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              placeholder="20xx"
              size={5}
              title="Proposed as the majority year across the documents. Change it if the documents say otherwise; each document's own year can be corrected in its Fields pane."
            />
            {bundle.taxYear !== null && yearInput !== bundle.taxYear.toString() && (
              <span className="pill warn"> proposed {bundle.taxYear}</span>
            )}
            . Any document with a different year is flagged.
          </p>
          <button
            /*
             * Deliberately NOT disabled on an empty taxpayer list. Requiring a proposed
             * taxpayer is what turned a missing proposal into a bundle nobody could move,
             * and §7's gate is that a human looked — the client can be confirmed on the
             * refined proposal after extraction.
             */
            disabled={confirming || yearInput.length !== 4}
            onClick={() => {
              setConfirming(true);
              api
                .confirmIdentity(
                  bundleId,
                  Number(yearInput),
                  taxpayers.map((t) => ({ taxpayerId: t.taxpayerId, role: t.role })),
                )
                .then(refreshBundle)
                .catch((e: Error) => onError(e.message))
                .finally(() => setConfirming(false));
            }}
          >
            {confirming ? 'Confirming…' : 'Confirm client and tax year'}
          </button>
        </div>
      )}

      {bundle?.identityConfirmedAt && (
        <details className="taxpayers-strip">
          <summary>
            Client: {taxpayers.length ? taxpayers.map((t) => `${t.displayName ?? 'unnamed'} (…${t.tinLast4}, ${t.role})`).join('; ') : 'nobody attributed'}
            {' '}· tax year {bundle.taxYear ?? '?'} — edit
          </summary>
          <TaxpayerEditor
            bundleId={bundleId}
            taxpayers={taxpayers}
            onRoleChange={(taxpayerId, role) => {
              api.updateTaxpayer(bundleId, taxpayerId, { role }).then(refreshBundle).catch((e: Error) => onError(e.message));
            }}
            onChanged={refreshBundle}
            onError={onError}
          />
        </details>
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
          {documents.map((d, i) => (
            <Fragment key={d.id}>
            {d.group && d.group !== documents[i - 1]?.group && <div className="doc-group">{d.group}</div>}
            <button
              className={d.id === activeDoc ? 'doc active' : 'doc'}
              onClick={() => openDoc(d.id)}
            >
              <span className="doc-type">{d.formType ?? 'unclassified'}</span>
              {d.payerName && <span className="doc-payer">{d.payerName}</span>}
              <span className="doc-flags">
                {d.corrected && <span className="pill warn">CORRECTED</span>}
                {d.void && <span className="pill warn">VOID</span>}
                {d.taxYearMismatch && <span className="pill warn">year {d.taxYear}</span>}
                {d.sectionCode && <span className="pill">section {d.sectionCode}</span>}
                {d.parentDocumentId && <span className="pill">sub-form</span>}
                {d.extractionOutcome === 'no_schema' && <span className="pill error">no schema</span>}
                {d.extractionOutcome === 'no_spans' && <span className="pill error">no text found</span>}
                {d.extractionOutcome === null && d.formType && !d.isSupplemental && (
                  <span className="pill">extracting…</span>
                )}
              </span>
            </button>
            </Fragment>
          ))}

          <h3>Checks</h3>
          {checks.filter((c) => c.outcome === 'fail' && !c.disposition).map((c) => (
            <DispositionRow key={c.id} check={c} onDone={refreshBundle} onError={onError} />
          ))}
          {checks.some((c) => c.outcome === 'fail' && c.disposition) && (
            <details className="decided">
              <summary>{checks.filter((c) => c.outcome === 'fail' && c.disposition).length} decided</summary>
              {checks.filter((c) => c.outcome === 'fail' && c.disposition).map((c) => (
                <div key={c.id} className="check decided">
                  <div className="check-key">{c.checkKey}</div>
                  <div className="check-message muted">
                    {c.disposition!.kind.replace(/_/g, ' ')}
                    {c.disposition!.note ? ` — ${c.disposition!.note}` : ''}
                  </div>
                </div>
              ))}
            </details>
          )}
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
          {activeDoc && (
            <DocumentYearEditor
              document={documents.find((d) => d.id === activeDoc) ?? null}
              bundleYear={bundle?.taxYear ?? null}
              onChanged={refreshDoc}
              onError={onError}
            />
          )}
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
                {line.contributions.length > 0 && (
                  /* Judgment Required opens by default: its total is meaningless without the
                     list of what a preparer has to decide. Other lines open on demand. */
                  <details className="ws-contrib" open={line.isJudgmentRequired}>
                    <summary>{line.contributions.length} contributing box(es)</summary>
                    {line.contributions.map((c, i) => (
                      <div key={`${c.documentId}-${c.fieldKey}-${i}`} className="ws-c">
                        <div className="ws-c-head">
                          <span className="ws-c-field">{c.formType} — {c.fieldLabel}</span>
                          <span className="ws-c-amount">{c.valueCents === null ? 'blank' : formatCents(c.valueCents)}</span>
                        </div>
                        <div className="ws-c-src">
                          {docLabels[c.documentId] ?? c.documentId}
                          {c.wasCorrected ? ' · corrected' : ''}
                          {c.informational ? ' · informational' : ''}
                        </div>
                        {c.judgmentReason && <div className="ws-c-why">{c.judgmentReason}</div>}
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
        </aside>
      </div>
    </div>
  );
}

/**
 * Who this bundle belongs to, editable. Names are a tiebreaker and can be typed or fixed;
 * a TIN is the join key and is typed in full, hashed on the server, and never shown again
 * beyond its last four (§7). A wrongly proposed person can be taken off the bundle.
 */
function TaxpayerEditor({
  bundleId,
  taxpayers,
  onRoleChange,
  onChanged,
  onError,
}: {
  bundleId: string;
  taxpayers: { taxpayerId: string; displayName: string | null; tinLast4: string; role: string; proposed: boolean }[];
  onRoleChange: (taxpayerId: string, role: string) => void;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState('');
  const [tin, setTin] = useState('');
  const [role, setRole] = useState('primary');
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    setNames(Object.fromEntries(taxpayers.map((t) => [t.taxpayerId, t.displayName ?? ''])));
  }, [taxpayers]);

  const saveName = (t: (typeof taxpayers)[number]) => {
    const next = (names[t.taxpayerId] ?? '').trim();
    if (next === (t.displayName ?? '')) return;
    api
      .updateTaxpayer(bundleId, t.taxpayerId, { displayName: next || null })
      .then(onChanged)
      .catch((e: Error) => onError(e.message));
  };

  return (
    <div className="taxpayer-editor">
      <table className="grid">
        <thead>
          <tr><th>Name</th><th>TIN</th><th>Role</th><th /></tr>
        </thead>
        <tbody>
          {taxpayers.map((t) => (
            <tr key={t.taxpayerId}>
              <td>
                <input
                  value={names[t.taxpayerId] ?? ''}
                  placeholder="no name on the documents"
                  onChange={(e) => setNames((prev) => ({ ...prev, [t.taxpayerId]: e.target.value }))}
                  onBlur={() => saveName(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
                {t.proposed && <span className="pill" title="Read from the documents; not yet confirmed"> proposed</span>}
              </td>
              <td>•••-••-{t.tinLast4}</td>
              <td>
                <select value={t.role} onChange={(e) => onRoleChange(t.taxpayerId, e.target.value)}>
                  <option value="primary">Primary</option>
                  <option value="spouse">Spouse</option>
                  <option value="other">Other</option>
                </select>
              </td>
              <td>
                <button
                  className="link"
                  title="Take this person off the bundle. The documents assigned to them are unassigned."
                  onClick={() =>
                    api.removeTaxpayer(bundleId, t.taxpayerId).then(onChanged).catch((e: Error) => onError(e.message))
                  }
                >
                  remove
                </button>
              </td>
            </tr>
          ))}
          <tr className="taxpayer-add">
            <td>
              <input value={name} placeholder="Name (optional)" onChange={(e) => setName(e.target.value)} />
            </td>
            <td>
              <input
                value={tin}
                placeholder="SSN or ITIN, all nine digits"
                inputMode="numeric"
                autoComplete="off"
                onChange={(e) => setTin(e.target.value)}
                title="Hashed on the server with the firm's salt; only the last four are ever stored or shown."
              />
            </td>
            <td>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="primary">Primary</option>
                <option value="spouse">Spouse</option>
                <option value="other">Other</option>
              </select>
            </td>
            <td>
              <button
                disabled={busy || tin.replace(/\D/g, '').length !== 9}
                onClick={() => {
                  setBusy(true);
                  api
                    .addTaxpayer(bundleId, { displayName: name.trim() || undefined, tin, role })
                    .then(() => {
                      setName('');
                      setTin('');
                      onChanged();
                    })
                    .catch((e: Error) => onError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
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
      {check.severity === 'hard' ? (
        open ? (
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
        )
      ) : (
        /* A soft failure annotates the worksheet either way; acknowledging it just clears it
           from this list, and the acknowledgement is carried across re-runs. */
        <div className="check-actions">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" />
          <button
            title="Mark this annotation as seen. It stays on the worksheet."
            onClick={() =>
              api
                .disposition(check.id, 'accepted_as_is', note)
                .then(onDone)
                .catch((e: Error) => onError(e.message))
            }
          >
            Acknowledge
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The classifier reads a form's revision date ("Rev. January 2024") as its tax year often
 * enough that the reviewer needs to fix it in place. Saving re-runs reconcile so the
 * year-mismatch and schema-substitution annotations follow the correction.
 */
function DocumentYearEditor({
  document,
  bundleYear,
  onChanged,
  onError,
}: {
  document: DocumentRow | null;
  bundleYear: number | null;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [value, setValue] = useState<string>(document?.taxYear?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(document?.taxYear?.toString() ?? ''), [document?.id, document?.taxYear]);
  if (!document) return null;
  const changed = value !== (document.taxYear?.toString() ?? '');
  return (
    <div className="doc-year">
      <label>
        Tax year{' '}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
          placeholder={bundleYear?.toString() ?? '20xx'}
          size={5}
        />
      </label>
      {document.taxYearMismatch && (
        <span className="pill warn" title="Differs from the bundle's majority year">mismatch</span>
      )}
      <button
        disabled={!changed || saving || (value !== '' && value.length !== 4)}
        onClick={() => {
          setSaving(true);
          api
            .correctDocumentYear(document.id, value === '' ? null : Number(value))
            .then(onChanged)
            .catch((e: Error) => onError(e.message))
            .finally(() => setSaving(false));
        }}
      >
        {saving ? 'Saving…' : 'Save year'}
      </button>
    </div>
  );
}
