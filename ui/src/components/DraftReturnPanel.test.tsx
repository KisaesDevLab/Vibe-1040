import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.ts';
import type { DraftInputs } from '../types.ts';
import { DraftReturnPanel } from './DraftReturnPanel.tsx';

/**
 * The draft-return panel (P17, P18), rendered.
 *
 * One defect is the reason this file exists. The panel shipped with a **dead filing-status
 * control** for a week: the status route was asked for a vocabulary using the wall-clock year
 * when the only node map was the previous season's, a bare `catch` swallowed the miss, and the
 * select rendered with no options above a button that could never be pressed. It compiled, it
 * type-checked, nothing threw, and no test could have caught it because there was no test.
 *
 * So the assertions here are about **controls the panel is entitled to offer**: it renders
 * nothing at all when the feature is off or the engine is down, it says what is missing rather
 * than offering an empty vocabulary, and it will not offer to compute until the one thing no
 * document carries has been stated.
 */
vi.mock('../api.ts', async () => {
  const actual = await vi.importActual<typeof import('../api.ts')>('../api.ts');
  return {
    formatCents: actual.formatCents,
    api: { draftReturnStatus: vi.fn(), draftInputs: vi.fn(), computeDraftReturn: vi.fn() },
  };
});

const STATUS_UP = {
  enabled: true,
  engine: { ok: true, version: '2.0.4' },
  expectedVersion: '2.0.4',
  filingStatuses: [
    { code: 'single', label: 'Single' },
    { code: 'mfj', label: 'Married filing jointly' },
  ],
  filingStatusYear: 2025,
};

function inputs(over: Partial<DraftInputs> = {}): DraftInputs {
  return {
    filingStatus: null, taxpayerAge65OrOlder: null, spouseAge65OrOlder: null,
    taxpayerBlind: null, spouseBlind: null, dependents: [], scheduleA: null, activities: [],
    updatedAt: null, filingStatuses: STATUS_UP.filingStatuses, relationships: [],
    activityKinds: [], unsupportedActivities: [], scheduleAFields: [], dependentFields: [],
    documentBacked: [], ...over,
  };
}

const mount = () =>
  render(<DraftReturnPanel bundleId="b-1" taxYear={2025} onError={vi.fn()} />);

/**
 * Wait until both loads have resolved and React has flushed them.
 *
 * Without this, `expect(container).toBeEmptyDOMElement()` passes on the *pre-load* state — the
 * panel renders null until `status` arrives — so the assertion held whether or not the guard it
 * was written for existed. Found by mutation: deleting the engine-down guard left all fifteen
 * tests green.
 */
async function settled(): Promise<void> {
  await waitFor(() => expect(api.draftReturnStatus).toHaveBeenCalled());
  await waitFor(() => expect(api.draftInputs).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.draftInputs).mockResolvedValue(inputs());
});
afterEach(() => vi.clearAllMocks());

describe('a control the panel cannot honour is never offered', () => {
  it('renders nothing at all when the deployment has not enabled the feature', async () => {
    vi.mocked(api.draftReturnStatus).mockResolvedValue({ ...STATUS_UP, enabled: false });
    const { container } = mount();
    await settled();
    // Not a disabled button and not an error banner: this is an optional checking aid and its
    // absence is not a fault to report.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the engine is unreachable', async () => {
    vi.mocked(api.draftReturnStatus).mockResolvedValue({
      ...STATUS_UP,
      engine: { ok: false, version: null, reason: 'engine_unreachable' },
    });
    const { container } = mount();
    await settled();
    expect(container).toBeEmptyDOMElement();
  });

  it('says what is missing rather than offering an empty vocabulary', async () => {
    // The shape of the original defect: the server has no node map to answer with.
    vi.mocked(api.draftReturnStatus).mockResolvedValue({ ...STATUS_UP, filingStatuses: [], filingStatusYear: null });
    mount();

    expect(await screen.findByText(/No OpenTax node map is installed/)).toBeInTheDocument();
    // And no control that cannot work.
    expect(screen.queryByRole('button', { name: /Compute draft return/ })).toBeNull();
  });
});

describe('nothing computes until a filing status is stated', () => {
  it('offers the engine’s own codes and disables compute until one is chosen', async () => {
    vi.mocked(api.draftReturnStatus).mockResolvedValue(STATUS_UP);
    mount();

    const compute = await screen.findByRole('button', { name: /Compute draft return/ });
    expect(compute).toBeDisabled();
    expect(screen.getByText(/No source document says what the filing status is/)).toBeInTheDocument();
    // The engine's codes, not long names — the regression the real engine caught. They reach
    // this panel from the record, which is served from the node map.
    expect(await screen.findByRole('button', { name: /Preparer inputs/ })).toBeInTheDocument();
  });

  it('enables compute once the record carries one, and shows what has been stated', async () => {
    vi.mocked(api.draftReturnStatus).mockResolvedValue(STATUS_UP);
    vi.mocked(api.draftInputs).mockResolvedValue(
      inputs({
        filingStatus: 'mfj',
        dependents: [
          {
            id: 'd1', firstName: 'ANNA', lastName: 'SMITH', middleInitial: null, dob: '2014-03-02',
            relationship: 'daughter', monthsInHome: 12, qualifyingChildForCtc: true,
            disabled: null, fullTimeStudent: null, taxpayerProvidedOverHalfSupport: null,
            dependentOnAnotherReturn: null, grossIncomeCents: null,
          },
        ],
        scheduleA: { medicalCents: 82_540, mortgageInterest1098Cents: null },
      }),
    );
    mount();

    const compute = await screen.findByRole('button', { name: /Compute draft return/ });
    await waitFor(() => expect(compute).toBeEnabled());
    expect(screen.getByText('Married filing jointly')).toBeInTheDocument();
    // One itemised line stated, not two: a null is not a statement (§5).
    const summary = screen.getByText('Itemised lines').parentElement!;
    expect(summary).toHaveTextContent('1');
  });
});

describe('the panel never presents a draft as a return', () => {
  it('names the engine and its version, and says advisory, before any figure exists', async () => {
    vi.mocked(api.draftReturnStatus).mockResolvedValue(STATUS_UP);
    mount();
    expect(await screen.findByText(/Advisory, and never a finished return/)).toBeInTheDocument();
    expect(screen.getByText(/OpenTax engine 2\.0\.4/)).toBeInTheDocument();
  });
});
