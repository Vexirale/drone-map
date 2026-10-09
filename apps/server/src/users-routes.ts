import type { FastifyInstance } from 'fastify';
import { API, UsersResponse } from '@scan/shared';
import { requireRole } from './auth/guards.ts';
import { listUsers } from './users.ts';

/** Staff user management. M0 only lists users; adding users goes through `pnpm user:add` for now. */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get(API.users, { preHandler: [requireRole('admin')] }, async () =>
    UsersResponse.parse({ users: await listUsers(app.db) }),
  );
}
