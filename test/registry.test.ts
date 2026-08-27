import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FormRegistry, formSchema } from '../src/schemas/registry.ts';

const ROOT = join(process.cwd(), 'data', 'form-schemas');

/** P6 exit criteria. */
describe('form schema registry', () => {
  it('loads every registered schema', async () => {
    const registry = await FormRegistry.load(ROOT);
    expect(registry.size).toBeGreaterThan(20);
    expect(registry.years()).toContain(2025);
  });

  it('registers every non-K-1 form type listed in §8 for TY2025', async () => {
    const registry = await FormRegistry.load(ROOT);
    const required = [
      'W-2', 'W-2G', '1099-INT', '1099-OID', '1099-DIV', '1099-B', '1099-R', '1099-MISC',
      '1099-NEC', '1099-K', '1099-G', '1099-S', '1099-SA', '1099-Q', '1099-LTC', 'SSA-1099',
      'RRB-1099', '1098', '1098-E', '1098-T', '1095-A', '5498', '5498-SA',
    ];
    const present = registry.formTypes(2025);
    for (const formType of required) {
      expect(present, `missing schema for ${formType}`).toContain(formType);
    }
  });

  it('registers the three K-1 variants, all judgment-only (§8)', async () => {
    const registry = await FormRegistry.load(ROOT);
    for (const k1 of ['K-1-1065', 'K-1-1120S', 'K-1-1041']) {
      const schema = registry.get(k1, 2025);
      expect(schema, `missing ${k1}`).toBeDefined();
      expect(schema!.allJudgmentRequired).toBe(true);
    }
  });

  it('has every field nullable — no defaults anywhere (§5)', async () => {
    const registry = await FormRegistry.load(ROOT);
    for (const year of registry.years()) {
      for (const formType of registry.formTypes(year)) {
        for (const field of registry.get(formType, year)!.fields) {
          expect(field.nullable, `${formType}.${field.key} is not nullable`).toBe(true);
        }
      }
    }
  });

  it('marks every TIN-bearing field sensitive so it is never persisted (§7)', async () => {
    const registry = await FormRegistry.load(ROOT);
    for (const year of registry.years()) {
      for (const formType of registry.formTypes(year)) {
        for (const field of registry.get(formType, year)!.fields) {
          const looksLikeTin = /(^|_)(tin|ssn)$/.test(field.key);
          const isPayerSide = field.key.startsWith('payer') || field.key.startsWith('lender') ||
            field.key.startsWith('trustee') || field.key.startsWith('filer') ||
            field.key.startsWith('partnership') || field.key.startsWith('corporation') ||
            field.key.startsWith('estate') || field.key.startsWith('employer') ||
            field.key.startsWith('recipient_') && formType === '1098';
          if (looksLikeTin && !isPayerSide) {
            expect(field.sensitive, `${formType}.${field.key} should be sensitive`).toBe('tin');
          }
        }
      }
    }
  });

  it('rejects a malformed registration at load, not at use', () => {
    expect(() =>
      formSchema.parse({ formType: 'BAD', taxYear: 2025, version: '1', fields: [] }),
    ).toThrow();

    expect(() =>
      formSchema.parse({
        formType: 'BAD',
        taxYear: 2025,
        version: '1',
        fields: [{ key: 'Box_1', label: 'x', type: 'money' }], // uppercase key
      }),
    ).toThrow();

    expect(() =>
      formSchema.parse({
        formType: 'BAD',
        taxYear: 2025,
        version: '1',
        fields: [
          { key: 'box_1', label: 'x', type: 'money' },
          { key: 'box_1', label: 'y', type: 'money' },
        ],
      }),
    ).toThrow(/duplicate field key/);
  });

  it('refuses a field that declares itself non-nullable', () => {
    expect(() =>
      formSchema.parse({
        formType: 'BAD',
        taxYear: 2025,
        version: '1',
        fields: [{ key: 'box_1', label: 'x', type: 'money', nullable: false }],
      }),
    ).toThrow();
  });

  it('falls back to the most recent earlier year rather than failing', async () => {
    const registry = new FormRegistry();
    registry.add({
      formType: 'W-2',
      taxYear: 2025,
      version: '2025.1',
      description: '',
      container: false,
      allJudgmentRequired: false,
      checks: [],
      fields: [{ key: 'box_1', label: 'Wages', type: 'money', nullable: true, repeating: false, judgmentRequired: false }],
    });
    expect(registry.resolve('W-2', 2026)?.resolvedYear).toBe(2025);
    expect(registry.resolve('W-2', 2024)).toBeUndefined();
  });
});
