import { createDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { TEST_DATABASE_URL } from './helpers.ts';

/** Wipes the test database once per run and applies the migrations. Never point this at real data. */
export default async function setup(): Promise<void> {
  if (!/\/scan_test(\?|$)/.test(TEST_DATABASE_URL)) {
    throw new Error(`refusing to wipe ${TEST_DATABASE_URL}: the test database name must be scan_test`);
  }
  const { db, pool } = createDatabase(TEST_DATABASE_URL, 'scan-test-setup');
  try {
    await pool.query(
      'drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade; create schema public;',
    );
    await runMigrations(db);
  } finally {
    await pool.end();
  }
}
