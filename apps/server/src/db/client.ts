import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

export interface Database {
  db: Db;
  pool: Pool;
}

/**
 * One pg pool per process. At about 5 jobs a month the defaults (10 connections) are plenty.
 * Call `pool.end()` on shutdown.
 */
export function createDatabase(connectionString: string, applicationName = 'scan-api'): Database {
  const pool = new Pool({ connectionString, application_name: applicationName, connectionTimeoutMillis: 5000 });
  // An idle client that loses its connection emits 'error' on the pool. Without a listener that
  // would crash the process; the next query simply gets a fresh connection.
  pool.on('error', (err) =>
    console.error(JSON.stringify({ level: 50, msg: 'idle pg client error', err: err.message })),
  );
  return { db: drizzle({ client: pool, schema }), pool };
}
