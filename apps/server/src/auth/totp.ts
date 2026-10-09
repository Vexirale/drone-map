import { Secret, TOTP } from 'otpauth';

/**
 * TOTP as every authenticator app expects it: SHA1, 6 digits, 30 second steps. A code is accepted
 * one step early or late (clock drift), and never twice: the caller stores the accepted time step
 * in users.totp_last_step and passes it back as `lastStep`.
 */
const PERIOD = 30;
const WINDOW = 1;

function totp(secretBase32: string, issuer = '', label = ''): TOTP {
  return new TOTP({
    issuer,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** A new random secret (160 bits, the RFC 4226 recommendation), base32 encoded. */
export const generateTotpSecret = (): string => new Secret({ size: 20 }).base32;

/** The otpauth:// URI the web app turns into a QR code. Issuer = company name, label = email. */
export const totpUri = (secretBase32: string, issuer: string, label: string): string =>
  totp(secretBase32, issuer, label).toString();

/**
 * Checks a code. Returns the accepted time step, or null when the code is wrong or its step is not
 * newer than `lastStep` (replay of a code that was already used).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastStep: number | null,
  now: number = Date.now(),
): number | null {
  const t = totp(secretBase32);
  const delta = t.validate({ token: code, timestamp: now, window: WINDOW });
  if (delta === null) return null;
  const step = t.counter({ timestamp: now }) + delta;
  if (lastStep !== null && step <= lastStep) return null;
  return step;
}

/** The current code for a secret (used by the tests and handy when debugging). */
export const currentTotpCode = (secretBase32: string, now: number = Date.now()): string =>
  totp(secretBase32).generate({ timestamp: now });
