import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';
import { type Database, createDatabase } from '../src/db/client.ts';
import { seedSettings } from '../src/settings.ts';

export const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgres://scan:scan@localhost:5432/scan_test';
export const ORIGIN = 'http://app.test';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    APP_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
    ...env,
  });
}

let shared: Database | undefined;
export function testDb(): Database {
  shared ??= createDatabase(TEST_DATABASE_URL, 'scan-test');
  return shared;
}

/** Empties every M0 table and restores the default settings. */
export async function resetData(): Promise<void> {
  const { pool, db } = testDb();
  await pool.query('truncate table audit_log, sessions, settings, users restart identity cascade');
  await seedSettings(db);
}

export async function makeApp(
  env: Record<string, string> = {},
  webDist: string | null = null,
): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(env), { db: testDb().db, webDist, logger: false });
  await app.ready();
  return app;
}

/** The value of the `sid` cookie a response set, or undefined. */
export function sidFrom(res: LightMyRequestResponse): string | undefined {
  const cookie = res.cookies.find((c) => c.name === 'sid');
  return cookie && cookie.value !== '' ? cookie.value : undefined;
}

/** POST JSON the way the web app does: same origin, JSON body, optional session cookie. */
export function post(
  app: FastifyInstance,
  url: string,
  body: unknown,
  sid?: string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
    cookies: sid ? { sid } : {},
  });
}

export function get(app: FastifyInstance, url: string, sid?: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers, cookies: sid ? { sid } : {} });
}
