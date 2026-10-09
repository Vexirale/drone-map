import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';
import { currentTotpCode, generateTotpSecret, verifyTotp } from '../src/auth/totp.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { buildAllowList, isAllowedAddress, isPublicPath } from '../src/security.ts';
import { LocalDiskStorage } from '../src/storage/local.ts';
import { InvalidStorageKeyError, assertValidKey } from '../src/storage/storage.ts';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password!!')).toBe(false);
  });

  it('treats a malformed hash as a wrong password', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
  });
});

describe('TOTP', () => {
  const secret = generateTotpSecret();
  const now = Date.UTC(2026, 9, 9, 12, 0, 15);

  it('accepts the current code and returns its step', () => {
    const step = verifyTotp(secret, currentTotpCode(secret, now), null, now);
    expect(step).toBe(Math.floor(now / 1000 / 30));
  });

  it('accepts one step of clock drift either way', () => {
    expect(verifyTotp(secret, currentTotpCode(secret, now - 30_000), null, now)).not.toBeNull();
    expect(verifyTotp(secret, currentTotpCode(secret, now + 30_000), null, now)).not.toBeNull();
    expect(verifyTotp(secret, currentTotpCode(secret, now - 90_000), null, now)).toBeNull();
  });

  it('rejects a code whose step was already used (replay)', () => {
    const code = currentTotpCode(secret, now);
    const step = verifyTotp(secret, code, null, now)!;
    expect(verifyTotp(secret, code, step, now)).toBeNull();
    expect(verifyTotp(secret, currentTotpCode(secret, now + 30_000), step, now)).toBe(step + 1);
  });

  it('rejects a wrong code', () => {
    const code = currentTotpCode(secret, now);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect(verifyTotp(secret, wrong, null, now)).toBeNull();
  });
});

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost/db' };

  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.appOrigin).toBe('http://localhost:5173');
    expect(c.odoo.dryRun).toBe(true);
    expect(c.staffAllowedCidrs).toEqual([]);
    expect(path.isAbsolute(c.dataDir)).toBe(true);
  });

  it('lists every invalid variable without printing secrets', () => {
    try {
      loadConfig({ ...base, PORT: 'eighty', ADMIN_PASSWORD: 'tooshort', STAFF_ALLOWED_CIDRS: '10.0.0.0/33' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as Error).message;
      expect(message).toContain('PORT');
      expect(message).toContain('ADMIN_PASSWORD');
      expect(message).toContain('STAFF_ALLOWED_CIDRS');
      expect(message).not.toContain('tooshort');
    }
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL: is required/);
  });

  it('normalises APP_ORIGIN and rejects paths', () => {
    expect(loadConfig({ ...base, APP_ORIGIN: 'https://scan.example.nl/' }).appOrigin).toBe('https://scan.example.nl');
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'https://scan.example.nl/app' })).toThrow(/APP_ORIGIN/);
  });
});

describe('staff network restriction', () => {
  const list = buildAllowList([
    { address: '192.168.1.0', prefix: 24, family: 'ipv4' },
    { address: 'fd00::', prefix: 8, family: 'ipv6' },
  ]);

  it('checks IPv4, IPv6 and IPv4-mapped IPv6 addresses', () => {
    expect(isAllowedAddress(list, '192.168.1.20')).toBe(true);
    expect(isAllowedAddress(list, '::ffff:192.168.1.20')).toBe(true);
    expect(isAllowedAddress(list, '192.168.2.20')).toBe(false);
    expect(isAllowedAddress(list, 'fd12::1')).toBe(true);
    expect(isAllowedAddress(list, '2001:db8::1')).toBe(false);
  });

  it('keeps share pages, assets and /health public, and nothing else', () => {
    for (const p of ['/health', '/v/abc', '/api/public/x', '/assets/index-1a2b.js', '/favicon.svg', '/robots.txt']) {
      expect(isPublicPath(p), p).toBe(true);
    }
    for (const p of ['/', '/login', '/api/auth/me', '/v/../api/users', '/assets/%2e%2e/x', '/healthz']) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

describe('local disk storage', () => {
  let root: string;
  let storage: LocalDiskStorage;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'scan-storage-'));
    storage = new LocalDiskStorage(root);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('rejects keys that could escape the root', () => {
    for (const key of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'A/b', 'a\\b', 'a/./b', 'a/b.', 'a b']) {
      expect(() => assertValidKey(key), key).toThrow(InvalidStorageKeyError);
    }
    expect(() => assertValidKey('jobs/0f3c/scans/a1/web.glb')).not.toThrow();
  });

  it('writes, reads, stats and deletes buffers and streams', async () => {
    await storage.put('jobs/j1/a.txt', Buffer.from('hallo'));
    await storage.put('jobs/j1/b.txt', Readable.from(['stream ', 'data']));
    expect(await readFile(path.join(root, 'jobs/j1/a.txt'), 'utf8')).toBe('hallo');
    const chunks: Buffer[] = [];
    for await (const c of storage.getStream('jobs/j1/b.txt')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('stream data');
    expect((await storage.stat('jobs/j1/a.txt'))?.size).toBe(5);
    expect(await storage.exists('jobs/j1/missing.txt')).toBe(false);
    await storage.put('jobs/j1/a.txt', Buffer.from('nieuw'));
    expect(await readFile(path.join(root, 'jobs/j1/a.txt'), 'utf8')).toBe('nieuw');
    await storage.delete('jobs/j1/a.txt');
    await storage.delete('jobs/j1/a.txt');
    expect(await storage.exists('jobs/j1/a.txt')).toBe(false);
    // No temporary files are left behind.
    expect((await readdir(path.join(root, 'jobs/j1'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('does not leave a partial file when a stream fails', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('connection lost'));
      },
    });
    await expect(storage.put('jobs/j2/broken.bin', failing)).rejects.toThrow('connection lost');
    expect(await storage.exists('jobs/j2/broken.bin')).toBe(false);
    expect((await readdir(path.join(root, 'jobs/j2'))).length).toBe(0);
  });
});
