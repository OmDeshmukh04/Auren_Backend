import { z } from 'zod';

/**
 * Every error response has the same shape:
 *   { "error": { "code", "message", "requestId", "fieldErrors"?, "details"? } }
 * `code` is a stable machine-readable identifier; `message` is safe to show to the user.
 */

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { fieldErrors?: FieldError[]; details?: Record<string, unknown>; headers?: Record<string, string> } = {}
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request') => new AppError(400, code, message);
export const unauthorized = (message = 'Sign in to continue.', code = 'unauthenticated') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that.', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (message: string, code = 'conflict', details?: Record<string, unknown>) =>
  new AppError(409, code, message, details ? { details } : {});
export const unprocessable = (message: string, code = 'unprocessable', details?: Record<string, unknown>) =>
  new AppError(422, code, message, details ? { details } : {});
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, 'rate_limited', 'Too many requests. Please wait and try again.', {
    headers: { 'Retry-After': String(retryAfterSeconds) },
    details: { retryAfterSeconds }
  });
export const unavailable = (message: string, code = 'unavailable') => new AppError(503, code, message);

export function validationFailed(fieldErrors: FieldError[], message = 'Some fields need attention.') {
  return new AppError(422, 'validation_failed', message, { fieldErrors });
}

/** Optimistic concurrency failure: the caller's copy is stale. */
export function versionConflict(currentVersion: number) {
  return new AppError(409, 'version_conflict', 'This record was changed by someone else. Reload it and apply your change again.', {
    details: { currentVersion }
  });
}

export function zodFieldErrors(error: z.ZodError, prefix?: string): FieldError[] {
  return error.issues.map(issue => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'),
    code: issue.code,
    message: issue.message
  }));
}

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      fieldErrors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional(),
      details: z.record(z.string(), z.unknown()).optional()
    })
  })
  .meta({ id: 'ErrorResponse', description: 'Error envelope returned for every non-2xx response.' });

/** Maps PostgreSQL errors raised by constraints and triggers to API errors. */
export function fromDatabaseError(error: unknown): AppError | undefined {
  const pgError = error as { code?: string; constraint?: string; message?: string };
  switch (pgError?.code) {
    case '23505':
      return conflict('A record with these details already exists.', 'duplicate', pgError.constraint ? { constraint: pgError.constraint } : undefined);
    case '23503':
      return unprocessable('A referenced record does not exist or is still in use.', 'invalid_reference', pgError.constraint ? { constraint: pgError.constraint } : undefined);
    case '23514':
      return unprocessable('The values break a data rule.', 'constraint_violation', pgError.constraint ? { constraint: pgError.constraint } : undefined);
    case '23001':
      return conflict(pgError.message?.replace(/^.*?: /, '') || 'This record cannot be changed.', 'immutable_record');
    case '40001':
    case '40P01':
      return new AppError(503, 'retry', 'The request conflicted with another update. Please retry.');
    default:
      return undefined;
  }
}
