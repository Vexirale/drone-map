import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with the OWASP minimum parameters (19 MiB memory, 2 passes, 1 lane). argon2id is the
 * library's default algorithm; the `Algorithm` const enum cannot be imported under
 * isolatedModules, and the test asserts the `$argon2id$` prefix.
 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export { MIN_PASSWORD_LENGTH } from '@scan/shared';

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed hash in the database must not turn into a 500 on the login page.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real verification. Login calls this when the email is unknown, so the
 * response time does not reveal which accounts exist.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  await verifyPassword(await dummyHash, password);
  return false;
}

/** A random password for `pnpm user:add` when none is given: 24 URL-safe characters (144 bits). */
export const generatePassword = (): string => randomBytes(18).toString('base64url');
