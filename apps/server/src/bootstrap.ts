import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import type { Logger } from './log.ts';
import { seedSettings } from './settings.ts';
import { adminExists, createUser } from './users.ts';

/**
 * Runs before the API starts listening: migrations, default settings, and the first admin.
 * The worker does not migrate; in Docker Compose it starts after the API is healthy.
 */
export async function bootstrap(config: Config, db: Db, log: Logger): Promise<void> {
  await runMigrations(db);
  await seedSettings(db);
  await ensureFirstAdmin(config, db, log);
}

/** Creates the admin from ADMIN_EMAIL/ADMIN_PASSWORD, only while no admin exists. */
export async function ensureFirstAdmin(config: Config, db: Db, log: Logger): Promise<void> {
  if (await adminExists(db)) return;
  const { email, name, password } = config.admin;
  if (!email || !password) {
    log.warn({}, 'no admin account exists yet: set ADMIN_EMAIL and ADMIN_PASSWORD, or run pnpm user:add --role admin');
    return;
  }
  const id = await createUser(db, { email, name, role: 'admin', password }, null, 'bootstrap');
  if (id) log.info({ email }, 'created the first admin from ADMIN_EMAIL; change the password after the first login');
  else log.warn({ email }, 'ADMIN_EMAIL belongs to an existing non-admin user; no admin was created');
}
