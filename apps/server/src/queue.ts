import { PgBoss } from 'pg-boss';
import type { Config } from './config.ts';
import { deleteExpiredSessions } from './auth/session.ts';
import type { Db } from './db/client.ts';
import type { Logger } from './log.ts';

/**
 * Background jobs run through pg-boss in the app's own Postgres (schema `pgboss`), so there is no
 * Redis. Queue names from PLAN.md section 5; each queue is created in the milestone that uses it.
 */
export const QUEUES = {
  scanImport: 'scan.import', // M1: unpack, validate, OBJ -> GLB, work.glb
  scanDerive: 'scan.derive', // M1: crop, mask, render.glb, web.glb, thumbnail
  photoProcess: 'photo.process', // M2: EXIF/GPS strip, resize, thumbnail
  renderVideo: 'render.video', // M2: before/after MP4
  cleanupNightly: 'cleanup.nightly', // M0: expired sessions; later retention cleanup
  odooLink: 'odoo.link', // M3: video link and note on the invoice
} as const;

export function createBoss(config: Config, applicationName = 'scan-worker'): PgBoss {
  return new PgBoss({
    connectionString: config.databaseUrl,
    schema: 'pgboss',
    application_name: applicationName,
    max: 4,
  });
}

/**
 * Worker setup. One job at a time is plenty at about 5 jobs a month (PLAN.md section 4), and keeps
 * memory predictable when the heavy scan and render jobs arrive.
 */
export async function startWorker(boss: PgBoss, db: Db, log: Logger): Promise<void> {
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();

  await boss.createQueue(QUEUES.cleanupNightly, { retryLimit: 2, expireInSeconds: 600 });
  // 03:30 Amsterdam time; if the worker was down at that moment, run once when it comes back.
  await boss.schedule(QUEUES.cleanupNightly, '30 3 * * *', null, { tz: 'Europe/Amsterdam', missed: 'once' });
  await boss.work(QUEUES.cleanupNightly, async () => {
    const sessions = await deleteExpiredSessions(db);
    log.info({ sessions }, 'nightly cleanup done');
  });
  log.info({ queues: [QUEUES.cleanupNightly] }, 'worker ready');
}
