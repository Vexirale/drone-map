import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type PutResult, type Storage, assertValidKey } from './storage.ts';

/**
 * Files under one root directory (DATA_DIR). Writes go to a temporary file next to the target and
 * are renamed into place, so a crash never leaves a half-written file under the real key.
 */
export class LocalDiskStorage implements Storage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, data: Buffer | Readable): Promise<PutResult> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        Buffer.isBuffer(data) ? Readable.from([data]) : data,
        async function* (chunks: AsyncIterable<Buffer | string>) {
          for await (const chunk of chunks) {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            hash.update(bytes);
            size += bytes.length;
            yield bytes;
          }
        },
        createWriteStream(temp, { flags: 'wx' }),
      );
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return { size, sha256: hash.digest('hex') };
  }

  getStream(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  async stat(key: string): Promise<{ size: number; modifiedAt: Date } | null> {
    try {
      const s = await fsStat(this.pathFor(key));
      return s.isFile() ? { size: s.size, modifiedAt: s.mtime } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
