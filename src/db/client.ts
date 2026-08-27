import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.ts';
import * as schema from './schema.ts';

/**
 * Money is bigint in Postgres and `number` in the app. node-postgres hands bigint back as a
 * string by default; parse it, and refuse anything past Number.MAX_SAFE_INTEGER rather than
 * silently rounding a dollar amount.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`bigint ${value} exceeds safe integer range — refusing to round a money value`);
  }
  return n;
});

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
