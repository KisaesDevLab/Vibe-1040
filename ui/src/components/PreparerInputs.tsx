import { useEffect, useMemo, useState } from 'react';
import { api, formatCents } from '../api.ts';
import type { DraftActivity, DraftDependent, DraftInputs } from '../types.ts';

/**
 * What the preparer supplies, because no source document carries it (P18, CLAUDE.md §14).
 *
 * §14 rule 5 already routes filing status and the age/blindness flags through the reviewer. This
 * is the same arrangement for the three biggest remaining holes — dependents, itemised
 * deductions, and business and rental summaries — and it is data entry, not a feature: every
 * figure here is a determination a person already made, typed in so the engine can do arithmetic
 * over it.
 *
 * Four things this surface has to get right, and none of them is layout:
 *
 *  - **Nothing is inferred.** No control defaults. A checkbox would make "not stated" and
 *    "stated as no" the same answer, and whether a child qualifies for the credit is exactly
 *    the kind of determination §9 forbids this app from making — so every determination is a
 *    three-way select and starts on "not stated".
 *  - **Blank is not zero (§5).** An empty money box is left absent from the engine payload, not
 *    sent as 0, and clearing one back to blank has to stay possible.
 *  - **An override says what it displaces, before the typing.** Where a document already feeds
 *    a Schedule A line, the engine uses the document's figure and discards a typed one in
 *    silence. So the app sends one side — and this surface names the form, the box and the
 *    amount the typed figure will displace, beside the box.
 *  - **A field nobody can enter is worse than a missing feature**, so the fields rendered here
 *    are the ones the node map declares, labels and all. Adding a column to the map cannot
 *    leave it with nowhere to type it.
 *
 * It is a full-width sheet rather than a pane in the review aside. The aside is about 290px and
 * the last round's browser render showed what that does to a money table: every label broke one
 * word per line and a column was clipped off the right edge.
 */

/** Cents from what a person typed, or `null` for an empty box. Never 0 for empty (§5). */
function toCents(raw: string): number | null {
  const trimmed = raw.replace(/[$,\s]/g, '');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * What a stored cents figure looks like in an editable box.
 *
 * Formatted, not raw digits, and that is not cosmetic. The first browser render showed `15000`
 * in the box with `12,844.00 already comes from 1098 — HERITAGE MORTGAGE CO` directly beneath
 * it: the same quantity in two notations, one above the other, which is how a figure gets read
 * out by a factor of a hundred. `toCents` strips the separators back off on the way in.
 */
const centsToInput = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '' : formatCents(cents).replace(/^\((.*)\)$/, '-$1');

/**
 * A money box that leaves typing alone and tidies up on blur.
 *
 * Reformatting on every keystroke fights the caret; reformatting never leaves two notations on
 * screen at once. So it happens exactly when the box is done with.
 */
function MoneyInput({
  value,
  onChange,
  onCommit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <input
      className="pi-money"
      inputMode="decimal"
      placeholder="blank"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        const cents = toCents(value);
        const tidied = centsToInput(cents);
        if (tidied !== value) onChange(tidied);
        onCommit?.(tidied);
      }}
    />
  );
}

/**
 * A determination: yes, no, or nobody has said. Three states because two would be a lie — an
 * unticked checkbox cannot tell "the preparer decided no" from "the preparer has not looked".
 */
function Determination({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  disabled?: boolean;
}) {
  return (
    <label className="pi-det">
      <span>{label}</span>
      <select
        value={value === null ? '' : value ? 'yes' : 'no'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}
      >
        <option value="">Not stated</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
}

export function PreparerInputs({
  bundleId,
  onClose,
  onSaved,
  onError,
}: {
  bundleId: string;
  onClose: () => void;
  /** So the draft panel can re-read the summary and offer to recompute. */
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [inputs, setInputs] = useState<DraftInputs | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduleA, setScheduleA] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<Record<string, boolean | null>>({});
  const [dirty, setDirty] = useState(false);

  const reload = () =>
    api
      .draftInputs(bundleId)
      .then((d) => {
        setInputs(d);
        const money: Record<string, string> = {};
        const bools: Record<string, boolean | null> = {};
        for (const f of d.scheduleAFields) {
          const v = d.scheduleA?.[f.column];
          if (f.money) money[f.column] = centsToInput(typeof v === 'number' ? v : null);
          else bools[f.column] = typeof v === 'boolean' ? v : null;
        }
        setScheduleA(money);
        setFlags(bools);
        setDirty(false);
      })
      .catch((e: Error) => onError(e.message));

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId]);

  /** Keyed by the Schedule A column, so a box can say what it will displace. */
  const backed = useMemo(
    () => new Map((inputs?.documentBacked ?? []).map((b) => [b.column, b])),
    [inputs],
  );

  if (!inputs) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveRoot = (values: Partial<DraftInputs>) =>
    run(() => api.saveDraftInputRoot(bundleId, values));

  const saveScheduleA = () =>
    run(() =>
      api.saveScheduleA(bundleId, {
        // An empty box sends `null`, which clears the stored figure. Both an absent key and a
        // null reach the engine as absent, but only one of them forgets what a preparer typed,
        // and a box a preparer just emptied means the second.
        ...Object.fromEntries(Object.entries(scheduleA).map(([k, v]) => [k, toCents(v)])),
        ...flags,
      }),
    );

  const groups = [...new Set(inputs.scheduleAFields.map((f) => f.group ?? 'Other'))];

  return (
    <div className="pi-scrim" role="dialog" aria-label="Preparer-supplied inputs">
      <div className="pi-sheet">
        <div className="pi-head">
          <h2>Preparer inputs</h2>
          <span className="muted">
            What no source document carries. Typed by you because each one is a determination —
            the app infers none of it.
          </span>
          <div className="spacer" />
          {dirty && <span className="pill warn">Itemised deductions not saved</span>}
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="pi-body">
          {/* ── the return itself ───────────────────────────────────────────── */}
          <section className="pi-section">
            <h3>This return</h3>
            <label className="pi-det">
              <span>Filing status</span>
              <select
                value={inputs.filingStatus ?? ''}
                disabled={busy}
                onChange={(e) => saveRoot({ filingStatus: e.target.value || null })}
              >
                <option value="">Not stated</option>
                {inputs.filingStatuses.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="pi-hint">
              Nothing computes until a filing status is stated. It is not printed on any source
              document, and a pile of forms cannot imply one.
            </p>
            <div className="pi-dets">
              <Determination
                label="Taxpayer is 65 or older"
                value={inputs.taxpayerAge65OrOlder}
                disabled={busy}
                onChange={(v) => saveRoot({ taxpayerAge65OrOlder: v })}
              />
              <Determination
                label="Spouse is 65 or older"
                value={inputs.spouseAge65OrOlder}
                disabled={busy}
                onChange={(v) => saveRoot({ spouseAge65OrOlder: v })}
              />
              <Determination
                label="Taxpayer is blind"
                value={inputs.taxpayerBlind}
                disabled={busy}
                onChange={(v) => saveRoot({ taxpayerBlind: v })}
              />
              <Determination
                label="Spouse is blind"
                value={inputs.spouseBlind}
                disabled={busy}
                onChange={(v) => saveRoot({ spouseBlind: v })}
              />
            </div>
          </section>

          {/* ── dependents ──────────────────────────────────────────────────── */}
          <section className="pi-section">
            <h3>Dependents — {inputs.dependents.length}</h3>
            <p className="pi-hint">
              No identification number is asked for or stored, for a dependent or for anyone else
              (§7). The engine computes the child tax credit without one; it appears on the draft
              as <em>Nonrefundable credits</em>.
            </p>
            {inputs.dependents.map((d) => (
              <DependentRow
                key={d.id}
                dependent={d}
                inputs={inputs}
                busy={busy}
                onChange={(values) => run(() => api.updateDependent(bundleId, d.id, values))}
                onRemove={() => run(() => api.removeDependent(bundleId, d.id))}
              />
            ))}
            <NewDependent
              inputs={inputs}
              busy={busy}
              onAdd={(values) => run(() => api.addDependent(bundleId, values))}
            />
          </section>

          {/* ── itemised deductions ─────────────────────────────────────────── */}
          <section className="pi-section">
            <h3>Itemised deductions (Schedule A)</h3>
            <p className="pi-hint">
              Leave a line blank if there is nothing on it. A blank is not a zero: it is left off
              the engine payload entirely, so the engine decides nothing from it.
            </p>
            {groups.map((group) => (
              <div key={group} className="pi-group">
                <div className="pi-group-head">{group}</div>
                {inputs.scheduleAFields
                  .filter((f) => (f.group ?? 'Other') === group)
                  .map((f) => {
                    const conflict = backed.get(f.column);
                    return (
                      <div key={f.column} className="pi-field">
                        <label>
                          <span className="pi-field-label">{f.label}</span>
                          {f.money ? (
                            <MoneyInput
                              value={scheduleA[f.column] ?? ''}
                              disabled={busy}
                              onChange={(v) => {
                                setScheduleA({ ...scheduleA, [f.column]: v });
                                setDirty(true);
                              }}
                            />
                          ) : (
                            <select
                              value={flags[f.column] === null || flags[f.column] === undefined ? '' : flags[f.column] ? 'yes' : 'no'}
                              disabled={busy}
                              onChange={(e) => {
                                setFlags({
                                  ...flags,
                                  [f.column]: e.target.value === '' ? null : e.target.value === 'yes',
                                });
                                setDirty(true);
                              }}
                            >
                              <option value="">Not stated</option>
                              <option value="yes">Yes</option>
                              <option value="no">No</option>
                            </select>
                          )}
                        </label>
                        {/*
                          The measured behaviour, said out loud at the point of entry: engine
                          2.0.4 uses the document's figure and discards a typed one without a
                          word, so the app sends one side. Typing here displaces a form.
                        */}
                        {conflict && (
                          <div className="pi-conflict">
                            {conflict.sources.map((s) => (
                              <div key={`${s.documentId}-${s.fieldKey}`}>
                                <strong>{formatCents(s.cents)}</strong> already comes from{' '}
                                {s.documentLabel} ({s.fieldKey.replace(/_/g, ' ')}).
                              </div>
                            ))}
                            <div>
                              A figure here <strong>replaces</strong> that rather than adding to
                              it, and the draft will list the document as overridden. The
                              worksheet still reports it unchanged.
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            ))}
            {/*
              Both elections set to yes is a contradiction, and the app must not pick a winner —
              which one a preparer meant is their determination, not an inference from the order
              they were clicked in. So it refuses to save and says so.
            */}
            {flags['forceItemized'] === true && flags['forceStandard'] === true && (
              <div className="pi-conflict pi-conflict-block">
                Itemising and taking the standard deduction are both set to yes. They contradict
                each other and the app will not choose between them — set one to no.
              </div>
            )}
            <div className="pi-actions">
              <button
                type="button"
                onClick={saveScheduleA}
                disabled={
                  busy ||
                  !dirty ||
                  (flags['forceItemized'] === true && flags['forceStandard'] === true)
                }
              >
                {busy ? 'Saving…' : 'Save itemised deductions'}
              </button>
              {inputs.scheduleA && (
                <span className="muted">
                  {Object.values(inputs.scheduleA).filter((v) => v !== null).length} line(s) stated
                </span>
              )}
            </div>
          </section>

          {/* ── businesses, rentals and farms ───────────────────────────────── */}
          <section className="pi-section">
            <h3>Businesses and rental properties — {inputs.activities.length}</h3>
            <p className="pi-hint">
              A summary, not a line-by-line schedule: gross, one total for expenses, and what the
              engine needs to accept the activity at all. The net carries to the 1040 as
              additional income.
            </p>
            {inputs.activities.map((a) => (
              <ActivityRow
                key={a.id}
                activity={a}
                inputs={inputs}
                busy={busy}
                onChange={(values) => run(() => api.updateActivity(bundleId, a.id, values))}
                onRemove={() => run(() => api.removeActivity(bundleId, a.id))}
              />
            ))}
            <NewActivity
              inputs={inputs}
              busy={busy}
              onAdd={(values) => run(() => api.addActivity(bundleId, values))}
            />
            {/*
              An activity this engine release refuses is named rather than hidden. Offering a
              control that produces a node the engine rejects would put a farm in the pile and
              lose it at compute time, which is the silent loss this app exists to prevent.
            */}
            {inputs.unsupportedActivities.map((u) => (
              <div key={u.kind} className="pi-unsupported">
                <strong>{u.label} cannot be included.</strong> {u.detail}
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

/** One dependent, editable in place. Determinations are three-state; nothing defaults. */
function DependentRow({
  dependent,
  inputs,
  busy,
  onChange,
  onRemove,
}: {
  dependent: DraftDependent;
  inputs: DraftInputs;
  busy: boolean;
  onChange: (values: Partial<Omit<DraftDependent, 'id'>>) => void;
  onRemove: () => void;
}) {
  const label = (column: string): string =>
    inputs.dependentFields.find((f) => f.column === column)?.label ?? column;

  return (
    <div className="pi-row">
      <div className="pi-row-head">
        <strong>
          {dependent.firstName} {dependent.lastName}
        </strong>
        <span className="muted">
          {inputs.relationships.find((r) => r.code === dependent.relationship)?.label ??
            dependent.relationship}{' '}
          · born {dependent.dob} · {dependent.monthsInHome} month(s) in the home
        </span>
        <div className="spacer" />
        <button type="button" className="link" disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
      {/*
        Measured in a browser against the real engine: a dependent whose qualifying-child
        determination is not stated earns no credit, and the total simply does not move. Three
        dependents and a credit for two looks exactly like a correct return. Saying which one is
        not counted, and why, is the difference between a determination the preparer withheld
        and one the app lost.
      */}
      {dependent.qualifyingChildForCtc === null && (
        <div className="pi-conflict pi-note-block">
          No child tax credit is computed for {dependent.firstName} until the qualifying-child
          question below is answered. Leaving it unstated is a valid answer — it is just not the
          same as “no”, and the draft cannot tell you which you meant.
        </div>
      )}
      <div className="pi-dets">
        <Determination
          label={label('qualifyingChildForCtc')}
          value={dependent.qualifyingChildForCtc}
          disabled={busy}
          onChange={(v) => onChange({ qualifyingChildForCtc: v })}
        />
        <Determination
          label={label('fullTimeStudent')}
          value={dependent.fullTimeStudent}
          disabled={busy}
          onChange={(v) => onChange({ fullTimeStudent: v })}
        />
        <Determination
          label={label('disabled')}
          value={dependent.disabled}
          disabled={busy}
          onChange={(v) => onChange({ disabled: v })}
        />
        <Determination
          label={label('taxpayerProvidedOverHalfSupport')}
          value={dependent.taxpayerProvidedOverHalfSupport}
          disabled={busy}
          onChange={(v) => onChange({ taxpayerProvidedOverHalfSupport: v })}
        />
        <Determination
          label={label('dependentOnAnotherReturn')}
          value={dependent.dependentOnAnotherReturn}
          disabled={busy}
          onChange={(v) => onChange({ dependentOnAnotherReturn: v })}
        />
      </div>
    </div>
  );
}

function NewDependent({
  inputs,
  busy,
  onAdd,
}: {
  inputs: DraftInputs;
  busy: boolean;
  onAdd: (values: Omit<DraftDependent, 'id'>) => void;
}) {
  const blank = {
    firstName: '',
    lastName: '',
    middleInitial: null,
    dob: '',
    relationship: '',
    monthsInHome: 12,
  };
  const [draft, setDraft] = useState(blank);
  const ready = draft.firstName && draft.lastName && draft.dob && draft.relationship;

  return (
    <div className="pi-new">
      <input
        placeholder="First name"
        value={draft.firstName}
        onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
      />
      <input
        placeholder="Last name"
        value={draft.lastName}
        onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
      />
      <input
        type="date"
        title="Date of birth — the engine needs it to age the dependent"
        value={draft.dob}
        onChange={(e) => setDraft({ ...draft, dob: e.target.value })}
      />
      <select
        value={draft.relationship}
        onChange={(e) => setDraft({ ...draft, relationship: e.target.value })}
      >
        <option value="">Relationship…</option>
        {inputs.relationships.map((r) => (
          <option key={r.code} value={r.code}>
            {r.label}
          </option>
        ))}
      </select>
      <label className="pi-det">
        <span>Months in the home</span>
        <input
          type="number"
          min={0}
          max={12}
          value={draft.monthsInHome}
          onChange={(e) => setDraft({ ...draft, monthsInHome: Number(e.target.value) })}
        />
      </label>
      <button
        type="button"
        disabled={busy || !ready}
        onClick={() => {
          onAdd({
            ...draft,
            // Not stated, for every one of them. A dependent added here has had no
            // determination made about them yet, and the engine must not be told otherwise.
            qualifyingChildForCtc: null,
            disabled: null,
            fullTimeStudent: null,
            taxpayerProvidedOverHalfSupport: null,
            dependentOnAnotherReturn: null,
            grossIncomeCents: null,
          });
          setDraft(blank);
        }}
      >
        Add dependent
      </button>
    </div>
  );
}

/** One business or property. Gross and expenses are editable; the net is shown, never stored. */
function ActivityRow({
  activity,
  inputs,
  busy,
  onChange,
  onRemove,
}: {
  activity: DraftActivity;
  inputs: DraftInputs;
  busy: boolean;
  onChange: (values: Partial<Omit<DraftActivity, 'id'>>) => void;
  onRemove: () => void;
}) {
  const kind = inputs.activityKinds.find((k) => k.kind === activity.kind);
  const [gross, setGross] = useState(centsToInput(activity.grossCents));
  const [expenses, setExpenses] = useState(centsToInput(activity.expensesCents));
  const net =
    activity.grossCents === null
      ? null
      : activity.grossCents - (activity.expensesCents ?? 0);

  return (
    <div className="pi-row">
      <div className="pi-row-head">
        <strong>{activity.description}</strong>
        <span className="muted">{kind?.label ?? activity.kind}</span>
        <div className="spacer" />
        <span className="muted">
          net {formatCents(net)}
          {activity.grossCents !== null && activity.expensesCents === null
            ? ' — no expenses stated'
            : ''}
        </span>
        <button type="button" className="link" disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="pi-dets">
        <label className="pi-det">
          <span>Gross</span>
          <MoneyInput
            value={gross}
            disabled={busy}
            onChange={setGross}
            onCommit={(v) => onChange({ grossCents: toCents(v) })}
          />
        </label>
        <label className="pi-det">
          <span>Total expenses</span>
          <MoneyInput
            value={expenses}
            disabled={busy}
            onChange={setExpenses}
            onCommit={(v) => onChange({ expensesCents: toCents(v) })}
          />
        </label>
        {activity.kind === 'schedule_c' && (
          <Determination
            label="Materially participated"
            value={activity.materialParticipation}
            disabled={busy}
            onChange={(v) => onChange({ materialParticipation: v })}
          />
        )}
        {activity.kind === 'schedule_e' && (
          <>
            <label className="pi-det">
              <span>Fair rental days</span>
              <input
                type="number"
                min={0}
                max={365}
                value={activity.fairRentalDays ?? ''}
                disabled={busy}
                onChange={(e) =>
                  onChange({ fairRentalDays: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </label>
            <label className="pi-det">
              <span>Personal use days</span>
              <input
                type="number"
                min={0}
                max={365}
                value={activity.personalUseDays ?? ''}
                disabled={busy}
                onChange={(e) =>
                  onChange({ personalUseDays: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

function NewActivity({
  inputs,
  busy,
  onAdd,
}: {
  inputs: DraftInputs;
  busy: boolean;
  onAdd: (values: Omit<DraftActivity, 'id'>) => void;
}) {
  const [kind, setKind] = useState('');
  const [description, setDescription] = useState('');
  const [activityCode, setActivityCode] = useState('');
  const [accountingMethod, setAccountingMethod] = useState('');
  const [propertyType, setPropertyType] = useState('');
  const chosen = inputs.activityKinds.find((k) => k.kind === kind);

  // Required means the engine refuses the node without it, which is the map's own
  // `engineRequired`, not a guess about what a preparer ought to fill in.
  const needs = (column: string): boolean => (chosen?.requires ?? []).includes(column);
  const ready =
    chosen !== undefined &&
    description !== '' &&
    (!needs('activityCode') || activityCode !== '') &&
    (!needs('accountingMethod') || accountingMethod !== '') &&
    (!needs('propertyType') || propertyType !== '');

  return (
    <div className="pi-new">
      <select value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="">Add…</option>
        {inputs.activityKinds.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      {chosen && (
        <>
          <input
            placeholder={chosen.fields.find((f) => f.column === 'description')?.label ?? 'Description'}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {needs('activityCode') && (
            <input
              placeholder="Business code"
              title="The six-digit code from the Schedule C instructions. Sent as printed — it is digits, not a number."
              value={activityCode}
              onChange={(e) => setActivityCode(e.target.value)}
            />
          )}
          {chosen.accountingMethods.length > 0 && (
            <select value={accountingMethod} onChange={(e) => setAccountingMethod(e.target.value)}>
              <option value="">Accounting method…</option>
              {chosen.accountingMethods.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
          {chosen.propertyTypes.length > 0 && (
            <select value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
              <option value="">Type of property…</option>
              {chosen.propertyTypes.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => {
              onAdd({
                kind,
                description,
                activityCode: activityCode || null,
                accountingMethod: accountingMethod || null,
                propertyType: propertyType || null,
                materialParticipation: null,
                fairRentalDays: null,
                personalUseDays: null,
                grossCents: null,
                expensesCents: null,
                expensesDescription: null,
              });
              setKind('');
              setDescription('');
              setActivityCode('');
              setAccountingMethod('');
              setPropertyType('');
            }}
          >
            Add
          </button>
        </>
      )}
    </div>
  );
}
