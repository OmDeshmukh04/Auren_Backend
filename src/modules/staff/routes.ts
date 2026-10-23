import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { Email, Id, IdParams, Ok, Timestamp, Version } from '../../http/schemas.js';
import { notFound } from '../../http/errors.js';
import { audit } from '../../domain/audit.js';
import { inviteStaff, updateStaffMember } from './service.js';

const Role = z.enum(['owner', 'coordinator', 'content_editor', 'finance_viewer']);

export const StaffMember = z
  .object({
    id: Id,
    email: z.string(),
    displayName: z.string(),
    role: Role,
    status: z.enum(['active', 'suspended']),
    timezone: z.string(),
    lastSignInAt: Timestamp.nullable(),
    mfaEnabled: z.boolean(),
    version: Version,
    createdAt: Timestamp
  })
  .meta({ id: 'StaffMember' });

const Invitation = z
  .object({ id: Id, email: z.string(), displayName: z.string(), role: Role, expiresAt: Timestamp, createdAt: Timestamp })
  .meta({ id: 'StaffInvitation' });

export const staffRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/staff',
    operationId: 'listStaff',
    summary: 'List staff members',
    tags: ['Staff'],
    access: { kind: 'staff', permission: 'staff.read' },
    response: z.object({ items: z.array(StaffMember) }),
    async handler({ deps }) {
      const rows = await deps.db
        .selectFrom('staffMembers as s')
        .innerJoin('authUsers as u', 'u.id', 's.userId')
        .select(['s.id', 's.email', 's.displayName', 's.role', 's.status', 's.timezone', 's.lastSignInAt', 's.version', 's.createdAt', 'u.twoFactorEnabled'])
        .orderBy('s.displayName')
        .execute();
      return { items: rows.map(row => ({ ...row, role: row.role as z.infer<typeof Role>, status: row.status as 'active', mfaEnabled: Boolean(row.twoFactorEnabled) })) };
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/staff/:id',
    operationId: 'updateStaffMember',
    summary: 'Change a staff member role, name or status',
    description: 'Suspending revokes all sessions. The last active owner cannot be demoted or suspended (409 last_owner).',
    tags: ['Staff'],
    access: { kind: 'staff', permission: 'staff.manage' },
    params: IdParams,
    body: z.object({ version: Version, role: Role.optional(), status: z.enum(['active', 'suspended']).optional(), displayName: z.string().trim().min(1).max(120).optional() }),
    response: z.object({ id: Id, role: Role, status: z.enum(['active', 'suspended']), displayName: z.string(), version: Version }),
    async handler({ deps, meta, params, body }) {
      const updated = await updateStaffMember(deps, meta, params.id, body);
      return { ...updated, role: updated.role as z.infer<typeof Role>, status: updated.status as 'active' };
    }
  }),
  defineRoute({
    method: 'PATCH',
    path: '/me',
    operationId: 'updateMyProfile',
    summary: 'Update my display name, timezone or notification preferences',
    tags: ['Staff'],
    access: { kind: 'staff', permission: null, allowWithoutMfa: true },
    body: z.object({
      displayName: z.string().trim().min(1).max(120).optional(),
      timezone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_/]+$/).optional(),
      notificationPreferences: z.object({ dailyDigest: z.boolean().optional(), taskAssigned: z.boolean().optional() }).optional()
    }),
    response: Ok,
    async handler({ deps, staff, body }) {
      const current = await deps.db.selectFrom('staffMembers').select(['notificationPreferences']).where('id', '=', staff.staffId).executeTakeFirstOrThrow();
      await deps.db
        .updateTable('staffMembers')
        .set({
          ...(body.displayName ? { displayName: body.displayName } : {}),
          ...(body.timezone ? { timezone: body.timezone } : {}),
          ...(body.notificationPreferences
            ? { notificationPreferences: JSON.stringify({ ...(current.notificationPreferences as object), ...body.notificationPreferences }) }
            : {})
        })
        .where('id', '=', staff.staffId)
        .execute();
      return { ok: true as const };
    }
  }),
  defineRoute({
    method: 'GET',
    path: '/staff/invitations',
    operationId: 'listStaffInvitations',
    summary: 'List open staff invitations',
    tags: ['Staff'],
    access: { kind: 'staff', permission: 'staff.manage' },
    response: z.object({ items: z.array(Invitation) }),
    async handler({ deps }) {
      const items = await deps.db
        .selectFrom('staffInvitations')
        .select(['id', 'email', 'displayName', 'role', 'expiresAt', 'createdAt'])
        .where('acceptedAt', 'is', null)
        .where('revokedAt', 'is', null)
        .where('expiresAt', '>', deps.clock.now().toISOString())
        .orderBy('createdAt', 'desc')
        .execute();
      return { items: items.map(item => ({ ...item, role: item.role as z.infer<typeof Role> })) };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/staff/invitations',
    operationId: 'inviteStaff',
    summary: 'Invite a staff member by email',
    description: 'Emails a 7-day link to STAFF_APP_URL/accept-invitation?token=... Re-inviting the same email replaces the earlier invitation.',
    tags: ['Staff'],
    access: { kind: 'staff', permission: 'staff.manage' },
    body: z.object({ email: Email, displayName: z.string().trim().min(1).max(120), role: Role }),
    response: Invitation,
    status: 201,
    async handler({ deps, meta, body }) {
      const invitation = await inviteStaff(deps, meta, body);
      return { ...invitation, role: invitation.role as z.infer<typeof Role> };
    }
  }),
  defineRoute({
    method: 'POST',
    path: '/staff/invitations/:id/revoke',
    operationId: 'revokeStaffInvitation',
    summary: 'Revoke an open invitation',
    tags: ['Staff'],
    access: { kind: 'staff', permission: 'staff.manage' },
    params: IdParams,
    response: Ok,
    async handler({ deps, meta, params, staff }) {
      const result = await deps.db
        .updateTable('staffInvitations')
        .set({ revokedAt: deps.clock.now().toISOString(), revokedBy: staff.staffId })
        .where('id', '=', params.id)
        .where('acceptedAt', 'is', null)
        .where('revokedAt', 'is', null)
        .executeTakeFirst();
      if (!result.numUpdatedRows) throw notFound('Open invitation');
      await audit(deps.db, meta, { action: 'staff.invitation_revoked', subjectType: 'staff_invitation', subjectId: params.id });
      return { ok: true as const };
    }
  })
];
