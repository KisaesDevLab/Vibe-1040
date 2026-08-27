/**
 * Form schema registry (P6).
 *
 * Declarative, per-tax-year, loaded from `data/form-schemas/<year>/` at runtime. Adding a
 * form type is a data change; adding a tax year is a data change. Neither requires a code
 * change, which is P6's exit criterion.
 *
 * Every field is nullable and there are no defaults — the loader rejects a registration
 * that tries otherwise, because a default-to-zero anywhere in the pipeline destroys the
 * blank-vs-zero distinction the tool exists to preserve (§5).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const fieldType = z.enum(['money', 'text', 'bool', 'code', 'year', 'date', 'count']);
export type FieldType = z.infer<typeof fieldType>;

const fieldSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_]+$/, 'field keys are lower_snake_case'),
    label: z.string().min(1),
    type: fieldType,
    /** Present only for documentation; the registry forbids it being false. */
    nullable: z.literal(true).default(true),
    /** Box identifier as printed on the form, for the review UI and the worksheet. */
    box: z.string().optional(),
    /** Repeating group, e.g. 1099-B rows or 1095-A monthly rows. */
    repeating: z.boolean().default(false),
    /** Routes to Judgment Required whenever populated, regardless of value (§9). */
    judgmentRequired: z.boolean().default(false),
    judgmentReason: z.string().optional(),
    /**
     * `tin` marks a field that is extracted but **never persisted** (§7). Identity
     * resolution consumes the plaintext in memory, stores a salted hash plus the last
     * four, and the value is dropped. `src/extract/persist.ts` refuses to write these.
     */
    sensitive: z.enum(['tin']).optional(),
    notes: z.string().optional(),
  })
  .strict();

export const formSchema = z
  .object({
    formType: z.string().min(1),
    taxYear: z.number().int(),
    version: z.string().min(1),
    description: z.string().default(''),
    /** True for consolidated 1099 packages: this form contains sub-forms (P4). */
    container: z.boolean().default(false),
    /** Every K-1 lands in Judgment Required in v1 (§8, §9). */
    allJudgmentRequired: z.boolean().default(false),
    /** Arithmetic check keys that apply to this form (P9). */
    checks: z.array(z.string()).default([]),
    fields: z.array(fieldSchema).min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    for (const f of val.fields) {
      if (seen.has(f.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate field key: ${f.key}` });
      }
      seen.add(f.key);
    }
  });

export type FormSchema = z.infer<typeof formSchema>;
export type FormField = z.infer<typeof fieldSchema>;

export class FormRegistry {
  private readonly byYear = new Map<number, Map<string, FormSchema>>();

  static async load(root = join(process.cwd(), 'data', 'form-schemas')): Promise<FormRegistry> {
    const registry = new FormRegistry();
    let years: string[];
    try {
      years = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      throw new Error(`form schema registry not found at ${root}`);
    }

    for (const yearDir of years) {
      const files = (await readdir(join(root, yearDir))).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const raw = await readFile(join(root, yearDir, file), 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          throw new Error(`form schema ${yearDir}/${file} is not valid JSON: ${(err as Error).message}`);
        }
        const result = formSchema.safeParse(parsed);
        if (!result.success) {
          const detail = result.error.issues
            .map((i) => `    ${i.path.join('.')}: ${i.message}`)
            .join('\n');
          // P6 exit criterion: a malformed registration is rejected at load, not at use.
          throw new Error(`form schema ${yearDir}/${file} is invalid:\n${detail}`);
        }
        registry.add(result.data);
      }
    }
    return registry;
  }

  add(schema: FormSchema): void {
    const year = this.byYear.get(schema.taxYear) ?? new Map<string, FormSchema>();
    year.set(schema.formType, schema);
    this.byYear.set(schema.taxYear, year);
  }

  get(formType: string, taxYear: number): FormSchema | undefined {
    return this.byYear.get(taxYear)?.get(formType);
  }

  /**
   * Resolve with fallback to the most recent earlier year. A form whose layout did not
   * change between seasons should not need a copied file, but the caller is told which
   * year actually answered so the worksheet can say so.
   */
  resolve(formType: string, taxYear: number): { schema: FormSchema; resolvedYear: number } | undefined {
    const years = [...this.byYear.keys()].filter((y) => y <= taxYear).sort((a, b) => b - a);
    for (const y of years) {
      const schema = this.byYear.get(y)?.get(formType);
      if (schema) return { schema, resolvedYear: y };
    }
    return undefined;
  }

  formTypes(taxYear: number): string[] {
    return [...(this.byYear.get(taxYear)?.keys() ?? [])].sort();
  }

  years(): number[] {
    return [...this.byYear.keys()].sort();
  }

  get size(): number {
    return [...this.byYear.values()].reduce((n, m) => n + m.size, 0);
  }
}

let cached: FormRegistry | null = null;

export async function registry(): Promise<FormRegistry> {
  cached ??= await FormRegistry.load();
  return cached;
}
