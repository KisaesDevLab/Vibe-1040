/**
 * Development seed. Creates one admin staff user.
 *
 * Deliberately does NOT enrol MFA: the operator completes the second factor through the UI
 * on first sign-in, which exercises the real enrolment path rather than pre-baking a
 * secret that would then exist in a seed script (§11).
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../auth/credentials.ts';
import { pool } from './client.ts';
import { db } from './client.ts';
import { users } from './schema.ts';

async function seed(): Promise<void> {
  // Lowercased like every other write path. Rows seeded before this stored the address as
  // typed; sign-in and SSO linking match case-insensitively so those keep working.
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.test').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');

  const [existing] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (existing) {
    console.log(`user already exists: ${email}`);
    return;
  }

  await db.insert(users).values({
    email,
    displayName: process.env.SEED_ADMIN_NAME ?? 'Firm Admin',
    role: 'admin',
    passwordHash: await hashPassword(password),
  });

  console.log(`created admin user: ${email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`generated password: ${password}`);
    console.log('Change it after first sign-in. MFA enrolment happens in the UI.');
  }
}

seed()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
