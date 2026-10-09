import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimitPlugin from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { authRoutes } from './auth/routes.ts';
import { REPO_ROOT, type Config } from './config.ts';
import type { Db } from './db/client.ts';
import { HttpError, errorBody } from './errors.ts';
import { healthRoutes } from './health.ts';
import { originCheckHook, staffNetworkHook, trustProxyOption } from './security.ts';
import { userRoutes } from './users-routes.ts';

/** The built web app (pnpm build). Missing in dev, where Vite serves it and proxies /api here. */
export const DEFAULT_WEB_DIST = path.join(REPO_ROOT, 'apps/web/dist');

export interface AppDeps {
  db: Db;
  /** Directory with the built web app; null to serve the API only. Defaults to apps/web/dist if it exists. */
  webDist?: string | null;
  /** Fastify logger option; tests pass false. */
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: trustProxyOption(config.trustProxy),
    // JSON bodies only; scan and photo uploads get their own routes and limits (M1, M2).
    bodyLimit: 64 * 1024,
  });

  app.decorate('config', config);
  app.decorate('db', deps.db);
  app.decorateRequest('auth', null);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Only upgrade when the app is served over HTTPS; plain http in dev must keep working.
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    strictTransportSecurity: config.cookieSecure ? { maxAge: 15552000 } : false,
  });
  // Limits are applied per route (auth/rate-limit.ts), never globally.
  await app.register(rateLimitPlugin, { global: false });

  // Bodies must be JSON: no text/plain (which a cross-site form could send without a preflight).
  app.removeContentTypeParser('text/plain');

  const staffNetwork = staffNetworkHook(config);
  if (staffNetwork) app.addHook('onRequest', staffNetwork);
  app.addHook('onRequest', originCheckHook(config));

  app.setErrorHandler((err: FastifyError | HttpError, request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send(errorBody(err.code));
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // Malformed JSON, wrong content type, body too large, and the like.
      return reply
        .code(status)
        .send(errorBody(status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'bad_request'));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('internal'));
  });

  const webDist =
    deps.webDist === undefined
      ? existsSync(path.join(DEFAULT_WEB_DIST, 'index.html'))
        ? DEFAULT_WEB_DIST
        : null
      : deps.webDist;

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?', 1)[0] ?? '';
    const isApi = pathname === '/api' || pathname.startsWith('/api/') || pathname === '/health';
    if (webDist && request.method === 'GET' && !isApi) {
      // Client-side routing: every other GET gets the app shell.
      return reply.header('cache-control', 'no-cache').sendFile('index.html', webDist);
    }
    return reply.code(404).send(errorBody('not_found'));
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);

  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      setHeaders: (reply, filePath) => {
        // Vite puts content-hashed files in /assets; they never change.
        reply.header(
          'cache-control',
          filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  return app;
}
