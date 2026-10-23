import type { AppDeps, RequestMeta } from '../../context.js';
import type { Executor } from '../../db/index.js';
import type { StaffRole } from '../../auth/permissions.js';
import { audit } from '../../domain/audit.js';
import { conflict, notFound, unprocessable, versionConflict } from '../../http/errors.js';
import { hashToken, randomToken } from '../../lib/crypto.js';
import { DAY } from '../../lib/time.js';
import { createDelivery, dispatchDeliveries } from '../automation/deliveries.js';

/**
 * Staff accounts. There is no public registration: the first owner is created from the command
 * line (npm run owner:create) and everyone else joins through an owner's invitation.
 */

export async function createStaffUser(
  deps: AppDeps,
  input: { email: string; displayName: string; password: string; role: StaffRole }
): Promise<{ staffId: string; userId: string }> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 14 || input.password.length > 128) throw unprocessable('Use a password of 14 to 128 characters.', 'password_length');
  const existing = await deps.db.selectFrom('authUsers').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) throw conflict('A staff account with this email already exists.', 'staff_exists');
  const ctx = await deps.auth.$context;
  const user = await ctx.internalAdapter.createUser({ email, name: input.displayName, emailVerified: true }, { method: 'admin' });
  const hash = await ctx.password.hash(input.password);
  await ctx.internalAdapter.createAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hash });
  const staff = await deps.db
    .insertInto('staffMembers')
    .values({ userId: user.id, email, displayName: input.displayName, role: input.role })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { staffId: staff.id, userId: user.id };
}

export async function inviteStaff(deps: AppDeps, meta: RequestMeta, input: { email: string; displayName: string; role: StaffRole }) {
  const email = input.email.trim().toLowerCase();
  const token = randomToken();
  const now = deps.clock.now();
  const result = await deps.db.transaction().execute(async trx => {
    const user = await trx.selectFrom('staffMembers').select('id').where('email', '=', email).executeTakeFirst();
    if (user) throw conflict('This person already has a staff account.', 'staff_exists');
    await trx
      .updateTable('staffInvitations')
      .set({ revokedAt: now.toISOString(), revokedBy: meta.actor.type === 'staff' ? meta.actor.staffId : null })
      .where('email', '=', email)
      .where('acceptedAt', 'is', null)
      .where('revokedAt', 'is', null)
      .execute();
    const invitation = await trx
      .insertInto('staffInvitations')
      .values({
        email,
        displayName: input.displayName,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: meta.actor.type === 'staff' ? meta.actor.staffId : null,
        expiresAt: new Date(now.getTime() + 7 * DAY).toISOString()
      })
      .returning(['id', 'email', 'displayName', 'role', 'expiresAt', 'createdAt'])
      .executeTakeFirstOrThrow();
    const link = `${deps.config.STAFF_APP_URL.replace(/\/$/, '')}/accept-invitation?token=${encodeURIComponent(token)}`;
    const delivery = await createDelivery(trx, {
      idempotencyKey: `staff_invitation:${invitation.id}`,
      templateKey: 'staff.invitation',
      category: 'security',
      recipient: { type: 'staff', id: null, email },
      variables: { 'staff.displayName': input.displayName, 'links.acceptInvitation': link, 'agency.name': 'Auren Households', 'invitation.role': input.role.replace('_', ' ') },
      logCommunication: false,
      now
    });
    await audit(trx, meta, { action: 'staff.invited', subjectType: 'staff_invitation', subjectId: invitation.id, metadata: { role: input.role } });
    return { invitation, deliveryId: delivery.id };
  });
  await dispatchDeliveries(deps, { ids: [result.deliveryId] }).catch(error => deps.log.warn({ err: error }, 'Invitation email will be retried'));
  return result.invitation;
}

export async function findInvitation(db: Executor, token: string, now: Date) {
  const invitation = await db
    .selectFrom('staffInvitations')
    .select(['id', 'email', 'displayName', 'role', 'expiresAt', 'acceptedAt', 'revokedAt'])
    .where('tokenHash', '=', hashToken(token))
    .executeTakeFirst();
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || new Date(invitation.expiresAt) < now) return null;
  return invitation;
}

export async function acceptInvitation(deps: AppDeps, input: { token: string; password: string; displayName?: string }) {
  const invitation = await findInvitation(deps.db, input.token, deps.clock.now());
  if (!invitation) throw unprocessable('This invitation is invalid or has expired. Ask the owner for a new one.', 'invitation_invalid');
  // Mark accepted first so a concurrent second accept cannot create two accounts.
  const claimed = await deps.db
    .updateTable('staffInvitations')
    .set({ acceptedAt: deps.clock.now().toISOString() })
    .where('id', '=', invitation.id)
    .where('acceptedAt', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!claimed) throw unprocessable('This invitation has already been used.', 'invitation_invalid');
  try {
    const created = await createStaffUser(deps, {
      email: invitation.email,
      displayName: input.displayName?.trim() || invitation.displayName,
      password: input.password,
      role: invitation.role as StaffRole
    });
    await deps.db.updateTable('staffInvitations').set({ acceptedStaffId: created.staffId }).where('id', '=', invitation.id).execute();
    await audit(deps.db, { actor: { type: 'public' }, requestId: 'invitation', now: deps.clock.now() }, {
      action: 'staff.invitation_accepted',
      subjectType: 'staff_member',
      subjectId: created.staffId,
      metadata: { role: invitation.role }
    });
    return created;
  } catch (error) {
    await deps.db.updateTable('staffInvitations').set({ acceptedAt: null }).where('id', '=', invitation.id).execute();
    throw error;
  }
}

/** Role/status/name changes. The last active owner can never be demoted or suspended. */
export async function updateStaffMember(
  deps: AppDeps,
  meta: RequestMeta,
  id: string,
  input: { version: number; role?: StaffRole; status?: 'active' | 'suspended'; displayName?: string }
) {
  return deps.db.transaction().execute(async trx => {
    const current = await trx.selectFrom('staffMembers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw notFound('Staff member');
    if (current.version !== input.version) throw versionConflict(current.version);
    const losingOwner = current.role === 'owner' && current.status === 'active' && ((input.role && input.role !== 'owner') || input.status === 'suspended');
    if (losingOwner) {
      const owners = await trx.selectFrom('staffMembers').select('id').where('role', '=', 'owner').where('status', '=', 'active').forUpdate().execute();
      if (owners.length <= 1) throw conflict('The agency must keep at least one active owner.', 'last_owner');
    }
    const updated = await trx
      .updateTable('staffMembers')
      .set({
        ...(input.role ? { role: input.role } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.status === 'suspended' ? { suspendedAt: deps.clock.now().toISOString(), suspendedBy: meta.actor.type === 'staff' ? meta.actor.staffId : null } : {}),
        ...(input.status === 'active' ? { suspendedAt: null, suspendedBy: null } : {}),
        version: current.version + 1
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (input.status === 'suspended') await trx.deleteFrom('authSessions').where('userId', '=', current.userId).execute();
    await audit(trx, meta, {
      action: 'staff.updated',
      subjectType: 'staff_member',
      subjectId: id,
      metadata: { fromRole: current.role, toRole: updated.role, fromStatus: current.status, toStatus: updated.status }
    });
    return updated;
  });
}
