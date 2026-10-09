import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../errors.ts';

/**
 * A preHandler that counts requests per key and answers 429 { error: { code: 'rate_limited' } }.
 *
 * Built on @fastify/rate-limit's createRateLimit() instead of its route config, because the login
 * route needs two independent limits (per IP and per IP + email) and the plugin runs only one
 * limiter per request. Counters live in memory, which is right for a single API process.
 */
export function rateLimit(
  app: FastifyInstance,
  options: { max: number; timeWindow: number; keyGenerator: (request: FastifyRequest) => string },
) {
  const check = app.createRateLimit(options);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = await check(request);
    if (!result.isAllowed && result.isExceeded) {
      reply.header('retry-after', result.ttlInSeconds);
      throw new HttpError(429, 'rate_limited');
    }
  };
}
