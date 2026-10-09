import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('refuses TRUST_PROXY=true together with STAFF_ALLOWED_CIDRS (spoofable client IP)', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true', STAFF_ALLOWED_CIDRS: '10.0.0.0/8' })).toThrow(
      /TRUST_PROXY/,
    );
    expect(loadConfig({ ...base, TRUST_PROXY: '1', STAFF_ALLOWED_CIDRS: '10.0.0.0/8' }).trustProxy).toBe(1);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL: is required/);
  });

  it('normalises APP_ORIGIN and rejects paths', () => {
    expect(loadConfig({ ...base, APP_ORIGIN: 'https://scan.example.nl/' }).appOrigin).toBe('https://scan.example.nl');
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'https://scan.example.nl/app' })).toThrow(/APP_ORIGIN/);
  });

  it('reads secrets from <NAME>_FILE (Docker secrets, Secret Manager on Google Cloud)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'scan-secrets-'));
    try {
      await writeFile(path.join(dir, 'odoo'), 'odoo-key-123\n');
      await writeFile(path.join(dir, 'admin'), 'een lang wachtwoord\r\n');
      const c = loadConfig({
        ...base,
        ODOO_API_KEY_FILE: path.join(dir, 'odoo'),
        ADMIN_PASSWORD_FILE: path.join(dir, 'admin'),
      });
      expect(c.odoo.apiKey).toBe('odoo-key-123');
      expect(c.admin.password).toBe('een lang wachtwoord');

      // The file content is validated like the variable, and never printed.
      await writeFile(path.join(dir, 'short'), 'kort');
      expect(() => loadConfig({ ...base, ADMIN_PASSWORD_FILE: path.join(dir, 'short') })).toThrow(
        /ADMIN_PASSWORD: must be at least 12/,
      );
      expect(() => loadConfig({ ...base, ODOO_API_KEY: 'x', ODOO_API_KEY_FILE: path.join(dir, 'odoo') })).toThrow(
        /ODOO_API_KEY_FILE: set either ODOO_API_KEY or ODOO_API_KEY_FILE/,
      );
      try {
        loadConfig({ ...base, ODOO_API_KEY_FILE: path.join(dir, 'missing') });
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toContain('ODOO_API_KEY_FILE: cannot read the file');
        expect((err as Error).message).not.toContain(dir);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('puts DATABASE_PASSWORD into the URL percent-encoded, so any character works', () => {
    const password = 'p/a@s#s?w0rd%41 :é';
    const c = loadConfig({ DATABASE_URL: 'postgres://scan@db:5432/scan', DATABASE_PASSWORD: password });
    const url = new URL(c.databaseUrl);
    expect(decodeURIComponent(url.password)).toBe(password);
    expect([url.username, url.host, url.pathname]).toEqual(['scan', 'db:5432', '/scan']);
    expect(loadConfig(base).databaseUrl).toBe(base.DATABASE_URL);
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
    // SHA-256 of 'hallo' and of 'stream data' (strings in a stream count as UTF-8 bytes).
    expect(await storage.put('jobs/j1/a.txt', Buffer.from('hallo'))).toEqual({
      size: 5,
      sha256: 'd3751d33f9cd5049c4af2b462735457e4d3baf130bcbb87f389e349fbaeb20b9',
    });
    expect(await storage.put('jobs/j1/b.txt', Readable.from(['stream ', 'data']))).toEqual({
      size: 11,
      sha256: createHash('sha256').update('stream data').digest('hex'),
    });
    expect((await storage.put('jobs/j1/c.txt', Readable.from(['é']))).size).toBe(2);
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
