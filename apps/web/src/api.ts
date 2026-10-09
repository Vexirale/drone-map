import {
  API,
  ApiError as ApiErrorBody,
  LoginResponse,
  MeResponse,
  TotpSetupResponse,
  UsersResponse,
  type ChangePasswordRequest,
  type ErrorCode,
  type LoginRequest,
  type TotpCodeRequest,
} from '@scan/shared';
import { z } from 'zod';
import { nl } from './nl.ts';

/**
 * Tiny client for the API in apps/server. Same origin only (in dev through the Vite proxy), the
 * session lives in an httpOnly cookie. Every response is checked against the zod schemas from
 * @scan/shared, so a contract mismatch shows up as an error here and not as a crash in a component.
 */

/** 'network' is client-side only: no usable answer from the server at all. */
export type ClientErrorCode = ErrorCode | 'network';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number;

  constructor(code: ClientErrorCode, status: number) {
    super(`API error: ${code} (HTTP ${status})`);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Dutch message for anything a request can throw. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code === 'network' ? nl.networkError : nl.errors[error.code];
  return nl.errors.internal;
}

/** Used when an error response has no valid { error: { code } } body, for example from a proxy. */
function codeForStatus(status: number): ClientErrorCode {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  // Bad gateway, unavailable, gateway timeout: the API server is down or restarting.
  if (status === 502 || status === 503 || status === 504) return 'network';
  return 'internal';
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (method !== 'GET') {
    // Always a JSON body on POST, also when there is nothing to send: Fastify rejects an empty
    // body with a JSON content type, and a JSON content type keeps plain HTML forms out.
    init.headers = { accept: 'application/json', 'content-type': 'application/json' };
    init.body = JSON.stringify(options.body ?? {});
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('network', 0);
  }

  // Empty bodies (204) and non-JSON error pages both end up as undefined.
  const data: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const body = ApiErrorBody.safeParse(data);
    throw new ApiError(body.success ? body.data.error.code : codeForStatus(response.status), response.status);
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    console.error(`Unexpected response from ${method} ${path}`, parsed.error);
    throw new ApiError('internal', response.status);
  }
  return parsed.data;
}

export const api = {
  me: () => request(API.me, MeResponse),
  login: (body: LoginRequest) => request(API.login, LoginResponse, { method: 'POST', body }),
  logout: async (): Promise<void> => {
    await request(API.logout, z.unknown(), { method: 'POST' });
  },
  totpVerify: (body: TotpCodeRequest) => request(API.totpVerify, LoginResponse, { method: 'POST', body }),
  /** Starts (or restarts) TOTP setup: the server makes a new secret that is not active yet. */
  totpSetup: () => request(API.totpSetup, TotpSetupResponse, { method: 'POST' }),
  /**
   * Confirms setup with a first code. Returns the new session state when the server sends one
   * (like login and verify do), otherwise null and the caller refreshes the session.
   */
  totpEnable: async (body: TotpCodeRequest): Promise<MeResponse | null> => {
    const data = await request(API.totpEnable, z.unknown(), { method: 'POST', body });
    const session = MeResponse.safeParse(data);
    return session.success ? session.data : null;
  },
  /** Changes your own password; the server ends your other sessions. */
  changePassword: async (body: ChangePasswordRequest): Promise<void> => {
    await request(API.password, z.unknown(), { method: 'POST', body });
  },
  /** Admins only. */
  users: () => request(API.users, UsersResponse),
};
