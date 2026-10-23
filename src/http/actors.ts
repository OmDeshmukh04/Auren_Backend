import type { FastifyRequest } from 'fastify';
import type { AppDeps, ApplicantActor, StaffActor } from '../context.js';
import { ROLE_PERMISSIONS, type StaffRole } from '../auth/permissions.js';
import { forbidden, unauthorized } from './errors.js';
import { hashToken } from '../lib/crypto.js';

/** Node request headers as a Fetch Headers object (for the auth library). */
export function toFetchHeaders(raw: FastifyRequest['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
    else headers.set(key, String(value));
  }
  return headers;
}

const STAFF_CACHE = Symbol('staffActor');
type CachedRequest = FastifyRequest & { [STAFF_CACHE]?: StaffActor | null };

/**
 * Resolves the signed-in staff member from the session cookie. Returns null when there is no
 * valid session. Suspended staff and staff without a profile are refused even with a session.
 */
export async function resolveStaff(deps: AppDeps, req: FastifyRequest): Promise<StaffActor | null> {
  const cached = req as CachedRequest;
  if (cached[STAFF_CACHE] !== undefined) return cached[STAFF_CACHE] ?? null;
  const result = await deps.auth.api.getSession({ headers: toFetchHeaders(req.headers) }).catch(() => null);
  if (!result?.session || !result.user) {
    cached[STAFF_CACHE] = null;
    return null;
  }
  const member = await deps.db
    .selectFrom('staffMembers')
    .select(['id', 'email', 'displayName', 'role', 'status'])
    .where('userId', '=', result.user.id)
    .executeTakeFirst();
  if (!member) {
    cached[STAFF_CACHE] = null;
    return null;
  }
  if (member.status !== 'active') throw forbidden('This staff account is suspended.', 'account_suspended');
  const role = member.role as StaffRole;
  const actor: StaffActor = {
    type: 'staff',
    staffId: member.id,
    userId: result.user.id,
    sessionId: result.session.id,
    email: member.email,
    displayName: member.displayName,
    role,
    permissions: ROLE_PERMISSIONS[role],
    mfaEnabled: Boolean((result.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled)
  };
  cached[STAFF_CACHE] = actor;
  return actor;
}

export const DRAFT_COOKIE = 'auren_draft';

/** Resolves the applicant draft session cookie (scoped to exactly one draft). */
export async function resolveApplicant(deps: AppDeps, req: FastifyRequest): Promise<ApplicantActor> {
  const token = req.cookies?.[DRAFT_COOKIE];
  if (!token) throw unauthorized('Your application session has ended. Use the link in your email to continue.', 'draft_session_required');
  const now = deps.clock.now().toISOString();
  const row = await deps.db
    .selectFrom('draftAccessTokens as t')
    .innerJoin('applicationDrafts as d', 'd.id', 't.draftId')
    .select(['t.id', 't.draftId', 'd.status'])
    .where('t.tokenHash', '=', hashToken(token))
    .where('t.kind', '=', 'session')
    .where('t.revokedAt', 'is', null)
    .where('t.expiresAt', '>', now)
    .executeTakeFirst();
  if (!row || row.status === 'withdrawn' || row.status === 'expired') {
    throw unauthorized('Your application session has ended. Use the link in your email to continue.', 'draft_session_required');
  }
  await deps.db.updateTable('draftAccessTokens').set({ lastUsedAt: now }).where('id', '=', row.id).execute();
  return { type: 'applicant', draftId: row.draftId, sessionTokenId: row.id };
}
