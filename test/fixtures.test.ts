import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMoney } from '../src/lib/money.ts';
import { FormRegistry } from '../src/schemas/registry.ts';

/**
 * The fixture set and its ground truth (`test/fixtures/manifest.json`).
 *
 * These tests do not run extraction — that needs a router. They check the thing that would
 * otherwise rot silently: that the fixtures exist, that the manifest's expected values are
 * expressible in the registered schemas, and that the cases each phase's exit criteria
 * depend on are actually present.
 *
 * Regenerate with: python fixtures/generate.py test/fixtures
 */
const DIR = join(process.cwd(), 'test', 'fixtures');

interface DocTruth {
  file: string;
  page: number;
  formType: string | null;
  taxYear: number;
  fields: Record<string, number | string | boolean | null>;
  expectedHardFailure?: string | null;
  expectedSoftFailure?: string;
  allJudgmentRequired?: boolean;
  isSummary?: boolean;
  isSupplemental?: boolean;
  parentPage?: number;
  rendering?: string;
  planted?: string;
}

interface Manifest {
  taxYear: number;
  bundles: {
    name: string;
    label: string;
    expectedTaxYear: number;
    expectedTaxpayers: { name: string; tinLast4: string; kind: string }[];
    documents: DocTruth[];
  }[];
  degradedVariants: { file: string; derivedFrom: string | null; expectedRoute: string; why: string }[];
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8')) as Manifest;
}

const allDocs = (m: Manifest): DocTruth[] => m.bundles.flatMap((b) => b.documents);

describe('fixture set', () => {
  it('exists on disk with every file the manifest names', async () => {
    const m = await manifest();
    const onDisk = new Set(await readdir(DIR));
    for (const doc of allDocs(m)) {
      expect(onDisk.has(doc.file), `missing fixture ${doc.file}`).toBe(true);
    }
    for (const variant of m.degradedVariants) {
      expect(onDisk.has(variant.file), `missing variant ${variant.file}`).toBe(true);
    }
  });

  it('covers the native / scanned / phone-photo triage cases (P2)', async () => {
    const m = await manifest();
    const routes = new Map(m.degradedVariants.map((v) => [v.file, v.expectedRoute]));
    expect(routes.get('w2_robert_native.pdf')).toBe('text_layer');
    expect(routes.get('w2_robert_scanned.pdf')).toBe('raster');
    expect(routes.get('w2_robert_phone.jpg')).toBe('raster');
  });

  it('every expected field key exists in the registered schema for its form type', async () => {
    const m = await manifest();
    const registry = await FormRegistry.load(join(process.cwd(), 'data', 'form-schemas'));

    for (const doc of allDocs(m)) {
      if (!doc.formType) continue;
      const schema = registry.resolve(doc.formType, doc.taxYear)?.schema;
      expect(schema, `no schema for ${doc.formType} ${doc.taxYear}`).toBeDefined();
      const known = new Set(schema!.fields.map((f) => f.key));
      for (const key of Object.keys(doc.fields)) {
        expect(known.has(key), `${doc.formType}.${key} is not a registered field`).toBe(true);
      }
    }
  });

  it('distinguishes a blank box from a printed zero on the W-2 (§5, P8)', async () => {
    const m = await manifest();
    const w2 = allDocs(m).find((d) => d.file === 'w2_robert_native.pdf')!;
    // Box 7 is empty on the form; box 8 prints "-0-".
    expect(w2.fields['box_7']).toBeNull();
    expect(w2.fields['box_8']).toBe(0);

    // And the two must not parse to the same thing.
    expect(parseMoney(null)).toEqual({ kind: 'blank' });
    expect(parseMoney('-0-')).toEqual({ kind: 'amount', cents: 0 });
  });

  it('includes a W-2 whose payroll boxes reconcile exactly (P9)', async () => {
    const m = await manifest();
    const w2 = allDocs(m).find((d) => d.file === 'w2_robert_native.pdf')!;
    const box3 = w2.fields['box_3'] as number;
    const box4 = w2.fields['box_4'] as number;
    const box5 = w2.fields['box_5'] as number;
    const box6 = w2.fields['box_6'] as number;
    expect(box4).toBe(Math.round(box3 * 0.062));
    expect(box6).toBe(Math.round(box5 * 0.0145));
    // ...and a legitimate 401(k)-driven box 1 vs box 3 gap, which annotates and proceeds.
    expect(w2.fields['box_1']).toBeLessThan(box3);
    expect(w2.expectedSoftFailure).toBe('w2_box1_vs_box3_box5');
  });

  it('includes a joint bundle with two TINs, one of them an ITIN (§7)', async () => {
    const m = await manifest();
    const joint = m.bundles.find((b) => b.name === 'smith-joint-2025')!;
    expect(joint.expectedTaxpayers).toHaveLength(2);
    expect(joint.expectedTaxpayers.map((t) => t.kind).sort()).toEqual(['ITIN', 'SSN']);
  });

  it('includes a planted prior-year document (§7)', async () => {
    const m = await manifest();
    const planted = allDocs(m).find((d) => d.planted);
    expect(planted).toBeDefined();
    expect(planted!.taxYear).toBe(2024);
    expect(planted!.expectedSoftFailure).toBe('tax_year_matches_bundle');
  });

  it('includes three consolidated packages, one of which fails to tie (P4, §6)', async () => {
    const m = await manifest();
    const brokers = m.bundles.find((b) => b.name === 'brokerage-packages-2025')!;
    const summaries = brokers.documents.filter((d) => d.formType === '1099-CONSOLIDATED');
    expect(summaries).toHaveLength(3);

    // Sub-forms are parented to their package summary.
    const subforms = brokers.documents.filter((d) => d.parentPage === 1 && d.formType !== null);
    expect(subforms.length).toBeGreaterThanOrEqual(6);
    expect(new Set(subforms.map((d) => d.formType))).toEqual(new Set(['1099-INT', '1099-DIV', '1099-B']));

    // Supplemental, non-form pages are marked as such.
    expect(brokers.documents.some((d) => d.isSupplemental)).toBe(true);

    // Exactly one package is planted with a summary that does not tie.
    const broken = summaries.filter((d) => d.expectedHardFailure);
    expect(broken).toHaveLength(1);
    expect(broken[0]!.expectedHardFailure).toContain('consolidated_subforms_tie_to_summary');
  });

  it('includes a noncovered 1099-B lot with no basis, which is Judgment Required (§9)', async () => {
    const m = await manifest();
    const noncovered = allDocs(m).filter(
      (d) => d.formType === '1099-B' && d.fields['box_5_noncovered'] === true,
    );
    expect(noncovered.length).toBeGreaterThanOrEqual(1);
    // A noncovered lot prints no basis at all — blank, not zero.
    expect(noncovered[0]!.fields['summary_total_cost_basis']).toBeNull();
  });

  it('includes a CORRECTED 1099 flagged at classification (P4)', async () => {
    const m = await manifest();
    const corrected = allDocs(m).find((d) => d.fields['corrected'] === true);
    expect(corrected).toBeDefined();
    expect(corrected!.formType).toBe('1099-INT');
  });

  it('includes a code G rollover with taxable amount not determined (§9)', async () => {
    const m = await manifest();
    const r = allDocs(m).find((d) => d.formType === '1099-R')!;
    expect(r.fields['box_7_code']).toBe('G');
    expect(r.fields['box_2a']).toBeNull();
    expect(r.fields['box_2b_not_determined']).toBe(true);
    expect(r.expectedSoftFailure).toBe('r_taxable_not_determined');
  });

  it('includes a full-year 1095-A whose monthly rows foot to the annual row (§6)', async () => {
    const m = await manifest();
    const a = allDocs(m).find((d) => d.formType === '1095-A')!;
    const months = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    for (const column of ['premium', 'slcsp', 'aptc'] as const) {
      const sum = months.reduce((n, mo) => n + (a.fields[`monthly_${mo}_${column}`] as number), 0);
      expect(sum).toBe(a.fields[`annual_${column}`]);
    }
  });

  it('includes K-1s from three different tax-package renderings (P15)', async () => {
    const m = await manifest();
    const k1s = allDocs(m).filter((d) => d.formType === 'K-1-1065');
    expect(k1s).toHaveLength(3);
    expect(new Set(k1s.map((d) => d.rendering))).toEqual(new Set(['UltraTax', 'CCH', 'Lacerte']));
    for (const k1 of k1s) {
      expect(k1.allJudgmentRequired).toBe(true);
      expect(k1.fields['box_20_code_z_statement_present']).toBe(true);
      expect(k1.fields['footnote_pages_present']).toBe(true);
    }
  });

  it('contains no real-looking SSN outside the invented set', async () => {
    const m = await manifest();
    const raw = JSON.stringify(m);
    // The manifest records last-four only; full TINs live in the PDFs, never here.
    expect(/\b\d{3}-\d{2}-\d{4}\b/.test(raw)).toBe(false);
  });
});
