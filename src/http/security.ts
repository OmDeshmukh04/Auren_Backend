import { sql } from 'kysely';
import type { Database, Tx } from '../db/index.js';
import type { AppDeps } from '../context.js';
import { AppError, tooManyRequests, unprocessable } from './errors.js';
import { canonicalJson, sha256 } from '../lib/crypto.js';

/**
 * Fixed-window rate limit shared across all API instances (Postgres row per key and window).
 * Throws 429 with Retry-After when the limit is exceeded.
 */
export async function enforceRateLimit(deps: AppDeps, key: string, baseMax: number, windowSeconds: number) {
  const { db } = deps;
  const now = deps.clock.now();
  const max = Math.ceil(baseMax * deps.config.RATE_LIMIT_SCALE);
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const row = await db
    .insertInto('rateLimitBuckets')
    .values({ key, windowStart: windowStart.toISOString(), count: 1 })
    .onConflict(oc => oc.columns(['key', 'windowStart']).doUpdateSet({ count: sql`rate_limit_buckets.count + 1` }))
    .returning('count')
    .executeTakeFirstOrThrow();
  if (row.count > max) {
    const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
    throw tooManyRequests(retryAfter);
  }
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Runs `work` exactly once per (scope, key). The key row is inserted inside the same
 * transaction as the work: a concurrent duplicate blocks on the unique key until the first
 * commits, then replays the stored response. If the work fails, nothing is stored and the
 * client may retry with the same key. Reusing a key with a different payload is rejected.
 */
export async function runIdempotent<T>(
  db: Database,
  input: { scope: string; key: string; request: unknown; ttlHours?: number; now: Date },
  work: (trx: Tx) => Promise<{ status: number; body: T }>
): Promise<IdempotentResult<T>> {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.key)) {
    throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8-200 characters (letters, digits, . _ : -).');
  }
  const requestHash = sha256(canonicalJson(input.request));
  const expiresAt = new Date(input.now.getTime() + (input.ttlHours ?? 24 * 7) * 3600_000).toISOString();
  return db.transaction().execute(async trx => {
    const inserted = await trx
      .insertInto('idempotencyKeys')
      .values({ scope: input.scope, key: input.key, requestHash, responseStatus: 0, responseBody: JSON.stringify(null), expiresAt })
      .onConflict(oc => oc.columns(['scope', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst();
    if (!inserted) {
      const existing = await trx
        .selectFrom('idempotencyKeys')
        .select(['requestHash', 'responseStatus', 'responseBody'])
        .where('scope', '=', input.scope)
        .where('key', '=', input.key)
        .executeTakeFirstOrThrow();
      if (existing.requestHash !== requestHash) {
        throw unprocessable('This Idempotency-Key was already used for a different request.', 'idempotency_key_reused');
      }
      return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
    }
    const result = await work(trx);
    await trx
      .updateTable('idempotencyKeys')
      .set({ responseStatus: result.status, responseBody: JSON.stringify(result.body) })
      .where('scope', '=', input.scope)
      .where('key', '=', input.key)
      .execute();
    return { ...result, replayed: false };
  });
}

/** Origin check for state-changing browser requests (defence in depth beside SameSite cookies). */
export function originAllowed(origin: string | undefined, allowed: readonly string[], selfOrigin: string) {
  if (!origin) return true;
  return origin === selfOrigin || allowed.includes(origin);
}
