import { useState } from 'react';
import { api, formatCents } from '../api';
import type { FieldRow } from '../types';

/**
 * Editable field values (P11).
 *
 * A field that nothing flagged is shown quietly — value, and a small "edit" affordance —
 * because a Correct button on every row read as "every row needs correcting". A flagged
 * field says in a sentence why it was flagged and offers two exits: correct it, or confirm
 * it is right ("Looks right"), which clears the flag without changing the value.
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

const REASONS: Record<string, string> = {
  no_span: 'No span on the page supports this value. Check it against the image.',
  span_mismatch: 'The value is not in the text it cites — a likely misread.',
  pass_disagreement: 'Two binding passes disagreed on this value.',
  unmapped: 'The printed value could not be parsed as this field type.',
  hard_failure: 'Part of a hard arithmetic failure.',
  soft_failure: 'Part of a soft arithmetic annotation.',
  judgment_required: 'Judgment Required.',
};

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

  const accept = async () => {
    setBusy(true);
    try {
      await api.acceptField(field.fieldId);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    setDraft(field.cents !== null ? String(field.cents / 100) : (field.text ?? ''));
    setEditing(true);
  };

  const reason = field.needsReview ? (REASONS[field.reviewReason ?? ''] ?? `Needs review (${field.reviewReason ?? '?'}).`) : null;

  return (
    <div
      className={[
        'field-row',
        selected ? 'selected' : '',
        field.needsReview ? 'needs-review' : 'quiet',
        field.needsReview && field.reviewReason === 'span_mismatch' ? 'mismatch' : '',
      ].join(' ')}
      onClick={onSelect}
    >
      <div className="field-head">
        <span className="field-label">{label}</span>
        <span className={display === null ? 'field-value blank' : 'field-value'}>
          {display === null ? 'blank' : display}
        </span>
        {!editing && !field.needsReview && (
          <button
            className="link field-edit-link"
            title="Change this value"
            onClick={(e) => {
              e.stopPropagation();
              startEdit();
            }}
          >
            edit
          </button>
        )}
      </div>

      {reason && <div className="field-reason">{reason}</div>}
      {field.wasCorrected && (
        <div className="field-original">
          corrected · model read:{' '}
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
        field.needsReview && (
          <div className="field-actions" onClick={(e) => e.stopPropagation()}>
            <button disabled={busy} onClick={() => void accept()} title="The value is right as read; clear the flag">
              Looks right
            </button>
            <button disabled={busy} onClick={startEdit}>Correct</button>
          </div>
        )
      )}
    </div>
  );
}
