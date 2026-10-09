import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@scan/shared';
import { HttpError } from '../errors.ts';
import { type AuthContext, SESSION_COOKIE, clearSessionCookie, findSession } from './session.ts';

/**
 * Route guards, used as Fastify preHandlers:
 *   { preHandler: [requireSession] }           any session, also half-way logins
 *   { preHandler: [requireFull] }              fully logged in
 *   { preHandler: [requireRole('admin')] }     fully logged in admin
 * Each guard runs the ones before it, so list only the strictest.
 */

export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.auth) return;
  const token = request.cookies[SESSION_COOKIE];
  const auth = token ? await findSession(request.server.db, token) : null;
  if (!auth) {
    // A stale cookie (expired, logged out elsewhere) is removed so the browser stops sending it.
    if (token) clearSessionCookie(reply, request.server.config);
    throw new HttpError(401, 'unauthenticated');
  }
  request.auth = auth;
}

export async function requireFull(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireSession(request, reply);
  if (getAuth(request).stage !== 'full') throw new HttpError(403, 'second_factor_required');
}

export const requireRole =
  (role: Role) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireFull(request, reply);
    if (getAuth(request).user.role !== role) throw new HttpError(403, 'forbidden');
  };

/** The session of a request that passed a guard. */
export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error('getAuth() called on a route without a session guard');
  return request.auth;
}
