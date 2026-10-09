import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { email } from '@scan/shared';

/**
 * Environment configuration. `.env.example` in the repo root is the contract: every variable the
 * app reads is listed there. ODOO_VERSION, DOMAIN and POSTGRES_PASSWORD are read by Docker Compose
 * only, so they are not part of this schema. APP_VERSION is build metadata set by the Docker image
 * (not a setting), shown on /health.
 *
 * Empty values count as unset, so `ADMIN_PASSWORD=` in a .env file means "no password".
 * Error messages name the variable and the rule, never the value (some values are secrets).
 */

/** Repo root, derived from this file's location (apps/server/src/config.ts). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface Cidr {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  /** Origin of the staff app, for example https://scan.bedrijfsnaam.nl (no trailing slash). */
  appOrigin: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  /** false, true (trust every proxy) or the number of proxy hops in front of the app. */
  trustProxy: boolean | number;
  cookieSecure: boolean;
  sessionTtlDays: number;
  /** Empty = no restriction. */
  staffAllowedCidrs: Cidr[];
  /** Absolute path of the files volume. */
  dataDir: string;
  databaseUrl: string;
  databaseUrlTest: string | undefined;
  admin: { email: string | undefined; name: string; password: string | undefined };
  odoo: { url: string; db: string; apiKey: string | undefined; dryRun: boolean; videoField: string };
  version: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false'], { error: 'must be true or false' })
    .transform((v) => v === 'true')
    .default(fallback);

const int = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, { error: 'must be a whole number' })
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, { error: `must be at least ${min}` })
        .max(max, { error: `must be at most ${max}` }),
    )
    .default(fallback);

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/\S+$/, { error: 'must be a postgres:// connection URL' });

const httpOrigin = z.string().transform((value, ctx) => {
  try {
    const url = new URL(value);
    const bare = url.pathname === '/' && !url.search && !url.hash && !url.username;
    if ((url.protocol === 'http:' || url.protocol === 'https:') && bare) return url.origin;
  } catch {
    // fall through to the issue below
  }
  ctx.addIssue({ code: 'custom', message: 'must be an origin such as https://scan.example.nl (no path)' });
  return z.NEVER;
});

/** "192.168.1.0/24, 10.8.0.0/24" -> Cidr[]. A bare address means a single host. */
const cidrList = z.string().transform((value, ctx) => {
  const result: Cidr[] = [];
  const entries = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  entries.forEach((entry, i) => {
    const [address = '', prefixText, ...rest] = entry.split('/');
    const version = isIP(address);
    const maxPrefix = version === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
    const prefixOk = prefixText === undefined || (/^\d{1,3}$/.test(prefixText) && prefix <= maxPrefix);
    if (version === 0 || !prefixOk || rest.length > 0) {
      ctx.addIssue({ code: 'custom', message: `entry ${i + 1} is not a valid CIDR (expected e.g. 192.168.1.0/24)` });
      return;
    }
    result.push({ address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' });
  });
  return result;
});

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_ORIGIN: httpOrigin.default('http://localhost:5173'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(1, 65535, 3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z
    .string()
    .regex(/^(true|false|\d{1,2})$/, { error: 'must be true, false or a number of proxy hops' })
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : Number(v)))
    .default(false),
  COOKIE_SECURE: bool(false),
  SESSION_TTL_DAYS: int(1, 90, 14),
  STAFF_ALLOWED_CIDRS: cidrList.default([]),
  DATA_DIR: z
    .string()
    .default('./data')
    .transform((p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(REPO_ROOT, p))),
  DATABASE_URL: postgresUrl,
  DATABASE_URL_TEST: postgresUrl.optional(),
  ADMIN_EMAIL: email.optional(),
  ADMIN_NAME: z.string().max(120).default('Beheerder'),
  ADMIN_PASSWORD: z.string().min(12, { error: 'must be at least 12 characters' }).max(256).optional(),
  ODOO_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).default('http://localhost:8069'),
  ODOO_DB: z.string().default('odoo'),
  ODOO_API_KEY: z.string().optional(),
  ODOO_DRY_RUN: bool(true),
  ODOO_VIDEO_FIELD: z
    .string()
    .regex(/^x_[a-z0-9_]+$/, { error: 'must be a custom field name such as x_roof_video_url' })
    .default('x_roof_video_url'),
  APP_VERSION: z.string().default('dev'),
});

/**
 * Reads and validates the environment. Throws a ConfigError that lists every invalid variable.
 * Takes the env as a parameter so tests can pass their own.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Only look at the variables we know, and treat '' as unset.
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const value = env[key];
    input[key] = value === undefined || value.trim() === '' ? undefined : value;
  }

  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? 'environment');
      const message = issue.code === 'invalid_type' && input[name] === undefined ? 'is required' : issue.message;
      return `  - ${name}: ${message}`;
    });
    throw new ConfigError(`Invalid environment configuration:\n${[...new Set(lines)].join('\n')}`);
  }

  const e = parsed.data;
  if (e.TRUST_PROXY === true && e.STAFF_ALLOWED_CIDRS.length > 0) {
    // `true` takes the left-most X-Forwarded-For entry, which a client can set itself behind Nginx.
    throw new ConfigError(
      'Invalid environment configuration:\n  - TRUST_PROXY: use the number of proxies in front of the app (usually 1), not true, when STAFF_ALLOWED_CIDRS is set',
    );
  }
  return {
    nodeEnv: e.NODE_ENV,
    appOrigin: e.APP_ORIGIN,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    cookieSecure: e.COOKIE_SECURE,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    staffAllowedCidrs: e.STAFF_ALLOWED_CIDRS,
    dataDir: e.DATA_DIR,
    databaseUrl: e.DATABASE_URL,
    databaseUrlTest: e.DATABASE_URL_TEST,
    admin: { email: e.ADMIN_EMAIL, name: e.ADMIN_NAME, password: e.ADMIN_PASSWORD },
    odoo: {
      url: e.ODOO_URL,
      db: e.ODOO_DB,
      apiKey: e.ODOO_API_KEY,
      dryRun: e.ODOO_DRY_RUN,
      videoField: e.ODOO_VIDEO_FIELD,
    },
    version: e.APP_VERSION,
  };
}
