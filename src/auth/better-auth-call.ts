import type { FastifyReply } from 'fastify';
import { AppError } from '../http/errors.js';

/**
 * Calls a Better Auth server endpoint, forwards any Set-Cookie headers to our reply and maps
 * library errors to the API error envelope.
 */
export async function callAuth<T>(reply: FastifyReply | null, call: () => Promise<{ headers: Headers; response: T } | T>): Promise<T> {
  try {
    const result = (await call()) as { headers?: Headers; response?: T } | T;
    if (result && typeof result === 'object' && 'headers' in result && result.headers instanceof Headers) {
      const cookies = result.headers.getSetCookie();
      if (reply && cookies.length) reply.header('set-cookie', cookies);
      return (result as { response: T }).response;
    }
    return result as T;
  } catch (error) {
    throw mapAuthError(error);
  }
}

export function mapAuthError(error: unknown): Error {
  if (error instanceof AppError) return error;
  const e = error as { status?: string | number; statusCode?: number; body?: { code?: string; message?: string }; message?: string };
  const status = typeof e.statusCode === 'number' ? e.statusCode : typeof e.status === 'number' ? e.status : undefined;
  if (!status) return error as Error;
  const code = (e.body?.code ?? 'auth_error').toLowerCase();
  const messages: Record<string, string> = {
    invalid_email_or_password: 'Email or password is incorrect.',
    invalid_two_factor_code: 'That code is not valid. Try the latest code from your authenticator app.',
    invalid_code: 'That code is not valid. Try the latest code from your authenticator app.',
    invalid_backup_code: 'That backup code is not valid.',
    invalid_token: 'This link is invalid or has expired. Request a new one.',
    password_too_short: 'Use at least 14 characters for your password.',
    password_too_long: 'Use at most 128 characters for your password.',
    invalid_password: 'The current password is incorrect.',
    too_many_attempts: 'Too many attempts. Try again later.'
  };
  const mappedStatus = status === 400 && code.includes('password') ? 422 : status;
  return new AppError(mappedStatus, code, messages[code] ?? e.body?.message ?? 'Authentication failed.');
}
