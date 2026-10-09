import type { z } from 'zod';
import { HttpError } from './errors.ts';

/** Validates a request body against a schema from @scan/shared; anything invalid is a plain 400. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, 'bad_request');
  return result.data;
}
