import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const DB_TIMEOUT_MS = 2000;

/**
 * GET /health for Docker and Uptime Kuma: 200 when the database answers, 503 otherwise.
 * Later milestones add failed renders and failing Odoo calls here (SPEC: Operations), so one
 * monitor covers everything.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    let db: 'ok' | 'error' = 'ok';
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        app.db.execute(sql`select 1`),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('database check timed out')), DB_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      db = 'error';
      app.log.warn({ err }, 'health check: database unavailable');
    } finally {
      clearTimeout(timer);
    }
    reply.header('cache-control', 'no-store');
    if (db === 'error') return reply.code(503).send({ status: 'error', db, version: app.config.version });
    return { status: 'ok', db, version: app.config.version };
  });
}
