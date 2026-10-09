import { loadConfig } from '../config.ts';
import { createDatabase } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';

/** `pnpm db:migrate`: apply pending migrations and exit. The API also does this on startup. */
const config = loadConfig();
const { db, pool } = createDatabase(config.databaseUrl, 'scan-cli');
try {
  await runMigrations(db);
  console.log('migrations applied');
} finally {
  await pool.end();
}
