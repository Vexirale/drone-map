import { buildApp } from './app.ts';
import { bootstrap } from './bootstrap.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { createDatabase } from './db/client.ts';
import { createLogger } from './log.ts';
import { createBoss, startWorker } from './queue.ts';

/**
 * One codebase, two processes (PLAN.md decision 1):
 *   node src/main.ts api      HTTP API, also serves the built web app
 *   node src/main.ts worker   background jobs (pg-boss)
 */
const mode = process.argv[2];
if (mode !== 'api' && mode !== 'worker') {
  console.error('usage: node src/main.ts api|worker');
  process.exit(2);
}

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { db, pool } = createDatabase(config.databaseUrl, `scan-${mode}`);
const shutdown: Array<() => Promise<void>> = [];
let stopping = false;

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  const log = createLogger(config.logLevel, { mode });
  log.info({ signal }, 'shutting down');
  for (const step of shutdown) {
    await step().catch((err: unknown) => log.error({ err }, 'shutdown step failed'));
  }
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

if (mode === 'api') {
  const app = await buildApp(config, { db });
  await bootstrap(config, db, app.log);
  shutdown.push(() => app.close());
  await app.listen({ host: config.host, port: config.port });
} else {
  const log = createLogger(config.logLevel, { mode });
  const boss = createBoss(config);
  shutdown.push(() => boss.stop({ graceful: true, timeout: 30_000 }));
  await startWorker(boss, db, log);
}
