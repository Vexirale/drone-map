import type { ErrorCode } from '@scan/shared';

/**
 * Throw this from a route or hook to answer with `{ error: { code } }`. The web app maps the code
 * to Dutch text, so the server never sends user-facing messages.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode) {
    super(code);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const errorBody = (code: ErrorCode) => ({ error: { code } });
