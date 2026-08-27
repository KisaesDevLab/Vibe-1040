/**
 * Migration runner (P0).
 *
 * Hand-written numbered SQL pairs rather than drizzle-kit output, because P0's exit
 * criterion is "migrations run forward **and back**" and a generated forward-only stack
 * cannot demonstrate that.
 *
 *   npm run db:migrate      → apply every pending .up.sql
 *   npm run db:rollback     → revert the most recent applied migration
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function versions(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return [...new Set(files.filter((f) => f.endsWith('.sql')).map((f) => f.split('.')[0]!))].sort();
}

async function applied(): Promise<Set<string>> {
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

async function runFile(version: string, direction: 'up' | 'down'): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_DIR, `${version}.${direction}.sql`), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    if (direction === 'up') {
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    } else {
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    }
    await client.query('COMMIT');
    console.log(`${direction === 'up' ? 'applied' : 'reverted'} ${version}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`migration ${version} ${direction} failed: ${(err as Error).message}`, {
      cause: err,
    });
  } finally {
    client.release();
  }
}

export async function up(): Promise<void> {
  await ensureTable();
  const done = await applied();
  const pending = (await versions()).filter((v) => !done.has(v));
  if (!pending.length) {
    console.log('no pending migrations');
    return;
  }
  for (const v of pending) await runFile(v, 'up');
}

export async function down(): Promise<void> {
  await ensureTable();
  const { rows } = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  const last = rows[0]?.version;
  if (!last) {
    console.log('nothing to roll back');
    return;
  }
  await runFile(last, 'down');
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isEntrypoint) {
  const cmd = process.argv[2] ?? 'up';
  const run = cmd === 'down' ? down : up;
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
