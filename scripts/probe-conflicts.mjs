#!/usr/bin/env node
/**
 * Verify the node map's `supersedes` pairs against a running engine (P18).
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────
 *
 * Some engine fields can be fed from two directions: from a document this app read, and from a
 * figure the preparer typed. Where both arrive, engine 2.0.4 **silently discards the preparer's**
 * — a 1098 of 40,000 beats a typed 55,000, with no rejection and no diagnostic. So the app sends
 * only one of them, and records the other as an omission.
 *
 * That behaviour is not documented anywhere and is not derivable from field names. It was
 * measured, and it has to stay measured: a future engine release could start adding the two, or
 * start letting the preparer win, and either would change what the app should send. This script
 * is how that is re-checked, and it belongs in the upgrade procedure
 * (docs/opentax-draft-return.md §7) beside `npm run draft -- --truth`.
 *
 * ── How it measures ────────────────────────────────────────────────────────────────────────
 *
 * For each pair, the same return is computed four ways — neither side, document only, preparer
 * only, both — and the engine's own output says which figure it used. Two traps are avoided:
 *
 *  - **The SALT cap saturates the line.** TY2025 caps state and local taxes at 40,000. An early
 *    version of this probe used 200,000 on both sides, got 40,000 every time, and concluded the
 *    two figures added. They do not. Amounts here stay well under the cap.
 *  - **Itemising has to win.** A large charitable contribution is added so the itemised total
 *    plainly beats the standard deduction; otherwise line 12c reports a figure that moves for
 *    reasons unrelated to the pair under test.
 *
 * Usage:  OPENTAX_URL=http://127.0.0.1:8230 node scripts/probe-conflicts.mjs
 * Exits non-zero if any pair no longer behaves the way the node map assumes.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const URL_ = `${process.env.OPENTAX_URL ?? 'http://127.0.0.1:8230'}/draft`;
const TAX_YEAR = Number(process.env.TAX_YEAR ?? 2025);

/** Well under the TY2025 SALT cap of 40,000, and distinct so the winner is unambiguous. */
const DOC_AMOUNT = 5_000;
const PREPARER_AMOUNT = 9_000;
/** Enough to make itemising beat the standard deduction on its own. */
const CHARITY = 100_000;

/** Minimum payload each node type needs before the engine will look at it at all. */
const REQUIRED = {
  w2: { employer_name: 'Probe', box1_wages: 0, box2_fed_withheld: 0 },
  f1098: { box1_mortgage_interest: 0 },
  f1099g: {},
  f1099k: { pse_name: 'Probe' },
  f1099nec: { payer_name: 'Probe', payer_tin: '00-0000000' },
  f1099r: { payer_name: 'Probe', payer_ein: '00-0000000', box1_gross_distribution: 0, box7_distribution_code: '7' },
  f1099oid: { payer_name: 'Probe' },
  w2g: {},
};

const flat = (v) => (Array.isArray(v) ? v[0] : v);

async function deduction(nodes, scheduleA = {}) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taxYear: TAX_YEAR,
      nodes: [
        { nodeType: 'general', documentId: null, payload: { filing_status: 'mfj' } },
        { nodeType: 'w2', documentId: 'anchor', payload: { employer_name: 'Anchor', box1_wages: 400_000, box2_fed_withheld: 50_000 } },
        { nodeType: 'schedule_a', documentId: null, payload: { line_11_cash_contributions: CHARITY, ...scheduleA } },
        ...nodes,
      ],
    }),
  });
  if (!res.ok) throw new Error(`engine returned ${res.status}`);
  const body = await res.json();
  return { cents: flat((body.lines ?? {}).line12c_deduction_total), rejected: (body.rejected ?? []).length };
}

/** `document_wins` is what the node map's `supersedes` entries assume. */
function classify(dDoc, dPreparer, dBoth) {
  if (dDoc === 0) return 'no_conflict';
  if (dBoth === dDoc + dPreparer) return 'they_add';
  if (dBoth === dDoc) return 'document_wins';
  if (dBoth === dPreparer) return 'preparer_wins';
  return 'unclear';
}

const root = process.cwd();
const file = JSON.parse(await readFile(join(root, 'data', 'opentax-nodes', `${TAX_YEAR}.json`), 'utf8'));
const pairs = [];
for (const field of file.preparerInputs?.scheduleA?.fields ?? []) {
  for (const sup of field.supersedes ?? []) {
    pairs.push({ scheduleField: field.nodeField, ...sup });
  }
}

if (pairs.length === 0) {
  console.log('No `supersedes` pairs declared in the node map. Nothing to verify.');
  process.exit(0);
}

const base = (await deduction([])).cents;
console.log(`engine at ${URL_}, tax year ${TAX_YEAR}`);
console.log(`baseline itemised deduction (charity only) = ${base}\n`);

let failures = 0;
for (const pair of pairs) {
  const docNodes = [{ nodeType: pair.nodeType, documentId: 'probe', payload: { ...(REQUIRED[pair.nodeType] ?? {}), [pair.nodeField]: DOC_AMOUNT } }];
  const docOnly = await deduction(docNodes);
  if (docOnly.rejected > 0) {
    console.log(`  ✗ ${pair.nodeType}.${pair.nodeField}: probe payload refused — cannot verify`);
    failures += 1;
    continue;
  }
  const preparerOnly = await deduction([], { [pair.scheduleField]: PREPARER_AMOUNT });
  const both = await deduction(docNodes, { [pair.scheduleField]: PREPARER_AMOUNT });

  const verdict = classify(docOnly.cents - base, preparerOnly.cents - base, both.cents - base);
  const ok = verdict === 'document_wins';
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? '✓' : '✗'} ${pair.nodeType}.${pair.nodeField} → schedule_a.${pair.scheduleField}: ${verdict}` +
      (ok ? '' : `  (doc ${docOnly.cents - base}, preparer ${preparerOnly.cents - base}, both ${both.cents - base})`),
  );
}

console.log();
if (failures > 0) {
  console.error(
    `${failures} pair(s) no longer behave as the node map assumes.\n` +
      'The map sends only one side of each pair and records the other as an omission, which is\n' +
      'correct only while the engine discards the second. Re-read docs/opentax-draft-return.md §7\n' +
      'before changing either side.',
  );
  process.exit(1);
}
console.log(`All ${pairs.length} pair(s) behave as the node map assumes: the document wins and the preparer's figure would be discarded.`);
