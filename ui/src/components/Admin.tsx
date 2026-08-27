import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AuditRow, EnvSetting, SettingRow, UserRow } from '../types';

/**
 * Admin section — Settings, Users, Audit, Retention.
 *
 * Firm policy is editable here and audited. Infrastructure and key material are shown
 * read-only, because a web form is the wrong place for a decryption key and the
 * compliance guardrails should not be a switch.
 */
type Tab = 'settings' | 'users' | 'audit' | 'retention';

const GROUP_LABELS: Record<string, string> = {
  reconciliation: 'Reconciliation',
  retention: 'Retention',
  extraction: 'Extraction',
  rasterization: 'Rasterization',
  email: 'Email delivery',
  sms: 'SMS delivery',
  authentication: 'Authentication',
  licensing: 'Licensing',
};

export function Admin({ onError }: { onError: (m: string) => void }) {
  const [tab, setTab] = useState<Tab>('settings');
  return (
    <div className="admin">
      <nav className="admin-tabs">
        {(['settings', 'users', 'audit', 'retention'] as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === 'settings' && <SettingsTab onError={onError} />}
      {tab === 'users' && <UsersTab onError={onError} />}
      {tab === 'audit' && <AuditTab onError={onError} />}
      {tab === 'retention' && <RetentionTab onError={onError} />}
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

  const load = useCallback(() => {
    api
      .adminSettings()
      .then((d) => {
        setRows(d.settings);
        setEnv(d.environment);
        setDraft(Object.fromEntries(d.settings.map((s) => [s.key, s.value])));
      })
      .catch((e: Error) => onError(e.message));
  }, [onError]);

  useEffect(load, [load]);

  const dirty = rows.filter((r) => JSON.stringify(draft[r.key]) !== JSON.stringify(r.value));

  const save = () => {
    setBusy(true);
    setSaved(false);
    api
      .updateSettings(dirty.map((r) => ({ key: r.key, value: draft[r.key] })))
      .then((d) => {
        setRows(d.settings);
        setDraft(Object.fromEntries(d.settings.map((s) => [s.key, s.value])));
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
                </div>
                <SettingInput
                  row={r}
                  value={draft[r.key]}
                  onChange={(v) => setDraft((d) => ({ ...d, [r.key]: v }))}
                />
                <span className="setting-help">{r.help}</span>
              </label>
            ))}

          {group === 'email' && <TestEmail onError={onError} />}
          {group === 'sms' && <TestSms onError={onError} />}
        </section>
      ))}

      <section className="card">
        <h2>Environment (read-only)</h2>
        <p className="muted">
          Set at provisioning and changed only in <code>.env</code> with a restart. These are
          deliberately not editable here: the region assertion is the control keeping taxpayer
          page images inside US inference, and the keys below would be handed to anyone who
          compromised an admin account.
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
        <button disabled={busy || dirty.length === 0} onClick={save}>
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
