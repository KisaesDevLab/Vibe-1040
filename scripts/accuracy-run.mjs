#!/usr/bin/env node
/**
 * Extraction accuracy harness (P4, P7, P8).
 *
 *   npm run accuracy -- <bundleId> [--json]
 *
 * Scores what the pipeline actually extracted against `test/fixtures/manifest.json`, which
 * records the true value of every field on every fixture.
 *
 * The report opens with the models that actually served the bundle — classifier, layout
 * (with the coordinate convention it returned), and field extraction — so two runs against
 * different router policy bindings can be compared without guessing what produced them.
 * `--json` prints the scores and that provenance as one line for diffing.
 *
 * The headline number is not the interesting one. Three sub-scores matter more:
 *
 *   - **blank-vs-zero**, reported separately, because a pipeline that scores 99% overall
 *     while confusing an empty box with a printed zero has failed at the one thing this
 *     product exists to do (§5);
 *   - **span coverage**, because a right answer with no provenance is not usable in review;
 *   - **classification**, because a misclassified page means the wrong schema, and every
 *     field under it is wrong for a reason no field-level score explains.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const bundleId = args.find((a) => !a.startsWith('--'));
if (!bundleId) {
  console.error('usage: npm run accuracy -- <bundleId> [--json]');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

const manifest = JSON.parse(
  await readFile(join(process.cwd(), 'test', 'fixtures', 'manifest.json'), 'utf8'),
);

/** filename → ground truth, for every document across every fixture bundle. */
const truthByFile = new Map();
for (const bundle of manifest.bundles) {
  for (const doc of bundle.documents) {
    const list = truthByFile.get(doc.file) ?? [];
    list.push(doc);
    truthByFile.set(doc.file, list);
  }
}

const { rows: docs } = await pool.query(
  `SELECT d.id, d.form_type, d.tax_year, d.corrected, d.is_supplemental,
          sf.filename, p.page_number
     FROM documents d
     JOIN pages p ON p.document_id = d.id
     JOIN source_files sf ON sf.id = p.source_file_id
    WHERE d.bundle_id = $1
    ORDER BY sf.filename, p.page_number`,
  [bundleId],
);

if (!docs.length) {
  console.error(`no classified documents for bundle ${bundleId} — has the pipeline run?`);
  process.exit(1);
}

// ── provenance: which models actually served this bundle ─────────────────────
const distinct = (rows, key) => [...new Set(rows.map((r) => r[key]).filter((v) => v !== null))];

const { rows: classifierRows } = await pool.query(
  `SELECT DISTINCT classifier_model FROM documents WHERE bundle_id = $1`,
  [bundleId],
);
const { rows: layoutRows } = await pool.query(
  `SELECT DISTINCT ls.produced_by_model, p.layout_coord_convention
     FROM layout_spans ls JOIN pages p ON p.id = ls.page_id
    WHERE p.bundle_id = $1`,
  [bundleId],
);
const { rows: extractRows } = await pool.query(
  `SELECT DISTINCT ef.produced_by_model
     FROM extracted_fields ef JOIN documents d ON d.id = ef.document_id
    WHERE d.bundle_id = $1`,
  [bundleId],
);

const provenance = {
  classify: distinct(classifierRows, 'classifier_model'),
  layout: distinct(layoutRows, 'produced_by_model'),
  layoutConventions: distinct(layoutRows, 'layout_coord_convention'),
  extract: distinct(extractRows, 'produced_by_model'),
};

const score = {
  classification: { correct: 0, wrong: 0, details: [] },
  fields: { correct: 0, wrong: 0, missing: 0, details: [] },
  blankVsZero: { correct: 0, wrong: 0, details: [] },
  spans: { withSpan: 0, withoutSpan: 0 },
};

const seen = new Set();

for (const doc of docs) {
  if (seen.has(doc.id)) continue;
  seen.add(doc.id);

  const candidates = truthByFile.get(doc.filename) ?? [];
  const truth = candidates.find((t) => t.page === doc.page_number) ?? candidates[0];
  if (!truth) continue;

  // ── classification ───────────────────────────────────────────────────────
  if (doc.form_type === truth.formType) {
    score.classification.correct += 1;
  } else {
    score.classification.wrong += 1;
    score.classification.details.push(
      `${doc.filename} p${doc.page_number}: got ${doc.form_type ?? 'null'}, expected ${truth.formType ?? 'null'}`,
    );
  }

  // ── fields ───────────────────────────────────────────────────────────────
  const { rows: fields } = await pool.query(
    `SELECT field_key, value_cents, value_text, value_bool, cardinality(span_ids) AS spans
       FROM extracted_fields WHERE document_id = $1`,
    [doc.id],
  );
  const got = new Map(fields.map((f) => [f.field_key, f]));

  for (const [key, expected] of Object.entries(truth.fields ?? {})) {
    const actual = got.get(key);

    if (!actual) {
      score.fields.missing += 1;
      score.fields.details.push(`${doc.filename} ${key}: not extracted (expected ${expected})`);
      continue;
    }

    if (actual.spans > 0) score.spans.withSpan += 1;
    else score.spans.withoutSpan += 1;

    const actualValue =
      actual.value_cents !== null ? actual.value_cents
      : actual.value_bool !== null ? actual.value_bool
      : actual.value_text;

    const match =
      expected === null ? actualValue === null
      : typeof expected === 'number' ? actual.value_cents === expected
      : typeof expected === 'boolean' ? actual.value_bool === expected
      : String(actualValue ?? '').trim().toUpperCase() === String(expected).trim().toUpperCase();

    if (match) score.fields.correct += 1;
    else {
      score.fields.wrong += 1;
      score.fields.details.push(
        `${doc.filename} ${key}: got ${JSON.stringify(actualValue)}, expected ${JSON.stringify(expected)}`,
      );
    }

    // The distinction that matters most, scored on its own.
    const expectedIsBlank = expected === null;
    const expectedIsZero = expected === 0;
    if (expectedIsBlank || expectedIsZero) {
      const actualIsBlank = actualValue === null;
      const actualIsZero = actual.value_cents === 0;
      const right = (expectedIsBlank && actualIsBlank) || (expectedIsZero && actualIsZero);
      if (right) score.blankVsZero.correct += 1;
      else {
        score.blankVsZero.wrong += 1;
        score.blankVsZero.details.push(
          `${doc.filename} ${key}: expected ${expectedIsBlank ? 'BLANK' : 'ZERO'}, ` +
            `got ${actualIsBlank ? 'BLANK' : actualIsZero ? 'ZERO' : JSON.stringify(actualValue)}`,
        );
      }
    }
  }
}

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);
const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
const listOrNone = (xs) => (xs.length ? xs.join(', ') : '(none)');

const failed = score.blankVsZero.wrong > 0 || score.classification.wrong > 0;

if (asJson) {
  const strip = ({ details: _details, ...rest }) => rest;
  console.log(
    JSON.stringify({
      bundleId,
      models: provenance,
      classification: strip(score.classification),
      fields: strip(score.fields),
      blankVsZero: strip(score.blankVsZero),
      spans: score.spans,
      pass: !failed,
    }),
  );
  await pool.end();
  process.exit(failed ? 1 : 0);
}

console.log(`\nExtraction accuracy — bundle ${bundleId}\n${'='.repeat(64)}`);

console.log('\nModels that served this bundle');
line('classify', listOrNone(provenance.classify));
line('layout', `${listOrNone(provenance.layout)}  (convention: ${listOrNone(provenance.layoutConventions)})`);
line('extract', listOrNone(provenance.extract));

const classTotal = score.classification.correct + score.classification.wrong;
console.log('\nClassification (P4)');
line('documents classified correctly', `${score.classification.correct}/${classTotal}  ${pct(score.classification.correct, classTotal)}`);

const fieldTotal = score.fields.correct + score.fields.wrong + score.fields.missing;
console.log('\nField extraction (P8)');
line('exact matches', `${score.fields.correct}/${fieldTotal}  ${pct(score.fields.correct, fieldTotal)}`);
line('wrong values', String(score.fields.wrong));
line('not extracted at all', String(score.fields.missing));

const bvzTotal = score.blankVsZero.correct + score.blankVsZero.wrong;
console.log('\nBlank versus printed zero (§5) — the one that matters');
line('correct', `${score.blankVsZero.correct}/${bvzTotal}  ${pct(score.blankVsZero.correct, bvzTotal)}`);

const spanTotal = score.spans.withSpan + score.spans.withoutSpan;
console.log('\nProvenance (§4)');
line('fields tied to a layout span', `${score.spans.withSpan}/${spanTotal}  ${pct(score.spans.withSpan, spanTotal)}`);
line('orphans (forced to review)', String(score.spans.withoutSpan));

for (const [title, details] of [
  ['Classification errors', score.classification.details],
  ['Blank/zero errors', score.blankVsZero.details],
  ['Field errors', score.fields.details],
]) {
  if (!details.length) continue;
  console.log(`\n${title}:`);
  for (const d of details.slice(0, 25)) console.log(`  - ${d}`);
  if (details.length > 25) console.log(`  ... and ${details.length - 25} more`);
}

console.log();
await pool.end();

// Blank-vs-zero is the gating metric. Anything less than perfect there is a failure
// regardless of how good the headline number looks.
process.exit(failed ? 1 : 0);
