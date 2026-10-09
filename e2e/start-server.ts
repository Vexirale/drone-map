/**
 * Playwright's webServer: gives the e2e run its own fresh database (scan_e2e), then starts the API,
 * which serves the built web app (run `pnpm build` first). Never point E2E_DATABASE_URL at real data.
 */
import { createDatabase } from '../apps/server/src/db/client.ts';

const url = process.env.E2E_DATABASE_URL ?? 'postgres://scan:scan@localhost:5432/scan_e2e';
const name = new URL(url).pathname.slice(1);
if (name !== 'scan_e2e') throw new Error(`refusing to wipe ${name}: the e2e database must be called scan_e2e`);

const maintenance = new URL(url);
maintenance.pathname = '/postgres';
const server = createDatabase(maintenance.toString(), 'scan-e2e-setup');
const exists = await server.pool.query('select 1 from pg_database where datname = $1', [name]);
if (exists.rowCount === 0) await server.pool.query(`create database ${name}`);
await server.pool.end();

const target = createDatabase(url, 'scan-e2e-setup');
await target.pool.query(
  'drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade; create schema public;',
);
await target.pool.end();

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: url,
  PORT: process.env.E2E_PORT ?? '3300',
  APP_ORIGIN: `http://localhost:${process.env.E2E_PORT ?? '3300'}`,
  COOKIE_SECURE: 'false',
  LOG_LEVEL: 'warn',
  ADMIN_EMAIL: 'admin@example.nl',
  ADMIN_NAME: 'Anne Beheerder',
  ADMIN_PASSWORD: 'e2e-admin-wachtwoord',
  STAFF_ALLOWED_CIDRS: '',
});
process.argv = [process.argv[0]!, 'main.ts', 'api'];
await import('../apps/server/src/main.ts');
