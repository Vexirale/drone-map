import type { Readable } from 'node:stream';

/**
 * Where files live (scans, renders, photos, reports). Keys are relative paths such as
 * `jobs/<jobId>/scans/<scanId>/web.glb`. Today everything is on local disk (a Docker volume);
 * an S3-compatible implementation can be added behind this interface later (SPEC: Storage).
 */
export interface Storage {
  /** Writes a whole file. Replaces an existing one atomically. */
  put(key: string, data: Buffer | Readable): Promise<void>;
  /** Throws ENOENT when the key does not exist. */
  getStream(key: string): Readable;
  stat(key: string): Promise<{ size: number; modifiedAt: Date } | null>;
  exists(key: string): Promise<boolean>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** Lower-case segments of letters, digits, dot, dash and underscore; no empty, '.' or '..' segments. */
const SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/;

export class InvalidStorageKeyError extends Error {
  override name = 'InvalidStorageKeyError';
}

/** Throws for anything that is not a plain relative key, so a key can never escape the storage root. */
export function assertValidKey(key: string): void {
  const segments = key.split('/');
  const ok =
    key.length > 0 &&
    key.length <= 512 &&
    segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..' && !s.endsWith('.'));
  if (!ok) throw new InvalidStorageKeyError(`invalid storage key: ${JSON.stringify(key.slice(0, 80))}`);
}
