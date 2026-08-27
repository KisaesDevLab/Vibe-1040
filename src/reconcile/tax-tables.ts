/**
 * Per-tax-year rate and threshold tables (P9).
 *
 * Data, not constants in code — a new season is a JSON file, not a diff against logic.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const taxTable = z
  .object({
    taxYear: z.number().int(),
    socialSecurityWageBaseCents: z.number().int().positive(),
    socialSecurityRate: z.number().positive(),
    medicareRate: z.number().positive(),
    additionalMedicareRate: z.number().nonnegative(),
    additionalMedicareThresholdCents: z.number().int().positive(),
    notes: z.array(z.string()).default([]),
    form1099K: z
      .object({
        reportingThresholdCents: z.number().int().nonnegative(),
        reportingTransactionCount: z.number().int().nonnegative(),
        notes: z.string().optional(),
      })
      .optional(),
    form1099NecMiscThresholdCents: z.number().int().nonnegative().optional(),
  })
  .strict();

export type TaxTable = z.infer<typeof taxTable>;

const cache = new Map<number, TaxTable>();

export async function taxTableFor(taxYear: number, root?: string): Promise<TaxTable> {
  const cached = cache.get(taxYear);
  if (cached) return cached;

  const dir = root ?? join(process.cwd(), 'data', 'tax-tables');
  let raw: string;
  try {
    raw = await readFile(join(dir, `${taxYear}.json`), 'utf8');
  } catch {
    throw new Error(
      `no tax table for ${taxYear}. Add data/tax-tables/${taxYear}.json — this is a data ` +
        'change, not a code change (PHASES.md P9).',
    );
  }
  const parsed = taxTable.parse(JSON.parse(raw));
  cache.set(taxYear, parsed);
  return parsed;
}

/** Test seam. */
export function __setTaxTable(table: TaxTable): void {
  cache.set(table.taxYear, table);
}
