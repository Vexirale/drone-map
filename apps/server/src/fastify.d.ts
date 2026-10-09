import type { AuthContext } from './auth/session.ts';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
  }
  interface FastifyRequest {
    /** Set by the session guards (auth/guards.ts); null on routes without a guard. */
    auth: AuthContext | null;
  }
}
