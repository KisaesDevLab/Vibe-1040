#!/usr/bin/env node
/**
 * Draft-return harness (P17 stage 3).
 *
 *   npm run draft -- --truth [--bundle <name>] [--json]
 *   npm run draft -- <bundleId> [--json]
 *
 * Scores computed 1040 lines against the hand-derived expectations in
 * `test/fixtures/manifest.json` (`expectedDraftReturn`). Those expectations were worked out by
 * addition from the printed boxes, never by running this repo's code — otherwise the harness
 * would be scoring the mapping against itself.
 *
 * **Two modes, and the difference between them is the point.**
 *
 *   --truth      Builds engine input straight from the manifest's ground-truth field values,
 *                so extraction is not involved at all. What this scores is the node map plus
 *                the engine. Needs no database and no pipeline run.
 *
 *   <bundleId>   Scores a processed bundle's stored draft return. This is extraction *and* the
 *                node map *and* the engine, together.
 *
 * Run both and the delta isolates extraction error from mapping and engine error — which is
 * the thing STATE.md has been unable to measure since the build began. A line that is right
 * in `--truth` and wrong for a real bundle is an extraction defect; wrong in both is a
 * mapping or engine defect.
 *
 * Exits non-zero when anything disagrees, so it is usable as a gate.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fromTruth = args.includes('--truth');
// indexOf returns -1 when the flag is absent, and args[0] would then become the filter.
const bundleFlag = args.indexOf('--bundle');
const bundleFilter = bundleFlag >= 0 ? args[bundleFlag + 1] : undefined;
const bundleId = args.find((a) => !a.startsWith('--') && a !== bundleFilter);

if (!fromTruth && !bundleId) {
  console.error('usage: npm run draft -- --truth [--bundle <name>] [--json]');
  console.error('       npm run draft -- <bundleId> [--json]');
  process.exit(2);
}

const manifest = JSON.parse(
  await readFile(join(process.cwd(), 'test', 'fixtures', 'manifest.json'), 'utf8'),
);

const fmt = (cents) =>
  cents === null || cents === undefined
    ? '—'
    : (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Every finding, so the summary can count without re-deriving. */
const findings = [];
const record = (bundle, lineRef, verdict, expected, actual, why) =>
  findings.push({ bundle, lineRef, verdict, expected, actual, why });

// ── mode 1: from the manifest's ground truth ────────────────────────────────

async function runFromTruth() {
  // Imported lazily so the pipeline mode does not pay for the registry.
  const { loadNodeMap } = await import('../src/draft/nodes.ts');
  const { buildDraftInput } = await import('../src/draft/translate.ts');
  const { computeReturn, engineHealth } = await import('../src/draft/client.ts');
  const { toCents } = await import('../src/draft/compare.ts');
  const { registry } = await import('../src/schemas/registry.ts');

  const health = await engineHealth();
  if (!health.ok) {
    console.error(
      `the OpenTax engine is not reachable (${health.reason}). Start the sidecar:\n` +
        '  docker compose --profile draft-return up -d opentax',
    );
    process.exit(3);
  }

  const taxYear = manifest.taxYear;
  const file = await loadNodeMap(taxYear);
  const reg = await registry();

  console.log(`engine        ${health.version}`);
  console.log(`node map      ${file.version}`);
  console.log(`tax year      ${taxYear}`);
  console.log(`mode          --truth (ground-truth values; extraction not involved)\n`);

  for (const bundle of manifest.bundles) {
    if (bundleFilter && bundle.name !== bundleFilter) continue;
    const expected = bundle.expectedDraftReturn;
    if (!expected) continue;

    // Ground-truth fields, shaped exactly as resolved fields are. Every value carries a span
    // and is unflagged, because the question here is the map and the engine, not extraction.
    const documents = [];
    for (const doc of bundle.documents) {
      if (!doc.formType) continue;
      const schema = reg.get(doc.formType, taxYear) ?? reg.resolve(doc.formType, taxYear)?.schema;
      if (!schema) continue;

      const fields = new Map();
      for (const [key, value] of Object.entries(doc.fields ?? {})) {
        const field = schema.fields.find((f) => f.key === key);
        if (!field) continue;
        const cents = typeof value === 'number' ? value : null;
        const bool = typeof value === 'boolean' ? value : null;
        const text = typeof value === 'string' ? value : null;
        fields.set(key, {
          cents,
          text,
          bool,
          spanIds: ['00000000-0000-0000-0000-000000000001'],
          present: value !== null && value !== undefined,
          needsReview: false,
        });
      }
      documents.push({
        documentId: `${doc.file}#${doc.page ?? 1}`,
        formType: doc.formType,
        taxYear: doc.taxYear ?? taxYear,
        schema,
        fields,
      });
    }

    // Filing status is the reviewer's to state; the harness states one so the engine has a
    // complete `general` node, and says so.
    // The engine's own code, from the map, rather than a long name it would refuse.
    const mfj = file.filingStatuses.find((f) => f.code === 'mfj') ?? file.filingStatuses[0];
    const input = buildDraftInput(file, documents, { filingStatus: mfj.code });
    const result = await computeReturn(taxYear, input.nodes);

    console.log(`── ${bundle.name} ${'─'.repeat(Math.max(0, 52 - bundle.name.length))}`);
    if (expected.note) console.log(`   ${expected.note}`);
    console.log(
      `   ${input.documentsIncluded} document(s) to the engine, ${input.documentsWithheld} withheld`,
    );
    // A node the engine refused contributes nothing, so its lines read as absent. Say so here
    // rather than leaving a reader to infer it from a column of dashes.
    for (const r of result.rejected) {
      console.log(`   ! engine refused the ${r.nodeType} node: ${r.message.split('\n')[0]}`);
    }

    const comparable = new Map(file.lines.comparable.map((l) => [l.lineRef, l]));
    for (const [lineRef, want] of Object.entries(expected.lines ?? {})) {
      const map = comparable.get(lineRef);
      if (!map) {
        // The line is declared notCompared, so the engine has nothing to check against and
        // the expectation is about the worksheet alone. Reported, not scored.
        record(bundle.name, lineRef, 'not_compared', want.engineVisible, null, want.why);
        console.log(`   ~ ${lineRef.padEnd(16)} not compared against the engine`);
        continue;
      }
      // The engine's `lines` map is flat, keyed by line name; `engineForm` is a label. The
      // conversion is imported rather than repeated: a local copy missed that some values
      // arrive as arrays, and every array-valued line silently read as nothing.
      const actual = toCents(result.lines?.[map.engineLine]);
      const want_ = want.engineVisible ?? null;

      if (actual === want_) {
        record(bundle.name, lineRef, 'ok', want_, actual, want.why);
        console.log(`   ✓ ${lineRef.padEnd(16)} ${fmt(actual).padStart(14)}`);
      } else {
        record(bundle.name, lineRef, 'mismatch', want_, actual, want.why);
        console.log(
          `   ✗ ${lineRef.padEnd(16)} expected ${fmt(want_).padStart(14)}, engine ${fmt(actual).padStart(14)}` +
            (want.withheldBecause ? `   [expected withheld: ${want.withheldBecause}]` : ''),
        );
        if (want.why) console.log(`       ${want.why}`);
      }
    }
    console.log();
  }
}

// ── mode 2: a processed bundle's stored draft return ────────────────────────

async function runFromBundle() {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: drafts } = await pool.query(
    `SELECT id, tax_year, engine_version, node_map_version, mapping_version,
            complete, documents_included, documents_withheld
       FROM draft_returns WHERE bundle_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [bundleId],
  );
  const draft = drafts[0];
  if (!draft) {
    console.error(
      `no draft return stored for bundle ${bundleId}. Compute one first:\n` +
        `  POST /api/bundles/${bundleId}/draft-return`,
    );
    await pool.end();
    process.exit(3);
  }

  const { rows: lines } = await pool.query(
    `SELECT line_ref, computed_cents, reported_cents, verdict
       FROM draft_return_lines WHERE draft_return_id = $1`,
    [draft.id],
  );
  const { rows: bundleRows } = await pool.query(`SELECT label FROM bundles WHERE id = $1`, [
    bundleId,
  ]);

  console.log(`engine        ${draft.engine_version}`);
  console.log(`node map      ${draft.node_map_version}`);
  console.log(`line mapping  ${draft.mapping_version}`);
  console.log(`bundle        ${bundleRows[0]?.label ?? bundleId}`);
  console.log(
    `mode          pipeline (extraction + node map + engine); ` +
      `${draft.documents_included} in, ${draft.documents_withheld} withheld, ` +
      `complete=${draft.complete}\n`,
  );

  // Match the bundle to a fixture by label, so a fixture bundle run through the real pipeline
  // scores against the same expectations `--truth` uses.
  const fixture = manifest.bundles.find(
    (b) => b.label === bundleRows[0]?.label || b.name === bundleFilter,
  );
  if (!fixture?.expectedDraftReturn) {
    console.log('no fixture expectations match this bundle; printing the draft without scoring.\n');
    for (const line of lines) {
      console.log(
        `   ${String(line.line_ref ?? '(engine only)').padEnd(16)} ` +
          `reported ${fmt(line.reported_cents).padStart(14)}  ` +
          `computed ${fmt(line.computed_cents).padStart(14)}  ${line.verdict}`,
      );
    }
    await pool.end();
    return;
  }

  const byRef = new Map(lines.filter((l) => l.line_ref).map((l) => [l.line_ref, l]));
  for (const [lineRef, want] of Object.entries(fixture.expectedDraftReturn.lines ?? {})) {
    const row = byRef.get(lineRef);
    const actual = row?.computed_cents ?? null;
    const want_ = want.engineVisible ?? null;
    if (actual === want_) {
      record(fixture.name, lineRef, 'ok', want_, actual, want.why);
      console.log(`   ✓ ${lineRef.padEnd(16)} ${fmt(actual).padStart(14)}`);
    } else {
      record(fixture.name, lineRef, 'mismatch', want_, actual, want.why);
      console.log(
        `   ✗ ${lineRef.padEnd(16)} expected ${fmt(want_).padStart(14)}, engine ${fmt(actual).padStart(14)}`,
      );
      if (want.why) console.log(`       ${want.why}`);
    }
  }
  console.log();
  await pool.end();
}

// ── run ─────────────────────────────────────────────────────────────────────

if (fromTruth) await runFromTruth();
else await runFromBundle();

const ok = findings.filter((f) => f.verdict === 'ok').length;
const mismatched = findings.filter((f) => f.verdict === 'mismatch');
const notCompared = findings.filter((f) => f.verdict === 'not_compared').length;

if (asJson) {
  console.log(JSON.stringify({ ok, mismatched: mismatched.length, notCompared, findings }, null, 2));
} else {
  console.log(`${ok} agreed, ${mismatched.length} disagreed, ${notCompared} not compared.`);
  if (mismatched.length > 0) {
    console.log('\nDisagreements:');
    for (const f of mismatched) {
      console.log(`  ${f.bundle} ${f.lineRef}: expected ${fmt(f.expected)}, got ${fmt(f.actual)}`);
    }
    console.log(
      '\nA line that is right under --truth and wrong for a real bundle is an extraction\n' +
        'defect. Wrong in both is the node map or the engine.',
    );
  }
}

process.exit(mismatched.length > 0 ? 1 : 0);
