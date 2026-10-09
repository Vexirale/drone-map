import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API, MeResponse, UsersResponse } from '@scan/shared';
import { deleteExpiredSessions } from '../src/auth/session.ts';
import { currentTotpCode, generateTotpSecret } from '../src/auth/totp.ts';
import { ensureFirstAdmin } from '../src/bootstrap.ts';
import { auditLog, sessions, users } from '../src/db/schema.ts';
import { createLogger } from '../src/log.ts';
import { createUser, resetPassword } from '../src/users.ts';
import { ORIGIN, get, makeApp, post, resetData, sidFrom, testConfig, testDb } from './helpers.ts';

const PASSWORD = 'een lang wachtwoord';
const { db, pool } = testDb();

async function addUser(role: 'admin' | 'operator', email: string, totpSecret?: string): Promise<string> {
  const id = (await createUser(db, { email, name: role, role, password: PASSWORD }, null, 'cli'))!;
  if (totpSecret) await db.update(users).set({ totpSecret, totpEnabledAt: new Date() }).where(eq(users.id, id));
  return id;
}

async function auditActions(): Promise<string[]> {
  const rows = await db.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.id);
  return rows.map((r) => r.action);
}

let app: FastifyInstance;
beforeEach(async () => {
  await resetData();
  app = await makeApp();
});
afterEach(() => app.close());
afterAll(() => pool.end());

describe('login', () => {
  it('answers 401 for /me without a session', async () => {
    const res = await get(app, API.me);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthenticated' } });
  });

  it('logs an operator without TOTP straight in', async () => {
    await addUser('operator', 'jan@example.nl');
    const res = await post(app, API.login, { email: ' Jan@Example.NL ', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = MeResponse.parse(res.json());
    expect(body.next).toBeNull();
    expect(body.user.role).toBe('operator');
    const sid = sidFrom(res)!;
    expect(res.cookies.find((c) => c.name === 'sid')).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect((await get(app, API.me, sid)).statusCode).toBe(200);
    // Operators cannot list users.
    expect((await get(app, API.users, sid)).json()).toEqual({ error: { code: 'forbidden' } });
    expect(await auditActions()).toEqual(['user.created', 'auth.login']);
  });

  it('gives the same 401 for a wrong password, an unknown e-mail and an inactive account', async () => {
    const id = await addUser('operator', 'jan@example.nl');
    await addUser('operator', 'piet@example.nl');
    await db.update(users).set({ active: false }).where(eq(users.email, 'piet@example.nl'));
    for (const body of [
      { email: 'jan@example.nl', password: 'verkeerd wachtwoord' },
      { email: 'niemand@example.nl', password: PASSWORD },
      { email: 'piet@example.nl', password: PASSWORD },
    ]) {
      const res = await post(app, API.login, body);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'invalid_credentials' } });
      expect(sidFrom(res)).toBeUndefined();
    }
    const failed = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.login_failed'))
      .orderBy(auditLog.id);
    expect(failed.map((r) => [r.actorId, (r.details as { reason: string }).reason])).toEqual([
      [id, 'wrong_password'],
      [null, 'unknown_email'],
      [expect.any(String), 'inactive'],
    ]);
  });

  it('rejects a malformed body with 400', async () => {
    const res = await post(app, API.login, { email: 'geen-email', password: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'bad_request' } });
  });

  it('rate-limits repeated attempts for one e-mail', async () => {
    await addUser('operator', 'jan@example.nl');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await post(app, API.login, { email: 'jan@example.nl', password: 'fout fout fout' })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    const res = await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD });
    expect(res.json()).toEqual({ error: { code: 'rate_limited' } });
    // Another account from the same address is not blocked by that.
    await addUser('operator', 'piet@example.nl');
    expect((await post(app, API.login, { email: 'piet@example.nl', password: PASSWORD })).statusCode).toBe(200);
  });
});

describe('two-step verification', () => {
  it('forces an admin without TOTP through setup before anything else', async () => {
    await addUser('admin', 'admin@example.nl');
    const login = await post(app, API.login, { email: 'admin@example.nl', password: PASSWORD });
    expect(MeResponse.parse(login.json()).next).toBe('totp_setup');
    const halfSid = sidFrom(login)!;
    expect((await get(app, API.users, halfSid)).json()).toEqual({ error: { code: 'second_factor_required' } });

    const setup = await post(app, API.totpSetup, {}, halfSid);
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUrl } = setup.json() as { secret: string; otpauthUrl: string };
    // Opening the setup screen again (reload, second tab) keeps the secret the user may have scanned.
    expect(((await post(app, API.totpSetup, {}, halfSid)).json() as { secret: string }).secret).toBe(secret);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/Bedrijfsnaam:admin%40example\.nl\?/);

    expect((await post(app, API.totpEnable, { code: '000000' }, halfSid)).statusCode).toBe(401);
    const enable = await post(app, API.totpEnable, { code: currentTotpCode(secret) }, halfSid);
    expect(enable.statusCode).toBe(200);
    expect(MeResponse.parse(enable.json())).toMatchObject({ next: null, user: { totpEnabled: true } });

    // The session was replaced: the half-way token is dead, the new one is a full session.
    const fullSid = sidFrom(enable)!;
    expect(fullSid).not.toBe(halfSid);
    expect((await get(app, API.me, halfSid)).statusCode).toBe(401);
    const list = UsersResponse.parse((await get(app, API.users, fullSid)).json());
    expect(list.users).toHaveLength(1);
    expect(list.users[0]).toMatchObject({ email: 'admin@example.nl', totpEnabled: true });

    expect(await auditActions()).toEqual(['user.created', 'auth.totp_failed', 'auth.totp_enabled', 'auth.login']);
    // Setting it up again is refused.
    expect((await post(app, API.totpSetup, {}, fullSid)).statusCode).toBe(409);
  });

  it('asks a user with TOTP for a code, and never accepts the same code twice', async () => {
    const secret = generateTotpSecret();
    await addUser('admin', 'admin@example.nl', secret);

    const first = await post(app, API.login, { email: 'admin@example.nl', password: PASSWORD });
    expect(MeResponse.parse(first.json()).next).toBe('totp');
    const sid1 = sidFrom(first)!;
    expect((await post(app, API.totpVerify, { code: '123' }, sid1)).statusCode).toBe(400);
    const code = currentTotpCode(secret);
    const ok = await post(app, API.totpVerify, { code }, sid1);
    expect(ok.statusCode).toBe(200);
    expect(MeResponse.parse(ok.json()).next).toBeNull();
    expect(sidFrom(ok)).not.toBe(sid1);

    // Someone who saw that code cannot reuse it with the password.
    const second = await post(app, API.login, { email: 'admin@example.nl', password: PASSWORD });
    const replay = await post(app, API.totpVerify, { code }, sidFrom(second)!);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: { code: 'invalid_code' } });
    // The next time step works.
    const next = await post(
      app,
      API.totpVerify,
      { code: currentTotpCode(secret, Date.now() + 30_000) },
      sidFrom(second)!,
    );
    expect(next.statusCode).toBe(200);
  });

  it('lets an operator opt in to TOTP from a full session', async () => {
    await addUser('operator', 'jan@example.nl');
    const sid = sidFrom(await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD }))!;
    const { secret } = (await post(app, API.totpSetup, {}, sid)).json() as { secret: string };
    const enable = await post(app, API.totpEnable, { code: currentTotpCode(secret) }, sid);
    expect(enable.statusCode).toBe(200);
    const relogin = await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD });
    expect(MeResponse.parse(relogin.json()).next).toBe('totp');
  });
});

describe('sessions', () => {
  it('logs out and forgets the session', async () => {
    await addUser('operator', 'jan@example.nl');
    const sid = sidFrom(await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD }))!;
    const res = await post(app, API.logout, {}, sid);
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === 'sid')?.value).toBe('');
    expect((await get(app, API.me, sid)).statusCode).toBe(401);
    expect((await auditActions()).at(-1)).toBe('auth.logout');
  });

  it('rejects an expired session and cleans it up at night', async () => {
    await addUser('operator', 'jan@example.nl');
    const sid = sidFrom(await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD }))!;
    await db.update(sessions).set({ expiresAt: sql`now() - interval '1 minute'` });
    expect((await get(app, API.me, sid)).statusCode).toBe(401);
    expect(await deleteExpiredSessions(db)).toBe(1);
  });

  it('stores only a hash of the session token', async () => {
    await addUser('operator', 'jan@example.nl');
    const sid = sidFrom(await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD }))!;
    const rows = await db.select({ id: sessions.id }).from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toContain(sid);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the password and ends the other sessions only', async () => {
    await addUser('operator', 'jan@example.nl');
    const sidA = sidFrom(await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD }))!;
    const sidB = sidFrom(await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD }))!;
    const wrong = await post(
      app,
      API.password,
      { currentPassword: 'niet goed', newPassword: 'een nieuw lang wachtwoord' },
      sidA,
    );
    expect(wrong.statusCode).toBe(401);
    const tooShort = await post(app, API.password, { currentPassword: PASSWORD, newPassword: 'kort' }, sidA);
    expect(tooShort.statusCode).toBe(400);
    const ok = await post(
      app,
      API.password,
      { currentPassword: PASSWORD, newPassword: 'een nieuw lang wachtwoord' },
      sidA,
    );
    expect(ok.statusCode).toBe(204);
    expect((await get(app, API.me, sidA)).statusCode).toBe(200);
    expect((await get(app, API.me, sidB)).statusCode).toBe(401);
    expect((await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD })).statusCode).toBe(401);
    expect(
      (await post(app, API.login, { email: 'jan@example.nl', password: 'een nieuw lang wachtwoord' })).statusCode,
    ).toBe(200);
  });
});

describe('request hygiene', () => {
  it('rejects state-changing requests from another origin', async () => {
    await addUser('operator', 'jan@example.nl');
    const body = { email: 'jan@example.nl', password: PASSWORD };
    expect((await post(app, API.login, body, undefined, { origin: 'https://evil.example' })).statusCode).toBe(403);
    const noOrigin = await app.inject({
      method: 'POST',
      url: API.login,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(noOrigin.statusCode).toBe(403);
    const sameSite = await app.inject({
      method: 'POST',
      url: API.login,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: JSON.stringify(body),
    });
    expect(sameSite.statusCode).toBe(200);
  });

  it('also checks the Origin when the path is percent-encoded', async () => {
    await addUser('operator', 'jan@example.nl');
    const sid = sidFrom(await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD }))!;
    for (const url of ['/%61pi/auth/logout', '/ap%69/auth/logout']) {
      const res = await post(app, url, {}, sid, { origin: 'https://evil.example' });
      expect(res.statusCode, url).toBe(403);
    }
    expect((await get(app, API.me, sid)).statusCode).toBe(200);
  });

  it('accepts JSON bodies only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: API.login,
      headers: { origin: ORIGIN, 'content-type': 'text/plain' },
      payload: '{"email":"a@b.nl","password":"x"}',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: { code: 'bad_request' } });
  });

  it('limits the staff app to STAFF_ALLOWED_CIDRS but keeps /health public', async () => {
    const restricted = await makeApp({ STAFF_ALLOWED_CIDRS: '10.0.0.0/8' });
    try {
      const outside = await restricted.inject({ method: 'GET', url: API.me, remoteAddress: '192.168.1.5' });
      expect(outside.statusCode).toBe(403);
      const inside = await restricted.inject({ method: 'GET', url: API.me, remoteAddress: '10.1.2.3' });
      expect(inside.statusCode).toBe(401);
      expect(
        (await restricted.inject({ method: 'GET', url: '/health', remoteAddress: '192.168.1.5' })).statusCode,
      ).toBe(200);
    } finally {
      await restricted.close();
    }
  });

  it('reports health', async () => {
    const res = await get(app, '/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('serves the web app with client-side routing, and JSON 404s for the API', async () => {
    const dist = await mkdtemp(path.join(os.tmpdir(), 'scan-web-'));
    try {
      await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
      await mkdir(path.join(dist, 'assets'));
      await writeFile(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
      const web = await makeApp({}, dist);
      try {
        const page = await get(web, '/opdrachten/123');
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('<title>app</title>');
        expect(page.headers['cache-control']).toBe('no-cache');
        const asset = await get(web, '/assets/index-abc123.js');
        expect(asset.statusCode).toBe(200);
        expect(asset.headers['cache-control']).toContain('immutable');
        const api = await get(web, '/api/nope');
        expect(api.statusCode).toBe(404);
        expect(api.json()).toEqual({ error: { code: 'not_found' } });
        expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      } finally {
        await web.close();
      }
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe('password reset (pnpm user:reset-password)', () => {
  it('sets a new password, ends every session and writes an audit row', async () => {
    const id = await addUser('operator', 'jan@example.nl');
    const sid = sidFrom(await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD }))!;
    await resetPassword(db, id, 'een gloednieuw wachtwoord', null);
    expect((await get(app, API.me, sid)).statusCode).toBe(401);
    expect((await post(app, API.login, { email: 'jan@example.nl', password: PASSWORD })).statusCode).toBe(401);
    expect(
      (await post(app, API.login, { email: 'jan@example.nl', password: 'een gloednieuw wachtwoord' })).statusCode,
    ).toBe(200);
    expect(await auditActions()).toContain('user.password_reset');
  });
});

describe('first admin', () => {
  const log = createLogger('silent');

  it('is created from the environment once, and only while no admin exists', async () => {
    const config = testConfig({ ADMIN_EMAIL: 'baas@example.nl', ADMIN_PASSWORD: 'een heel lang wachtwoord' });
    await ensureFirstAdmin(config, db, log);
    await ensureFirstAdmin(config, db, log);
    const admins = await db.select().from(users).where(eq(users.role, 'admin'));
    expect(admins.map((a) => a.email)).toEqual(['baas@example.nl']);
  });

  it('does nothing without ADMIN_EMAIL and ADMIN_PASSWORD', async () => {
    await ensureFirstAdmin(testConfig(), db, log);
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
