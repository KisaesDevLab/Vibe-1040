import { useState } from 'react';
import { api, formatCents } from '../api';
import type { FieldRow } from '../types';

/**
 * Editable field values with accept / correct actions (P11).
 *
 * The blank-vs-zero distinction is visible in the UI, not just in the database: a blank box
 * renders as "blank" and a printed zero renders as 0.00, and "Set blank" is a distinct
 * action from typing 0.
 */
interface Props {
  field: FieldRow;
  label: string;
  isMoney: boolean;
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
}

export function FieldEditor({ field, label, isMoney, selected, onSelect, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const display = field.cents !== null
    ? formatCents(field.cents)
    : field.bool !== null
      ? field.bool ? 'checked' : 'unchecked'
      : field.text ?? null;

  const save = async (setToNull: boolean) => {
    setBusy(true);
    try {
      if (setToNull) {
        await api.correctField(field.fieldId, { setToNull: true, note });
      } else if (isMoney) {
        const cents = Math.round(Number(draft.replace(/[$,\s]/g, '')) * 100);
        if (!Number.isFinite(cents)) throw new Error('not a number');
        await api.correctField(field.fieldId, { cents, note });
      } else {
        await api.correctField(field.fieldId, { text: draft, note });
      }
      setEditing(false);
      setNote('');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const flags: string[] = [];
  if (field.reviewReason === 'no_span') flags.push('no source span');
  if (field.disagreed) flags.push('passes disagreed');
  if (field.wasCorrected) flags.push('corrected');

  return (
    <div
      className={[
        'field-row',
        selected ? 'selected' : '',
        field.needsReview ? 'needs-review' : '',
        field.spanIds.length === 0 && field.present ? 'no-span' : '',
      ].join(' ')}
      onClick={onSelect}
    >
      <div className="field-head">
        <span className="field-label">{label}</span>
        <span className={display === null ? 'field-value blank' : 'field-value'}>
          {display === null ? 'blank' : display}
        </span>
      </div>

      {flags.length > 0 && (
        <div className="field-flags">
          {flags.map((f) => (
            <span key={f} className="flag">{f}</span>
          ))}
        </div>
      )}

      {field.wasCorrected && (
        <div className="field-original">
          model read:{' '}
          {field.original.cents !== null
            ? formatCents(field.original.cents)
            : (field.original.text ?? (field.original.bool === null ? 'blank' : String(field.original.bool)))}
        </div>
      )}

      {editing ? (
        <div className="field-edit" onClick={(e) => e.stopPropagation()}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={isMoney ? '0.00' : 'value'}
            autoFocus
          />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" />
          <button disabled={busy} onClick={() => void save(false)}>Save</button>
          <button disabled={busy} onClick={() => void save(true)} title="The box on the form is empty">
            Set blank
          </button>
          <button disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <div className="field-actions" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              setDraft(field.cents !== null ? String(field.cents / 100) : (field.text ?? ''));
              setEditing(true);
            }}
          >
            Correct
          </button>
        </div>
      )}
    </div>
  );
}
