import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.ts';
import type { DraftInputs } from '../types.ts';
import { PreparerInputs } from './PreparerInputs.tsx';

/**
 * The preparer-inputs sheet (P18), rendered.
 *
 * These tests are about **the claims this surface makes in words**, not about layout. Layout is
 * checked by looking at it in a browser, and this session is the evidence: every visual defect
 * was found that way and none by a test. What a test can hold is the part that would still be
 * wrong if the page looked perfect —
 *
 *  - a blank money box stays blank and is never sent as `0` (§5);
 *  - a determination offers "not stated" and starts there, because an unticked checkbox cannot
 *    tell "decided no" from "has not looked" (§9);
 *  - an override says which document it will displace **before** it is typed over (P18);
 *  - a contradiction the app must not resolve is refused rather than guessed at.
 *
 * The api module is mocked at its boundary; the component, its state and its wiring are real.
 */
vi.mock('../api.ts', async () => {
  const actual = await vi.importActual<typeof import('../api.ts')>('../api.ts');
  return { formatCents: actual.formatCents, api: { draftInputs: vi.fn(), saveDraftInputRoot: vi.fn(), addDependent: vi.fn(), updateDependent: vi.fn(), removeDependent: vi.fn(), saveScheduleA: vi.fn(), addActivity: vi.fn(), updateActivity: vi.fn(), removeActivity: vi.fn() } };
});

const BUNDLE = 'b-1';

/** The shape the server serves, trimmed to what this surface reads. */
function inputs(over: Partial<DraftInputs> = {}): DraftInputs {
  return {
    filingStatus: null,
    taxpayerAge65OrOlder: null,
    spouseAge65OrOlder: null,
    taxpayerBlind: null,
    spouseBlind: null,
    dependents: [],
    scheduleA: null,
    activities: [],
    updatedAt: null,
    filingStatuses: [
      { code: 'single', label: 'Single' },
      { code: 'mfj', label: 'Married filing jointly' },
    ],
    relationships: [{ code: 'daughter', label: 'Daughter' }],
    activityKinds: [
      {
        kind: 'schedule_c',
        label: 'Business (Schedule C)',
        accountingMethods: [{ code: 'cash', label: 'Cash' }],
        propertyTypes: [],
        fields: [],
        requires: ['description', 'activityCode', 'accountingMethod', 'grossCents'],
      },
    ],
    unsupportedActivities: [
      {
        kind: 'schedule_f',
        label: 'Farm (Schedule F)',
        reason: 'engine_refuses_node',
        detail: 'Engine 2.0.4 refuses a schedule_f node.',
      },
    ],
    scheduleAFields: [
      { column: 'medicalCents', label: '1. Medical and dental expenses', group: 'Medical and dental', money: true },
      { column: 'mortgageInterest1098Cents', label: '8a. Home mortgage interest reported on Form 1098', group: 'Interest you paid', money: true },
      { column: 'forceItemized', label: 'Itemise even if the standard deduction is larger', group: 'Election', money: false },
      { column: 'forceStandard', label: 'Take the standard deduction even if itemising is larger', group: 'Election', money: false },
    ],
    dependentFields: [
      { column: 'qualifyingChildForCtc', label: 'Qualifying child for the child tax credit', required: false, money: false },
      { column: 'fullTimeStudent', label: 'Full-time student', required: false, money: false },
      { column: 'disabled', label: 'Permanently and totally disabled', required: false, money: false },
      { column: 'taxpayerProvidedOverHalfSupport', label: 'Taxpayer provided over half of their support', required: false, money: false },
      { column: 'dependentOnAnotherReturn', label: 'Claimed as a dependent on another return', required: false, money: false },
    ],
    documentBacked: [
      {
        column: 'mortgageInterest1098Cents',
        nodeField: 'line_8a_mortgage_interest_1098',
        sources: [
          {
            documentId: 'd-1',
            documentLabel: '1098 — HERITAGE MORTGAGE CO',
            formType: '1098',
            fieldKey: 'box_1',
            cents: 1_284_400,
          },
        ],
      },
    ],
    ...over,
  };
}

const mounted = async (over: Partial<DraftInputs> = {}) => {
  vi.mocked(api.draftInputs).mockResolvedValue(inputs(over));
  render(<PreparerInputs bundleId={BUNDLE} onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />);
  await screen.findByRole('dialog');
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.saveScheduleA).mockResolvedValue(inputs());
  vi.mocked(api.saveDraftInputRoot).mockResolvedValue(inputs());
  vi.mocked(api.addDependent).mockResolvedValue({ id: 'dep-1' });
});
afterEach(() => vi.clearAllMocks());

describe('a blank is not a zero', () => {
  it('sends null for a box the preparer never touched, never 0', async () => {
    const user = userEvent.setup();
    await mounted();

    await user.type(screen.getByLabelText('1. Medical and dental expenses'), '825.40');
    await user.click(screen.getByRole('button', { name: /Save itemised deductions/ }));

    await waitFor(() => expect(api.saveScheduleA).toHaveBeenCalled());
    const [, values] = vi.mocked(api.saveScheduleA).mock.calls[0]!;
    expect(values['medicalCents']).toBe(82_540);
    // The line nobody typed in. `0` here would reach the engine as a real figure and destroy
    // the distinction §5 exists for; `null` reaches it as absent.
    expect(values['mortgageInterest1098Cents']).toBeNull();
    expect(Object.values(values)).not.toContain(0);
  });

  it('keeps a figure cleared back to blank as null rather than dropping the key', async () => {
    const user = userEvent.setup();
    await mounted({ scheduleA: { medicalCents: 82_540, mortgageInterest1098Cents: null } });

    const box = screen.getByLabelText('1. Medical and dental expenses');
    await waitFor(() => expect(box).toHaveValue('825.40'));
    await user.clear(box);
    await user.click(screen.getByRole('button', { name: /Save itemised deductions/ }));

    await waitFor(() => expect(api.saveScheduleA).toHaveBeenCalled());
    const [, values] = vi.mocked(api.saveScheduleA).mock.calls[0]!;
    // Cleared, not forgotten: an absent key would leave the old figure standing.
    expect(values).toHaveProperty('medicalCents');
    expect(values['medicalCents']).toBeNull();
  });
});

describe('nothing is inferred', () => {
  it('offers "not stated" on every determination, and starts there', async () => {
    await mounted({
      dependents: [
        {
          id: 'dep-1', firstName: 'ANNA', lastName: 'SMITH', middleInitial: null,
          dob: '2014-03-02', relationship: 'daughter', monthsInHome: 12,
          qualifyingChildForCtc: null, disabled: null, fullTimeStudent: null,
          taxpayerProvidedOverHalfSupport: null, dependentOnAnotherReturn: null,
          grossIncomeCents: null,
        },
      ],
    });

    const ctc = screen.getByLabelText('Qualifying child for the child tax credit');
    expect(ctc).toHaveValue('');
    expect(within(ctc as HTMLSelectElement).getByRole('option', { name: 'Not stated' })).toBeInTheDocument();
    // Three answers, not two: "no" is a determination and "not stated" is its absence.
    expect((ctc as HTMLSelectElement).options).toHaveLength(3);
  });

  it('says a dependent with no determination earns no credit, by name', async () => {
    await mounted({
      dependents: [
        {
          id: 'dep-1', firstName: 'CLARA', lastName: 'SMITH', middleInitial: null,
          dob: '2019-08-14', relationship: 'daughter', monthsInHome: 12,
          qualifyingChildForCtc: null, disabled: null, fullTimeStudent: null,
          taxpayerProvidedOverHalfSupport: null, dependentOnAnotherReturn: null,
          grossIncomeCents: null,
        },
      ],
    });
    // Measured against the real engine: an unstated determination earns nothing and the total
    // simply does not move, so three dependents and a credit for two looks correct.
    expect(screen.getByText(/No child tax credit is computed for CLARA/)).toBeInTheDocument();
  });

  it('adds a dependent with every determination unstated', async () => {
    const user = userEvent.setup();
    await mounted();

    await user.type(screen.getByPlaceholderText('First name'), 'ANNA');
    await user.type(screen.getByPlaceholderText('Last name'), 'SMITH');
    const relationship = screen.getAllByRole('combobox').find((c) =>
      within(c as HTMLSelectElement).queryByRole('option', { name: 'Daughter' }),
    )!;
    await user.selectOptions(relationship, 'daughter');
    const dob = document.querySelector('.pi-new input[type="date"]')!;
    await user.type(dob, '2014-03-02');
    await user.click(screen.getByRole('button', { name: 'Add dependent' }));

    await waitFor(() => expect(api.addDependent).toHaveBeenCalled());
    const [, values] = vi.mocked(api.addDependent).mock.calls[0]!;
    expect(values.firstName).toBe('ANNA');
    // Adding someone is not a determination about them.
    expect(values.qualifyingChildForCtc).toBeNull();
    expect(values.disabled).toBeNull();
    expect(values.fullTimeStudent).toBeNull();
  });
});

describe('an override says what it displaces, before the typing', () => {
  it('names the document, the box and the amount beside the box', async () => {
    await mounted();
    const warning = screen.getByText(/already comes from/);
    expect(warning).toHaveTextContent('12,844.00');
    expect(warning).toHaveTextContent('1098 — HERITAGE MORTGAGE CO');
    expect(warning).toHaveTextContent('box 1');
    // And what typing will actually do, in words.
    expect(screen.getByText(/replaces/)).toBeInTheDocument();
  });

  it('says nothing about a line no document feeds', async () => {
    await mounted();
    const medical = screen.getByLabelText('1. Medical and dental expenses').closest('.pi-field')!;
    expect(within(medical as HTMLElement).queryByText(/already comes from/)).toBeNull();
  });
});

describe('a contradiction the app must not resolve', () => {
  it('refuses to save when both deduction elections are yes, and says why', async () => {
    const user = userEvent.setup();
    await mounted();

    await user.selectOptions(screen.getByLabelText(/Itemise even if/), 'yes');
    await user.selectOptions(screen.getByLabelText(/Take the standard deduction even if/), 'yes');

    expect(screen.getByRole('button', { name: /Save itemised deductions/ })).toBeDisabled();
    expect(screen.getByText(/They contradict each other/)).toBeInTheDocument();
    expect(api.saveScheduleA).not.toHaveBeenCalled();
  });
});

describe('an activity this engine cannot compute', () => {
  it('is named with its reason rather than offered and dropped later', async () => {
    await mounted();
    const kinds = screen.getAllByRole('combobox').find((c) =>
      within(c as HTMLSelectElement).queryByRole('option', { name: 'Add…' }),
    )!;
    // Not in the list a preparer can choose from…
    expect(within(kinds as HTMLSelectElement).queryByRole('option', { name: /Farm/ })).toBeNull();
    // …and not silently missing either.
    expect(screen.getByText(/Farm \(Schedule F\) cannot be included/)).toBeInTheDocument();
    expect(screen.getByText(/refuses a schedule_f node/)).toBeInTheDocument();
  });
});
