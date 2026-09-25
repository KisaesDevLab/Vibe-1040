import { useCallback, useEffect, useState } from 'react';
import { AuthSettingsPage } from '@kisaesdevlab/vibe-auth/react';
import { api } from '../api';
import type {
  AuditRow,
  DraftEngineReadiness,
  EnvSetting,
  SettingRow,
  EngineReleaseCheck,
  StagedEngineReport,
  UserRow,
} from '../types';

/**
 * Admin section — Settings, Users, Audit, Retention.
 *
 * Firm policy is editable here and audited. Infrastructure and key material are shown
 * read-only, because a web form is the wrong place for a decryption key and the
 * compliance guardrails should not be a switch.
 */
type Tab = 'settings' | 'users' | 'audit' | 'retention' | 'authentication' | 'engine';

const GROUP_LABELS: Record<string, string> = {
  reconciliation: 'Reconciliation',
  retention: 'Retention',
  extraction: 'AI extraction and pipeline',
  rasterization: 'Rasterization',
  email: 'Email delivery',
  sms: 'SMS delivery',
  authentication: 'Authentication',
  licensing: 'Licensing',
  engine: 'Engine and pipeline',
};

export function Admin({ role, onError }: { role: string; onError: (m: string) => void }) {
  const [tab, setTab] = useState<Tab>('settings');
  // Single sign-on is admin-only, server-side too; a partner sees the audit trail, not this.
  const tabs: Tab[] = [
    'settings',
    'users',
    'audit',
    'retention',
    ...(role === 'admin' ? (['authentication', 'engine'] as Tab[]) : []),
  ];
  return (
    <div className="admin">
      <nav className="admin-tabs">
        {tabs.map((t) => (
          <button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t === 'engine' ? 'Draft engine' : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === 'settings' && <SettingsTab onError={onError} />}
      {tab === 'users' && <UsersTab onError={onError} />}
      {tab === 'audit' && <AuditTab onError={onError} />}
      {tab === 'retention' && <RetentionTab onError={onError} />}
      {tab === 'authentication' && <AuthenticationTab />}
      {tab === 'engine' && <DraftEngineTab onError={onError} />}
    </div>
  );
}

// ── authentication (single sign-on) ──────────────────────────────────────────

/**
 * Vibe Auth's own settings page: sign-in mode, identity provider, role map, connection test,
 * break-glass status. It talks to /auth/settings, not to this app's settings store.
 *
 * Two things differ from the other Vibe products and are said here so nobody goes looking:
 *
 * - **The MFA switch does nothing.** The page offers to stop requiring proof of a second
 *   factor; this app refuses that request (§11). It is always required.
 * - **The connection-test popup does not report back by itself.** Its result page uses an
 *   inline script, which this app's Content-Security-Policy blocks on purpose. The result is
 *   still recorded server-side, so there is a button to re-read it. Deliberately a button and
 *   not a reload on window focus: the page keeps the issuer, client id and secret being typed
 *   in its own state, and an admin copying those from another window would lose them every
 *   time they switched back.
 */
function AuthenticationTab() {
  const [reload, setReload] = useState(0);

  return (
    <div className="card">
      <p className="muted">
        Staff can sign in through the firm&rsquo;s identity provider instead of a local password.
        Vibe 1040 always requires proof of a second factor from the identity provider; that
        requirement cannot be turned off here.
      </p>
      <p className="muted">
        After a connection test, close its window and{' '}
        <button className="link" onClick={() => setReload((n) => n + 1)}>
          re-read the result
        </button>
        . This discards anything typed below that has not been saved.
      </p>
      <AuthSettingsPage key={reload} basePath="" productName="Vibe 1040" />
    </div>
  );
}

// ── draft engine (P17) ───────────────────────────────────────────────────────

/**
 * The draft-return engine's upgrade picture, and a button to re-read it.
 *
 * **It reports; it never upgrades.** There is no install button here on purpose. The engine's
 * version is pinned and its download verified by SHA-256 when the sidecar image is built,
 * precisely so that nothing can swap the binary afterwards — a button that replaced it would
 * be `install.sh | sh` with better manners, which is what CLAUDE.md §14 forbids. An upgrade is
 * a deliberate act by an operator, recorded in the image build; the procedure is in
 * docs/opentax-draft-return.md. What this page can do is tell you, without a shell, whether
 * you need to perform it and what is broken if you already have.
 *
 * The check it shows exists for one failure in particular. An engine field renamed between
 * releases is refused loudly when it is *required* — but when it is *optional* the engine
 * accepts the payload and ignores it, so the amount never arrives and the line reads as
 * absent. Absent is exactly what "the documents reported nothing here" looks like, so nobody
 * goes looking. Comparing the names before sending is what turns that into an upgrade-time
 * error.
 */
function DraftEngineTab({ onError }: { onError: (m: string) => void }) {
  const [state, setState] = useState<DraftEngineReadiness | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    api
      .draftEngine()
      .then(setState)
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  }, [onError]);

  useEffect(load, [load]);

  if (!state) {
    return (
      <div className="card">
        <p className="muted">{busy ? 'Reading the engine…' : 'No answer yet.'}</p>
      </div>
    );
  }

  if (!state.enabled) {
    return (
      <div className="card">
        <h3>Draft return engine</h3>
        <p className="muted">
          The draft return is switched off for this firm, so there is no engine to report on.
          Turn it on under <strong>Settings → Engine and pipeline</strong>. It takes effect
          immediately and the change is recorded against your account, because it changes what
          the app computes about a taxpayer.
        </p>
      </div>
    );
  }

  const check = state.check;
  const blocking = check?.blocking.length ?? 0;
  const advisory = (check?.findings.length ?? 0) - blocking;

  return (
    <div className="card">
      <h3>Draft return engine</h3>
      <p className="muted">
        OpenTax runs on this appliance as a separate process and computes the draft return. This
        page reports what is running and whether this app&rsquo;s node map still matches it.{' '}
        <strong>It cannot install or change the engine</strong> — the version is pinned and
        checksum-verified when the image is built, and an upgrade is a deliberate step an
        operator takes. See <code>docs/opentax-draft-return.md</code>.
      </p>

      <table className="engine-pins">
        <tbody>
          <tr>
            <th>Running</th>
            <td>
              {state.engine.ok ? (
                <strong>{state.engine.version}</strong>
              ) : (
                <span className="pill warn">unreachable — {state.engine.reason ?? 'no reason given'}</span>
              )}
            </td>
          </tr>
          <tr>
            <th>
              <code>OPENTAX_VERSION</code>
            </th>
            <td>{state.pins.environment}</td>
          </tr>
          <tr>
            <th>Node map {state.pins.nodeMapVersion ?? '—'}</th>
            <td>written against {state.pins.nodeMap ?? '—'}</td>
          </tr>
        </tbody>
      </table>

      <LatestRelease />

      {state.engine.ok && !state.versionsAgree && (
        <p className="engine-bad">
          The running engine does not match both pins. A node map written against one release
          and run against another can move an amount onto the wrong line, so treat every figure
          as suspect until this agrees.
        </p>
      )}

      {state.error && <p className="engine-bad">Could not read the engine&rsquo;s catalogue: {state.error}</p>}

      {check && (
        <>
          <p className={blocking > 0 ? 'engine-bad' : 'engine-good'}>
            {blocking === 0 && advisory === 0
              ? `Every field name the node map sends exists on engine ${check.engineVersion}, across all ${check.nodeTypes.length} node types.`
              : `${blocking} blocking and ${advisory} advisory mismatch(es) against engine ${check.engineVersion}.`}
            {blocking > 0 && ' Draft returns are withheld until this is resolved. The worksheet is unaffected.'}
          </p>

          {check.findings.map((f, i) => (
            <div key={`${f.nodeType}-${f.engineField ?? i}`} className={`engine-finding engine-${f.severity}`}>
              <div className="engine-finding-head">
                <span>
                  {f.formType} → <code>{f.nodeType}{f.engineField ? `.${f.engineField}` : ''}</code>
                </span>
                <span className="draft-reason">{f.severity} · {f.kind.replace(/_/g, ' ')}</span>
              </div>
              <div className="draft-omission-why">{f.detail}</div>
            </div>
          ))}
        </>
      )}

      <button type="button" className="engine-recheck" onClick={load} disabled={busy}>
        {busy ? 'Checking…' : 'Check again'}
      </button>
      <p className="draft-hint">
        A name check, not a behaviour check. It cannot see a field that kept its name and
        changed its meaning, or arithmetic that moved. Run <code>npm run draft -- --truth</code>{' '}
        for that; an upgrade needs both.
      </p>

      <StagedEngine onError={onError} onActivated={load} />
    </div>
  );
}

/**
 * Staging an upgrade for a person to approve (Q23).
 *
 * The page above reports; this section is the part that acts, and it is deliberately four
 * separate presses rather than one. A caller names an exact version and an exact checksum —
 * there is no "latest" and no list to pick from, because the point of a pin is that somebody
 * chose it. Staging verifies the digest before the binary is ever run and then checks it
 * against the node map's field names, which is the check that catches a renamed *optional*
 * field: the engine would accept it, ignore it, and leave the line reading as absent.
 *
 * **Nothing here serves anything until Activate.** That press is the one act on this page that
 * changes what computes a taxpayer's figures, so it says so, and the outgoing binary is kept so
 * that undoing it is one more press rather than a rebuild.
 */
function StagedEngine({ onError, onActivated }: { onError: (m: string) => void; onActivated: () => void }) {
  const [report, setReport] = useState<StagedEngineReport | null>(null);
  const [version, setVersion] = useState('');
  const [sha256, setSha256] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.stagedEngine().then(setReport).catch(() => setReport(null));
  }, []);
  useEffect(load, [load]);

  const act = (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    fn()
      .then(() => {
        load();
        after?.();
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };

  if (!report) return null;

  // Not configured is the shipped default, and it needs a writable volume and outbound access
  // that are a deployment decision — so the page says that rather than showing dead buttons.
  if (!report.state.allowed) {
    return (
      <div className="staged-engine">
        <h4>Staged upgrade</h4>
        <p className="draft-hint">
          Not configured on this deployment. Staging needs a writable volume on the engine
          container, which ships <code>read_only</code>, and — to download rather than to take a
          file an operator has already placed — outbound access to the release host. Both are
          deployment decisions and both belong in the WISP review. Until then an upgrade is a
          rebuild of the sidecar image, which is what <code>docs/opentax-draft-return.md</code>{' '}
          §7 describes.
        </p>
      </div>
    );
  }

  const staged = report.state.staged;
  const blocking = report.check?.blocking.length ?? 0;

  return (
    <div className="staged-engine">
      <h4>Staged upgrade</h4>

      {staged === null ? (
        <>
          <p className="draft-hint">
            An exact version and an exact SHA-256, from the release you intend to run. There is
            no <em>latest</em>: a pin is only a pin because a person chose it. The digest is
            checked before the binary is ever executed, and a file that fails is deleted.
          </p>
          <div className="pi-new">
            <input placeholder="2.0.5" value={version} onChange={(e) => setVersion(e.target.value)} />
            <input
              placeholder="sha256 (64 hex characters)"
              value={sha256}
              onChange={(e) => setSha256(e.target.value.trim().toLowerCase())}
              size={40}
            />
            <input
              placeholder="https://… or a file already in the staging directory"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              size={44}
            />
            <button
              type="button"
              disabled={busy || version === '' || !/^[0-9a-f]{64}$/.test(sha256) || source === ''}
              onClick={() =>
                act(() =>
                  api.stageEngine({
                    version,
                    sha256,
                    ...(source.startsWith('https://') ? { url: source } : { file: source }),
                  }),
                )
              }
            >
              {busy ? 'Staging…' : 'Stage'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="staged-summary">
            <div>
              <span className="muted">Staged</span> {staged.version ?? 'unreadable'}{' '}
              <span className="muted">· {new Date(staged.stagedAt).toLocaleString()}</span>
            </div>
            <div>
              <span className="muted">Running</span> {report.state.live?.version ?? 'unknown'}
            </div>
            <code className="staged-sha">{staged.sha256}</code>
          </div>

          {report.check !== null && (
            <div className={blocking > 0 ? 'staged-check bad' : 'staged-check good'}>
              {blocking > 0 ? (
                <>
                  <strong>{blocking} blocking finding(s)</strong> against node map{' '}
                  {report.nodeMap?.version}. Activating this would withhold draft returns until
                  the map is updated.
                </>
              ) : (
                <>
                  No blocking findings against node map {report.nodeMap?.version}
                  {report.findings.length > 0 ? `, ${report.findings.length} advisory` : ''}.
                </>
              )}
            </div>
          )}
          {report.findings.map((f) => (
            <div key={f} className="draft-diag">
              {f}
            </div>
          ))}

          <div className="pi-actions">
            <button
              type="button"
              disabled={busy}
              title="Makes the staged binary the one that computes draft returns. The outgoing one is kept."
              onClick={() => act(() => api.activateStagedEngine(), onActivated)}
            >
              {busy ? 'Working…' : `Activate ${staged.version ?? ''}`}
            </button>
            <button type="button" disabled={busy} onClick={() => act(() => api.discardStagedEngine())}>
              Discard
            </button>
          </div>
          <p className="draft-hint">
            Activating changes what computes a taxpayer&rsquo;s figures, and is recorded against
            your account. A name check is still not a behaviour check — run{' '}
            <code>npm run draft -- --truth</code> and <code>npm run draft:conflicts</code> against
            the new engine before trusting a draft it produced.
          </p>
        </>
      )}

      {report.state.previous && (
        <div className="pi-actions">
          <button
            type="button"
            disabled={busy}
            title="Put the binary that was running before the last activation back."
            onClick={() => act(() => api.rollbackEngine(), onActivated)}
          >
            Roll back to the previous engine
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * "Is there a newer OpenTax?" — and deliberately nothing more (Q23's middle option).
 *
 * The temptation with a panel like this is an Upgrade button. There isn't one, and the copy says
 * why rather than leaving it looking unfinished: on this engine a release that renames an
 * *optional* field has its amounts accepted and ignored, so the line reads as absent rather than
 * wrong — which is the one failure this whole app exists to prevent. Being told a release exists
 * removes the argument for floating; installing it unattended would reintroduce the risk the pin
 * was protecting against.
 */
function LatestRelease() {
  const [check, setCheck] = useState<EngineReleaseCheck | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((refresh?: boolean) => {
    setBusy(true);
    api
      .latestEngine(refresh)
      .then(setCheck)
      .catch(() => setCheck(null))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => load(), [load]);

  // Off is the default and is not a fault: say where to turn it on and what it costs.
  if (check && !check.enabled) {
    return (
      <p className="muted engine-latest">
        Release checking is off. Turn it on in <strong>Settings → Engine and pipeline</strong> —
        it opens an outbound connection from the appliance to the release host, which is a
        network-policy decision rather than a default.
      </p>
    );
  }

  if (!check) return <p className="muted engine-latest">{busy ? 'Checking for a newer engine…' : null}</p>;

  return (
    <div className="engine-latest">
      {check.unavailable ? (
        <p className="muted">
          Could not reach the release feed: {check.unavailable}. Nothing is wrong with the running
          engine — this check is a convenience and its absence is not an error.
        </p>
      ) : check.newerAvailable && check.latest ? (
        <>
          <p className="engine-newer">
            <strong>{check.latest.tag}</strong> is available
            {check.latest.publishedAt && <> (published {new Date(check.latest.publishedAt).toLocaleDateString()})</>}
            . This deployment expects <strong>{check.expected}</strong>.
          </p>
          {check.latest.sha256 && (
            <p className="setting-help">
              Published digest for <code>{check.latest.assetName}</code>:{' '}
              <code className="engine-digest">{check.latest.sha256}</code>
              <br />
              {/*
                Said plainly, because a checksum next to a download link reads as proof and this
                one is not: it comes from the same place as the binary. It saves retyping, and the
                checks that actually protect you run later and are unchanged.
              */}
              This digest comes from the same source as the binary, so it is not independent
              verification — it is here to save retyping into the staging form. What protects you
              is that a staged candidate&rsquo;s digest is checked before it is ever run, its own
              field catalogue is checked against the node map, and{' '}
              <code>npm run draft -- --truth</code> measures behaviour rather than names.
            </p>
          )}
          <p className="setting-help">
            <strong>Nothing here installs it.</strong> Upgrading stays the procedure in{' '}
            <code>docs/opentax-draft-return.md</code> §7 — and remember the version has two homes:
            staging moves the running binary, while <code>opentax/pinned.json</code> and the image
            build decide what a redeploy brings back.
          </p>
        </>
      ) : (
        <p className="engine-good">
          {check.latest
            ? `Up to date — ${check.latest.tag} is the newest release and this deployment expects ${check.expected}.`
            : `No newer release reported. This deployment expects ${check.expected}.`}
        </p>
      )}
      {/*
        Not "Check again": the catalogue check directly below this had that label already, and
        rendering the two together put two identically-named buttons one above the other doing
        entirely different things — one asks a third party what exists, the other runs the local
        binary. Found by looking at it.
      */}
      <button type="button" disabled={busy} onClick={() => load(true)}>
        {busy ? 'Checking…' : 'Check for releases'}
      </button>
    </div>
  );
}

// ── settings ─────────────────────────────────────────────────────────────────

function SettingsTab({ onError }: { onError: (m: string) => void }) {
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [env, setEnv] = useState<EnvSetting[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  /**
   * Which pending acknowledgements the admin has ticked.
   *
   * Inline rather than a `window.confirm`: the text says which question is still open and what
   * gets recorded, and a native dialog renders it as an unstyled wall that people click through
   * without reading. Cleared on every load so it can never carry over to a later change.
   */
  const [acked, setAcked] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    api
      .adminSettings()
      .then((d) => {
        setRows(d.settings);
        setEnv(d.environment);
        setDraft(Object.fromEntries(d.settings.map((s) => [s.key, s.value])));
        setAcked({});
      })
      .catch((e: Error) => onError(e.message));
  }, [onError]);

  useEffect(load, [load]);

  const dirty = rows.filter((r) => JSON.stringify(draft[r.key]) !== JSON.stringify(r.value));

  /**
   * Which dirty rows need the admin to confirm what they change, before anything is sent.
   *
   * Asked here rather than trusted here — the server refuses an unacknowledged change with a
   * 409 either way (`AcknowledgementRequiredError`), so this dialog is the courtesy and the
   * server check is the control. Only the permissive direction asks: switching a guard back
   * off is the safe direction and must never be made tedious.
   */
  const needsAck = dirty.filter(
    (r) => r.acknowledge !== null && draft[r.key] !== r.value && draft[r.key] !== false,
  );
  /** Every pending acknowledgement ticked? The save button waits on this rather than a dialog. */
  const ackSatisfied = needsAck.every((r) => acked[r.key] === true);

  const save = () => {
    if (!ackSatisfied) return;
    setBusy(true);
    setSaved(false);
    api
      .updateSettings(
        dirty.map((r) => ({
          key: r.key,
          value: draft[r.key],
          ...(needsAck.some((n) => n.key === r.key) ? { acknowledged: true } : {}),
        })),
      )
      .then((d) => {
        setRows(d.settings);
        setDraft(Object.fromEntries(d.settings.map((s) => [s.key, s.value])));
        setAcked({});
        setSaved(true);
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };

  const groups = [...new Set(rows.map((r) => r.group))];

  return (
    <div className="admin-body">
      {groups.map((group) => (
        <section key={group} className="card">
          <h2>{GROUP_LABELS[group] ?? group}</h2>
          {group === 'sms' && (
            <p className="warn-note">
              SMS is the weakest second factor available here — SIM swap and carrier
              interception are real risks that an authenticator app does not have. Prefer TOTP
              where staff will accept it.
            </p>
          )}
          {rows
            .filter((r) => r.group === group)
            .map((r) => (
              <label key={r.key} className="setting">
                <div className="setting-head">
                  <span className="setting-label">{r.label}</span>
                  {r.secret && (
                    <span className={r.isSet ? 'pill ok' : 'pill warn'}>{r.isSet ? 'set' : 'not set'}</span>
                  )}
                  {r.restartRequired && <span className="pill">needs a restart</span>}
                  {r.acknowledge !== null && <span className="pill warn">audited</span>}
                </div>
                <SettingInput
                  row={r}
                  value={draft[r.key]}
                  onChange={(v) => setDraft((d) => ({ ...d, [r.key]: v }))}
                />
                <span className="setting-help">{r.help}</span>
                {r.note && <span className="setting-help">{r.note}</span>}
                {/*
                  Said at the moment it is true, not in a paragraph at the top of the page: this
                  value is read once at boot, so a saved change is pending until someone restarts
                  the API and the worker. A switch that moves and silently changes nothing is the
                  same defect as the filing-status control that rendered dead for a week.
                */}
                {r.restartRequired && JSON.stringify(draft[r.key]) !== JSON.stringify(r.value) && (
                  <span className="warn-note">
                    Saving this stores it, but it does not take effect until the API and the
                    worker restart — the task classes it decides are registered at startup.
                  </span>
                )}

                {/*
                  The acknowledgement, shown where the change is. The server refuses an
                  unacknowledged change with a 409 regardless, so this is not the control — but it
                  is where the admin finds out what they are agreeing to, so it says the specific
                  thing (which question is open, what gets recorded) rather than "are you sure".
                */}
                {needsAck.some((n) => n.key === r.key) && (
                  <div className="setting-ack">
                    <p className="warn-note">{r.acknowledge}</p>
                    <label className="ack-check">
                      <input
                        type="checkbox"
                        checked={acked[r.key] === true}
                        onChange={(e) => setAcked((a) => ({ ...a, [r.key]: e.target.checked }))}
                      />
                      <span>I understand, and this is recorded against my account.</span>
                    </label>
                  </div>
                )}

                {/* Provenance where the switch is, not only in the audit tab. */}
                {r.updatedAt && (
                  <span className="setting-provenance">
                    Changed by {r.updatedBy ?? 'an admin'} on{' '}
                    {new Date(r.updatedAt).toLocaleString()}
                  </span>
                )}
              </label>
            ))}

          {group === 'email' && <TestEmail onError={onError} />}
          {group === 'sms' && <TestSms onError={onError} />}
        </section>
      ))}

      <section className="card">
        <h2>Environment (read-only)</h2>
        <p className="muted">
          Set at provisioning and changed only in <code>.env</code>. Most of what used to be
          here is now editable above, under <strong>Engine and pipeline</strong>. These five are
          not, and for two different reasons &mdash; each row says which:{' '}
          <strong>changing it would destroy or leak this firm&rsquo;s own data</strong> (rotating
          the TIN salt orphans every taxpayer record; the blob key cannot be a setting at all,
          because the secrets in this table are encrypted with it), or{' '}
          <strong>it is the one control §11 names</strong>, asserted at startup and failing
          closed. If one of these should move too, it needs a migration path rather than a
          switch &mdash; say so and it gets one.
        </p>
        {env.map((e) => (
          <div key={e.key} className="env-row">
            <code>{e.key}</code>
            <span className="env-value">{e.value}</span>
            <span className="setting-help">{e.why}</span>
          </div>
        ))}
      </section>

      <div className="save-bar">
        <span>{dirty.length > 0 ? `${dirty.length} unsaved change(s)` : saved ? 'Saved.' : 'No changes.'}</span>
        {/*
          Say what is holding the save, rather than presenting a disabled button with no reason —
          the acknowledgement may be scrolled well off screen in a page this long.
        */}
        {dirty.length > 0 && !ackSatisfied && (
          <span className="warn-note">
            {needsAck.filter((r) => acked[r.key] !== true).map((r) => r.label).join(', ')} needs
            acknowledging above before this can save.
          </span>
        )}
        <button disabled={busy || dirty.length === 0 || !ackSatisfied} onClick={save}>
          Save changes
        </button>
      </div>
    </div>
  );
}

function SettingInput({
  row,
  value,
  onChange,
}: {
  row: SettingRow;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (row.input === 'boolean') {
    return (
      <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
    );
  }
  if (row.input === 'number') {
    return (
      <input
        type="number"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    );
  }
  if (row.input === 'select' && row.options) {
    // The permitted-factors setting is a multi-select; everything else is single.
    if (Array.isArray(value)) {
      return (
        <div className="multi">
          {row.options.map((opt) => (
            <label key={opt} className="chip">
              <input
                type="checkbox"
                checked={(value as string[]).includes(opt)}
                onChange={(e) => {
                  const next = new Set(value as string[]);
                  if (e.target.checked) next.add(opt);
                  else next.delete(opt);
                  onChange([...next]);
                }}
              />
              {opt}
            </label>
          ))}
        </div>
      );
    }
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {row.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={row.input === 'password' ? 'password' : 'text'}
      value={String(value ?? '')}
      placeholder={row.secret && row.isSet ? 'unchanged' : ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TestEmail({ onError }: { onError: (m: string) => void }) {
  const [to, setTo] = useState('');
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="test-row">
      <input placeholder="send test to (defaults to you)" value={to} onChange={(e) => setTo(e.target.value)} />
      <button
        onClick={() =>
          api
            .testEmail(to || undefined)
            .then(() => setResult('Sent. Check the inbox.'))
            .catch((e: Error) => {
              setResult(null);
              onError(e.message);
            })
        }
      >
        Send test email
      </button>
      {result && <span className="ok-note">{result}</span>}
    </div>
  );
}

function TestSms({ onError }: { onError: (m: string) => void }) {
  const [to, setTo] = useState('');
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="test-row">
      <input placeholder="+14175550100" value={to} onChange={(e) => setTo(e.target.value)} />
      <button
        disabled={!to}
        onClick={() =>
          api
            .testSms(to)
            .then(() => setResult('Sent.'))
            .catch((e: Error) => {
              setResult(null);
              onError(e.message);
            })
        }
      >
        Send test SMS
      </button>
      {result && <span className="ok-note">{result}</span>}
    </div>
  );
}

// ── users ────────────────────────────────────────────────────────────────────

function UsersTab({ onError }: { onError: (m: string) => void }) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.adminUsers().then(setRows).catch((e: Error) => onError(e.message));
  }, [onError]);
  useEffect(load, [load]);

  return (
    <div className="admin-body">
      <section className="card">
        <div className="row-between">
          <h2>Staff accounts</h2>
          <button onClick={() => setAdding((a) => !a)}>{adding ? 'Cancel' : 'Add user'}</button>
        </div>

        {adding && <AddUser onDone={() => { setAdding(false); load(); }} onError={onError} />}

        <table className="grid">
          <thead>
            <tr>
              <th>Email</th><th>Name</th><th>Role</th><th>Factor</th><th>Status</th><th>Last sign-in</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className={u.disabledAt ? 'disabled-row' : ''}>
                <td>{u.email}</td>
                <td>{u.displayName}</td>
                <td>
                  <select
                    value={u.role}
                    onChange={(e) =>
                      api.updateUser(u.id, { role: e.target.value }).then(load).catch((x: Error) => onError(x.message))
                    }
                  >
                    {['admin', 'partner', 'staff'].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={u.mfaMethod}
                    onChange={(e) =>
                      api.updateUser(u.id, { mfaMethod: e.target.value }).then(load).catch((x: Error) => onError(x.message))
                    }
                  >
                    {['totp', 'email', 'sms'].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  {!u.mfaEnrolled && <span className="pill warn">not enrolled</span>}
                  {u.mfaMethod === 'sms' && u.phone && !u.phoneVerified && (
                    <span className="pill warn">phone unverified</span>
                  )}
                </td>
                <td>{u.disabledAt ? <span className="pill warn">disabled</span> : <span className="pill ok">active</span>}</td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td className="actions-cell">
                  <button onClick={() => api.resetMfa(u.id).then(load).catch((x: Error) => onError(x.message))}>
                    Reset MFA
                  </button>
                  <button
                    onClick={() =>
                      api
                        .updateUser(u.id, { disabled: !u.disabledAt })
                        .then(load)
                        .catch((x: Error) => onError(x.message))
                    }
                  >
                    {u.disabledAt ? 'Enable' : 'Disable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function AddUser({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [form, setForm] = useState({
    email: '', displayName: '', role: 'staff', password: '', mfaMethod: 'totp', phone: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="add-user">
      <input placeholder="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
      <input placeholder="display name" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} />
      <select value={form.role} onChange={(e) => set('role', e.target.value)}>
        {['staff', 'partner', 'admin'].map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <select value={form.mfaMethod} onChange={(e) => set('mfaMethod', e.target.value)}>
        {['totp', 'email', 'sms'].map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      {form.mfaMethod === 'sms' && (
        <input placeholder="+14175550100" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
      )}
      <input
        type="password"
        placeholder="initial password (12+ characters)"
        value={form.password}
        onChange={(e) => set('password', e.target.value)}
      />
      <button
        disabled={!form.email || !form.displayName || form.password.length < 12}
        onClick={() => api.createUser(form).then(onDone).catch((e: Error) => onError(e.message))}
      >
        Create
      </button>
    </div>
  );
}

// ── audit ────────────────────────────────────────────────────────────────────

function AuditTab({ onError }: { onError: (m: string) => void }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [filter, setFilter] = useState({ action: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const LIMIT = 100;

  const load = useCallback(() => {
    api
      .auditLog({ ...filter, limit: LIMIT, offset })
      .then((d) => { setRows(d.rows); setTotal(d.total); })
      .catch((e: Error) => onError(e.message));
  }, [filter, offset, onError]);

  useEffect(load, [load]);
  useEffect(() => { api.auditActions().then(setActions).catch(() => setActions([])); }, []);

  return (
    <div className="admin-body">
      <section className="card">
        <h2>Access log</h2>
        <p className="muted">
          Every action touching taxpayer data is recorded here, including reading this log.
          Detail payloads are scrubbed of anything TIN-shaped before storage.
        </p>
        <div className="filters">
          <select value={filter.action} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, action: e.target.value })); }}>
            <option value="">all actions</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <input type="date" value={filter.from} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, from: e.target.value })); }} />
          <input type="date" value={filter.to} onChange={(e) => { setOffset(0); setFilter((f) => ({ ...f, to: e.target.value })); }} />
          <span className="muted">{total} entries</span>
        </div>

        <table className="grid audit-grid">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>IP</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{new Date(r.at).toLocaleString()}</td>
                <td>{r.actorEmail ?? <span className="muted">system</span>}</td>
                <td><code>{r.action}</code></td>
                <td className="muted">{r.entityType ?? ''}</td>
                <td className="muted">{r.ip ?? ''}</td>
                <td><code className="detail">{JSON.stringify(r.detail)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="pager">
          <button disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}>Previous</button>
          <span>{offset + 1}–{Math.min(offset + LIMIT, total)} of {total}</span>
          <button disabled={offset + LIMIT >= total} onClick={() => setOffset((o) => o + LIMIT)}>Next</button>
        </div>
      </section>
    </div>
  );
}

// ── retention ────────────────────────────────────────────────────────────────

function RetentionTab({ onError }: { onError: (m: string) => void }) {
  const [forecast, setForecast] = useState<{ rastersDue: number; sourcesDue: number } | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.retentionForecast().then(setForecast).catch((e: Error) => onError(e.message));
  }, [onError]);
  useEffect(load, [load]);

  return (
    <div className="admin-body">
      <section className="card">
        <h2>Retention</h2>
        <p className="muted">
          Page images are derived PII and purge on their own earlier schedule, independent of
          the source documents. Nothing purges without a policy match, and every disposal is
          logged.
        </p>
        {forecast && (
          <div className="forecast">
            <div><strong>{forecast.rastersDue}</strong> page image(s) past their retention window</div>
            <div><strong>{forecast.sourcesDue}</strong> source document(s) past theirs</div>
          </div>
        )}
        <p className="muted">
          Windows are set under Settings → Retention. Turn on Dry run there to preview without
          deleting.
        </p>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .runRetention()
              .then((r) => { setResult(r); load(); })
              .catch((e: Error) => onError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          Run retention now
        </button>
        {result && <pre className="result">{JSON.stringify(result, null, 2)}</pre>}
      </section>
    </div>
  );
}
