#!/usr/bin/env node
/**
 * A stand-in for the OpenTax binary, for testing the wrapper (P17).
 *
 * It mimics the real CLI's surface and its statefulness — `return create` mints an id,
 * `form add` appends to state on disk, `return get` reads it back — so
 * `test/draft-wrapper.test.ts` can exercise `opentax/server.mjs` over real HTTP without the
 * engine present. It is the same trick `test/helpers/fake-idp.ts` plays for P16.
 *
 * It computes nothing: it sums W-2 box 1 so the test has a number to assert on, and nothing
 * here is a claim about what the real engine would return.
 *
 * `form add --node_type reject_me` fails, so the wrapper's "a refused node is reported, not
 * fatal" path is covered.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

// The wrapper sets HOME and cwd to a per-request temp directory. Writing state relative to
// cwd is what lets the test assert that nothing survives the response.
const stateDir = join(process.cwd(), '.fake-opentax');
const statePath = join(stateDir, 'state.jsonl');

const [group, sub] = argv;

if (group === 'version') {
  process.stdout.write('opentax 9.9.9-fake\n');
  process.exit(0);
}

if (group === 'return' && sub === 'create') {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, '');
  writeFileSync(join(stateDir, 'year'), String(flag('year') ?? ''));
  // The real CLI prints prose before its JSON, which is why the wrapper extracts the
  // outermost object rather than parsing the whole of stdout.
  process.stdout.write(`Created return for ${flag('year')}\n{"returnId":"fake-return-1"}\n`);
  process.exit(0);
}

if (group === 'form' && sub === 'add') {
  const nodeType = flag('node_type');
  if (nodeType === 'reject_me') {
    process.stderr.write('unknown node type: reject_me\n');
    process.exit(2);
  }
  const payload = argv[argv.length - 1];
  appendFileSync(statePath, `${JSON.stringify({ nodeType, payload: JSON.parse(payload) })}\n`);
  process.stdout.write('{"ok":true}\n');
  process.exit(0);
}

if (group === 'return' && sub === 'get') {
  const entries = readFileSync(statePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const sum = (nodeType, field) =>
    entries
      .filter((e) => e.nodeType === nodeType)
      .reduce((n, e) => n + Number(e.payload[field] ?? 0), 0);

  const wages = sum('w2', 'box1_wages');
  const withheld = sum('w2', 'box2_fed_withheld');
  // Enough arithmetic for the harness to be scored against something. Still not the engine:
  // these are plain sums, with no ordering, phase-out or characterization anywhere.
  const interest = sum('f1099int', 'box1') + sum('f1099oid', 'box2_other_interest');
  const ordinaryDividends = sum('f1099div', 'box1a');
  const qualifiedDividends = sum('f1099div', 'box1b');
  const mortgageInterest = sum('f1098', 'box1_mortgage_interest');
  // Routed on box 7's IRA/SEP/SIMPLE indicator, as the real form is: IRA distributions to
  // line 4a, everything else to 5a. Enough to make a §9 withholding regression visible.
  const iraGross = entries
    .filter((e) => e.nodeType === 'f1099r' && e.payload.box7_ira_simple_indicator === true)
    .reduce((n, e) => n + Number(e.payload.box1_gross_distribution ?? 0), 0);
  const pensionGross = entries
    .filter((e) => e.nodeType === 'f1099r' && e.payload.box7_ira_simple_indicator !== true)
    .reduce((n, e) => n + Number(e.payload.box1_gross_distribution ?? 0), 0);

  process.stdout.write(
    `${JSON.stringify({
      returnId: flag('returnId'),
      year: Number(readFileSync(join(stateDir, 'year'), 'utf8')),
      summary: { line1z_total_wages: wages, line11_agi: wages },
      forms: [...new Set(entries.map((e) => e.nodeType))],
      lines: {
        f1040: {
          line1a_wages: wages,
          line1z_total_wages: wages,
          line2b_taxable_interest: interest,
          line3a_qualified_dividends: qualifiedDividends,
          line3b_ordinary_dividends: ordinaryDividends,
          line4a_ira_gross: iraGross,
          line5a_pension_gross: pensionGross,
          line25a_w2_withheld: withheld,
          line9_total_income: wages + interest + ordinaryDividends,
          line11_agi: wages + interest + ordinaryDividends,
          line15_taxable_income: wages + interest + ordinaryDividends - 15_750,
        },
        schedule_a: { line8a_mortgage_interest: mortgageInterest },
      },
      warnings: entries.length === 0 ? ['no forms were added'] : [],
    })}\n`,
  );
  process.exit(0);
}

if (group === 'return' && sub === 'validate') {
  process.stdout.write(
    `${JSON.stringify({
      diagnostics: [
        { code: 'F1040-001', severity: 'error', message: 'filing status is required' },
        { code: 'F1040-900', severity: 'warning', message: 'no dependents were supplied' },
        // No severity at all: the wrapper must treat an unrecognised entry as hard, because
        // under-reporting a blocking diagnostic is the worse error.
        { code: 'F1040-XXX', message: 'unclassified' },
      ],
      warnings: ['a bare warnings[] entry too'],
    })}\n`,
  );
  process.exit(0);
}

process.stderr.write(`fake-opentax: unhandled command ${argv.join(' ')}\n`);
process.exit(64);
