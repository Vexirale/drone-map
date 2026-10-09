import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { normalizeIP } from '@fastify/rate-limit';
import {
  API,
  ChangePasswordRequest,
  LoginRequest,
  MeResponse,
  TotpCodeRequest,
  TotpSetupResponse,
  totpRequired,
  type SessionNext,
  type User,
} from '@scan/shared';
import { audit } from '../audit.ts';
import { sessions as sessionsTable, users } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { parseBody } from '../http.ts';
import { getSetting } from '../settings.ts';
import { getAuth, requireFull, requireSession } from './guards.ts';
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.ts';
import { rateLimit } from './rate-limit.ts';
import {
  SESSION_COOKIE,
  type AuthContext,
  clearSessionCookie,
  createSession,
  hashToken,
  rotateSession,
  setSessionCookie,
} from './session.ts';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.ts';

/**
 * Login, second factor and logout; the contract is packages/shared/src/api.ts.
 *
 *   login (password ok) --> TOTP enabled?        --> 'password' session, next 'totp'       --> totp/verify --> 'full'
 *                       --> admin without TOTP?  --> 'password' session, next 'totp_setup' --> totp/setup + totp/enable --> 'full'
 *                       --> otherwise            --> 'full' session
 *
 * Every step up to 'full' issues a new session token. Wrong passwords, unknown emails and
 * deactivated accounts all answer the same 401 after the same amount of argon2 work.
 */

const MINUTE = 60_000;

const nextStep = (stage: AuthContext['stage'], user: User): SessionNext =>
  stage === 'full' ? null : user.totpEnabled ? 'totp' : 'totp_setup';

const meResponse = (stage: AuthContext['stage'], user: User) => MeResponse.parse({ user, next: nextStep(stage, user) });

/** Lower-cased email from a not yet validated login body, for the rate limit key. */
const bodyEmail = (request: FastifyRequest): string => {
  const value = (request.body as { email?: unknown } | null)?.email;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app;

  const loginPerIp = rateLimit(app, {
    max: 30,
    timeWindow: MINUTE,
    keyGenerator: (request) => `login:${normalizeIP(request.ip)}`,
  });
  const loginPerIpAndEmail = rateLimit(app, {
    max: 5,
    timeWindow: MINUTE,
    keyGenerator: (request) => `login:${normalizeIP(request.ip)}:${bodyEmail(request)}`,
  });
  // Keyed by user rather than by session: a new login gives a new session, and must not give
  // a fresh set of guesses at the 6-digit code.
  const totpPerUser = rateLimit(app, {
    max: 5,
    timeWindow: MINUTE,
    keyGenerator: (request) => `totp:${getAuth(request).user.id}`,
  });

  /** Bookkeeping for every session that reaches 'full'. */
  async function completeLogin(userId: string, secondFactor: 'none' | 'totp' | 'totp_setup'): Promise<void> {
    await db
      .update(users)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(users.id, userId));
    await audit(db, { actorId: userId, action: 'auth.login', details: { secondFactor } });
  }

  async function totpState(userId: string) {
    const [row] = await db
      .select({ secret: users.totpSecret, lastStep: users.totpLastStep, enabledAt: users.totpEnabledAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) throw new HttpError(401, 'unauthenticated');
    return row;
  }

  async function totpFailed(userId: string, during: 'verify' | 'enable'): Promise<never> {
    await audit(db, { actorId: userId, action: 'auth.totp_failed', details: { during } });
    throw new HttpError(401, 'invalid_code');
  }

  app.post(API.login, { preHandler: [loginPerIp, loginPerIpAndEmail] }, async (request, reply) => {
    const body = parseBody(LoginRequest, request.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));

    const passwordOk = user
      ? await verifyPassword(user.passwordHash, body.password)
      : await verifyDummyPassword(body.password);
    if (!user || !passwordOk || !user.active) {
      const reason = !user ? 'unknown_email' : !passwordOk ? 'wrong_password' : 'inactive';
      await audit(db, { actorId: user?.id ?? null, action: 'auth.login_failed', details: { reason } });
      throw new HttpError(401, 'invalid_credentials');
    }

    // A browser that logs in again drops its previous session.
    const previous = request.cookies[SESSION_COOKIE];
    if (previous) await db.delete(sessionsTable).where(eq(sessionsTable.id, hashToken(previous)));

    const publicUser: User = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      totpEnabled: user.totpEnabledAt !== null,
    };
    const stage = publicUser.totpEnabled || totpRequired(user.role) ? 'password' : 'full';
    const session = await createSession(db, config, user.id, stage);
    if (stage === 'full') await completeLogin(user.id, 'none');
    setSessionCookie(reply, config, session);
    return meResponse(stage, publicUser);
  });

  app.post(API.totpVerify, { preHandler: [requireSession, totpPerUser] }, async (request, reply) => {
    const auth = getAuth(request);
    const { code } = parseBody(TotpCodeRequest, request.body);
    if (auth.stage !== 'password' || !auth.user.totpEnabled) throw new HttpError(409, 'conflict');

    const state = await totpState(auth.user.id);
    const step = state.secret ? verifyTotp(state.secret, code, state.lastStep) : null;
    if (step === null) return totpFailed(auth.user.id, 'verify');
    // Store the step only if it is still newer than the stored one: two parallel requests with the
    // same code cannot both succeed.
    const claimed = await db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, auth.user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
      .returning({ id: users.id });
    if (claimed.length === 0) return totpFailed(auth.user.id, 'verify');

    const session = await rotateSession(db, config, auth.sessionId, auth.user.id, 'full');
    await completeLogin(auth.user.id, 'totp');
    setSessionCookie(reply, config, session);
    return meResponse('full', auth.user);
  });

  app.post(API.totpSetup, { preHandler: [requireSession] }, async (request) => {
    const auth = getAuth(request);
    if (auth.user.totpEnabled) throw new HttpError(409, 'conflict');

    // A new secret on every call; it only becomes active through totp/enable.
    const secret = generateTotpSecret();
    await db
      .update(users)
      .set({ totpSecret: secret, totpLastStep: null, updatedAt: sql`now()` })
      .where(and(eq(users.id, auth.user.id), isNull(users.totpEnabledAt)));
    const { companyName } = await getSetting(db, 'branding');
    return TotpSetupResponse.parse({ secret, otpauthUrl: totpUri(secret, companyName, auth.user.email) });
  });

  app.post(API.totpEnable, { preHandler: [requireSession, totpPerUser] }, async (request, reply) => {
    const auth = getAuth(request);
    const { code } = parseBody(TotpCodeRequest, request.body);
    const state = await totpState(auth.user.id);
    if (state.enabledAt !== null || !state.secret) throw new HttpError(409, 'conflict');

    const step = verifyTotp(state.secret, code, state.lastStep);
    if (step === null) return totpFailed(auth.user.id, 'enable');
    const enabled = await db
      .update(users)
      .set({ totpEnabledAt: sql`now()`, totpLastStep: step, updatedAt: sql`now()` })
      // Same secret as checked above: a parallel totp/setup must not be enabled unseen.
      .where(and(eq(users.id, auth.user.id), isNull(users.totpEnabledAt), eq(users.totpSecret, state.secret)))
      .returning({ id: users.id });
    if (enabled.length === 0) throw new HttpError(409, 'conflict');
    await audit(db, { actorId: auth.user.id, action: 'auth.totp_enabled', targetType: 'user', targetId: auth.user.id });

    const session = await rotateSession(db, config, auth.sessionId, auth.user.id, 'full');
    if (auth.stage === 'password') await completeLogin(auth.user.id, 'totp_setup');
    setSessionCookie(reply, config, session);
    return meResponse('full', { ...auth.user, totpEnabled: true });
  });

  const passwordPerUser = rateLimit(app, {
    max: 5,
    timeWindow: MINUTE,
    keyGenerator: (request) => `password:${getAuth(request).user.id}`,
  });

  app.post(API.password, { preHandler: [requireFull, passwordPerUser] }, async (request, reply) => {
    const auth = getAuth(request);
    const body = parseBody(ChangePasswordRequest, request.body);
    const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, auth.user.id));
    if (!row || !(await verifyPassword(row.hash, body.currentPassword)))
      throw new HttpError(401, 'invalid_credentials');
    const passwordHash = await hashPassword(body.newPassword);
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, updatedAt: sql`now()` })
        .where(eq(users.id, auth.user.id));
      // Log out every other browser; this one stays logged in.
      await tx
        .delete(sessionsTable)
        .where(and(eq(sessionsTable.userId, auth.user.id), ne(sessionsTable.id, auth.sessionId)));
      await audit(tx, {
        actorId: auth.user.id,
        action: 'auth.password_changed',
        targetType: 'user',
        targetId: auth.user.id,
      });
    });
    return reply.code(204).send();
  });

  app.get(API.me, { preHandler: [requireSession] }, async (request) => {
    const auth = getAuth(request);
    return meResponse(auth.stage, auth.user);
  });

  app.post(API.logout, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const [deleted] = await db
        .delete(sessionsTable)
        .where(eq(sessionsTable.id, hashToken(token)))
        .returning({ userId: sessionsTable.userId });
      if (deleted) await audit(db, { actorId: deleted.userId, action: 'auth.logout' });
    }
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });
}
