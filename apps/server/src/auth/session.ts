import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { Role, User } from '@scan/shared';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';

/**
 * Database sessions. The browser holds a random 256-bit token in the httpOnly cookie `sid`; the
 * database stores only its SHA-256, so a leaked database dump contains no usable sessions.
 *
 * - 'password' stage: password checked, second factor (or forced TOTP setup) pending; 10 minutes.
 * - 'full' stage: logged in; SESSION_TTL_DAYS, absolute (activity does not extend it).
 * Moving from 'password' to 'full' always issues a new token (no session fixation).
 */
export const SESSION_COOKIE = 'sid';
export const PASSWORD_STAGE_TTL_MS = 10 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export type SessionStage = 'password' | 'full';

export interface AuthContext {
  sessionId: string;
  stage: SessionStage;
  user: User;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const ttlMs = (stage: SessionStage, config: Config) =>
  stage === 'full' ? config.sessionTtlDays * 24 * 60 * 60 * 1000 : PASSWORD_STAGE_TTL_MS;

export interface NewSession {
  token: string;
  id: string;
  expiresAt: Date;
}

type Tx = Pick<Db, 'insert' | 'delete'>;

export async function createSession(db: Tx, config: Config, userId: string, stage: SessionStage): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const id = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs(stage, config));
  await db.insert(sessions).values({ id, userId, stage, expiresAt });
  return { token, id, expiresAt };
}

/** Replaces a session with a new one (new token) in one transaction. */
export async function rotateSession(
  db: Db,
  config: Config,
  oldSessionId: string,
  userId: string,
  stage: SessionStage,
): Promise<NewSession> {
  return db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.id, oldSessionId));
    return createSession(tx, config, userId, stage);
  });
}

/**
 * Looks up the session for a cookie token. Returns null when it does not exist, has expired or
 * belongs to a deactivated user. Updates last_seen_at at most every 5 minutes.
 */
export async function findSession(db: Db, token: string): Promise<AuthContext | null> {
  const id = hashToken(token);
  const [row] = await db
    .select({
      stage: sessions.stage,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      totpEnabledAt: users.totpEnabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, sql`now()`), eq(users.active, true)));
  if (!row) return null;

  if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(sessions.id, id));
  }
  return {
    sessionId: id,
    stage: row.stage,
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      role: row.role as Role,
      totpEnabled: !!row.totpEnabledAt,
    },
  };
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Logs a user out everywhere (TOTP reset, deactivation). */
export async function deleteUserSessions(db: Pick<Db, 'delete'>, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Nightly cleanup. Returns the number of deleted rows. */
export async function deleteExpiredSessions(db: Db): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`now()`))
    .returning({ id: sessions.id });
  return deleted.length;
}

const cookieOptions = (config: Config) =>
  ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' }) as const;

export function setSessionCookie(reply: FastifyReply, config: Config, session: NewSession): void {
  reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions(config), expires: session.expiresAt });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config));
}
