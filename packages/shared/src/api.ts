import { z } from 'zod';
import { ROLES } from './roles.ts';

/**
 * HTTP contract between apps/web and apps/server. The server validates every request body
 * with these schemas; the web app uses the same types. Errors are machine codes; the web app
 * maps them to Dutch text, so no user-facing text lives on the server.
 */

export const API = {
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  me: '/api/auth/me',
  totpVerify: '/api/auth/totp/verify',
  totpSetup: '/api/auth/totp/setup',
  totpEnable: '/api/auth/totp/enable',
} as const;

export const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const totpCode = z.string().trim().regex(/^\d{6}$/);

export const LoginRequest = z.object({
  email,
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const User = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  totpEnabled: z.boolean(),
});
export type User = z.infer<typeof User>;

/**
 * A session is either half-way (password checked, second factor still needed) or full.
 * `next` tells the client which screen to show:
 * - 'totp': enter the code from the authenticator app;
 * - 'totp_setup': an admin without TOTP must set it up before doing anything else;
 * - null: fully logged in.
 */
export const SessionNext = z.enum(['totp', 'totp_setup']).nullable();
export type SessionNext = z.infer<typeof SessionNext>;

export const MeResponse = z.object({
  user: User,
  next: SessionNext,
});
export type MeResponse = z.infer<typeof MeResponse>;

/** POST login and POST totp/verify both answer with the new session state. */
export const LoginResponse = MeResponse;
export type LoginResponse = MeResponse;

export const TotpCodeRequest = z.object({ code: totpCode });
export type TotpCodeRequest = z.infer<typeof TotpCodeRequest>;

/** The secret is only ever returned while setup is in progress, never after TOTP is enabled. */
export const TotpSetupResponse = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponse>;

export const ERROR_CODES = [
  'bad_request',
  'invalid_credentials',
  'invalid_code',
  'rate_limited',
  'unauthenticated',
  'second_factor_required',
  'forbidden',
  'not_found',
  'conflict',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiError = z.object({
  error: z.object({ code: z.enum(ERROR_CODES) }),
});
export type ApiError = z.infer<typeof ApiError>;
