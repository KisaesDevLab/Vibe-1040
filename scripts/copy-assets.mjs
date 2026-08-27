#!/usr/bin/env node
/**
 * Copy non-TS build assets into dist/.
 *
 * `tsc` emits JavaScript and nothing else, so the migration SQL — which `migrate.ts`
 * resolves relative to its own location — would be missing from a built image and the
 * first `db:migrate` on a fresh host would fail with "no migrations found".
 */
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const pairs = [['src/db/migrations', 'dist/db/migrations']];

for (const [from, to] of pairs) {
  await mkdir(join(process.cwd(), to), { recursive: true });
  await cp(join(process.cwd(), from), join(process.cwd(), to), { recursive: true });
  console.log(`copied ${from} → ${to}`);
}
