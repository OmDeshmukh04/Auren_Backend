import { z } from 'zod';
import type { AppDeps } from '../../context.js';
import { defineRoute, type AnyRoute } from '../../http/route.js';
import { Email, Id, Ok, Timestamp } from '../../http/schemas.js';
import { forbidden, unauthorized } from '../../http/errors.js';
import { toFetchHeaders, resolveStaff } from '../../http/actors.js';
import { enforceRateLimit } from '../../http/security.js';
import { callAuth } from '../../auth/better-auth-call.js';
import { ROLE_PERMISSIONS, type StaffRole } from '../../auth/permissions.js';
import { getSettings } from '../../domain/settings.js';
import { audit } from '../../domain/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { acceptInvitation, findInvitation } from '../staff/service.js';

const StaffRoleSchema = z.enum(['owner', 'coordinator', 'content_editor', 'finance_viewer']).meta({ id: 'StaffRole' });

export const StaffMe = z
  .object({
    id: Id,
    userId: Id,
    email: z.string(),
    displayName: z.string(),
    role: StaffRoleSchema,
    timezone: z.string(),
    permissions: z.array(z.string()).meta({ description: 'Permissions granted by the role. The server enforces these; use them only to shape the UI.' })
  })
  .meta({ id: 'StaffMe' });

export const SessionState = z
  .object({
    authenticated: z.boolean(),
    staff: StaffMe.nullable(),
    mfa: z
      .object({
        enabled: z.boolean(),
        requiredByAgency: z.boolean(),
        enrollmentRequired: z.boolean().meta({ description: 'True when the agency requires MFA and this user has not enrolled; other staff routes return 403 mfa_enrollment_required until they do.' })
      })
      .nullable()
  })
  .meta({ id: 'SessionState' });

const SignInResponse = z
  .object({
    status: z.enum(['signed_in', 'two_factor_required']),
    session: SessionState.nullable(),
    twoFactorMethods: z.array(z.string())
  })
  .meta({ id: 'SignInResponse' });

const Password = z.string().min(14, 'Use at least 14 characters').max(128);

async function sessionStateFor(deps: AppDeps, userId: string | null, mfaEnabled: boolean) {
  if (!userId) return { authenticated: false, staff: null, mfa: null };
  const member = await deps.db.selectFrom('staffMembers').selectAll().where('userId', '=', userId).executeTakeFirst();
  if (!member || member.status !== 'active') return { authenticated: false, staff: null, mfa: null };
  const settings = await getSettings(deps.db);
  return {
    authenticated: true,
    staff: {
      id: member.id,
      userId,
      email: member.email,
      displayName: member.displayName,
      role: member.role as StaffRole,
      timezone: member.timezone,
      permissions: [...ROLE_PERMISSIONS[member.role as StaffRole]]
    },
    mfa: { enabled: mfaEnabled, requiredByAgency: settings.requireStaffMfa, enrollmentRequired: settings.requireStaffMfa && !mfaEnabled }
  };
}

const AUTH_IP_LIMIT = { name: 'auth-ip', max: 30, windowSeconds: 15 * 60 };

export const authRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/auth/session',
    operationId: 'getSession',
    summary: 'Current staff session',
    description: 'Never returns 401: an anonymous caller receives authenticated=false.',
    tags: ['Auth'],
    access: { kind: 'public' },
    response: SessionState,
    async handler({ deps, req }) {
      const staff = await resolveStaff(deps, req).catch(() => null);
      return sessionStateFor(deps, staff?.userId ?? null, staff?.mfaEnabled ?? false);
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/sign-in',
    operationId: 'signIn',
    summary: 'Sign in with email and password',
    description:
      'Sets the HttpOnly staff session cookie. When the user has MFA enabled the response is `two_factor_required` and a short-lived ' +
      'challenge cookie is set instead; complete with POST /auth/two-factor/verify.',
    tags: ['Auth'],
    access: { kind: 'public' },
    body: z.object({ email: Email, password: z.string().min(1).max(128) }),
    response: SignInResponse,
    rateLimits: [AUTH_IP_LIMIT],
    async handler({ deps, req, reply, body, meta }) {
      await enforceRateLimit(deps, `auth-email:${sha256(body.email)}`, 10, 15 * 60);
      const result = await callAuth(reply, () =>
        deps.auth.api.signInEmail({ body: { email: body.email, password: body.password, rememberMe: false }, headers: toFetchHeaders(req.headers), returnHeaders: true })
      ) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[]; user?: { id: string } };
      if (result.twoFactorRedirect) return { status: 'two_factor_required' as const, session: null, twoFactorMethods: result.twoFactorMethods ?? ['totp'] };
      const state = await sessionStateFor(deps, result.user?.id ?? null, false);
      if (!state.authenticated) {
        // An auth user without an active staff profile cannot use the workspace.
        await deps.db.deleteFrom('authSessions').where('userId', '=', result.user!.id).execute();
        reply.header('set-cookie', []);
        throw unauthorized('Email or password is incorrect.', 'invalid_email_or_password');
      }
      await deps.db.updateTable('staffMembers').set({ lastSignInAt: deps.clock.now().toISOString() }).where('id', '=', state.staff!.id).execute();
      await audit(deps.db, { ...meta, actor: { type: 'system', component: 'auth' } }, { action: 'staff.signed_in', subjectType: 'staff_member', subjectId: state.staff!.id });
      return { status: 'signed_in' as const, session: state, twoFactorMethods: [] };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/two-factor/verify',
    operationId: 'verifyTwoFactor',
    summary: 'Complete sign-in with an authenticator or backup code',
    tags: ['Auth'],
    access: { kind: 'public' },
    body: z.object({
      method: z.enum(['totp', 'backup_code']).default('totp'),
      code: z.string().trim().min(6).max(32),
      trustDevice: z.boolean().default(false)
    }),
    response: SignInResponse,
    rateLimits: [{ name: 'auth-2fa', max: 10, windowSeconds: 15 * 60 }],
    async handler({ deps, req, reply, body, meta }) {
      const headers = toFetchHeaders(req.headers);
      const result = (await callAuth(reply, () =>
        body.method === 'backup_code'
          ? deps.auth.api.verifyBackupCode({ body: { code: body.code, trustDevice: body.trustDevice }, headers, returnHeaders: true })
          : deps.auth.api.verifyTOTP({ body: { code: body.code, trustDevice: body.trustDevice }, headers, returnHeaders: true })
      )) as { user?: { id: string } };
      const state = await sessionStateFor(deps, result.user?.id ?? null, true);
      if (!state.authenticated) throw unauthorized('Email or password is incorrect.', 'invalid_email_or_password');
      await deps.db.updateTable('staffMembers').set({ lastSignInAt: deps.clock.now().toISOString() }).where('id', '=', state.staff!.id).execute();
      await audit(deps.db, { ...meta, actor: { type: 'system', component: 'auth' } }, { action: 'staff.signed_in', subjectType: 'staff_member', subjectId: state.staff!.id, metadata: { mfa: body.method } });
      return { status: 'signed_in' as const, session: state, twoFactorMethods: [] };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/sign-out',
    operationId: 'signOut',
    summary: 'Sign out and revoke this session',
    tags: ['Auth'],
    access: { kind: 'staff', permission: null, allowWithoutMfa: true },
    response: Ok,
    async handler({ deps, req, reply }) {
      await callAuth(reply, () => deps.auth.api.signOut({ headers: toFetchHeaders(req.headers), returnHeaders: true }));
      return { ok: true as const };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/password/forgot',
    operationId: 'requestPasswordReset',
    summary: 'Email a password reset link',
    description: 'Always returns 202 whether or not the email belongs to a staff account. The link opens STAFF_APP_URL/reset-password?token=...',
    tags: ['Auth'],
    access: { kind: 'public' },
    body: z.object({ email: Email }),
    response: Ok,
    status: 202,
    rateLimits: [{ name: 'auth-reset', max: 5, windowSeconds: 60 * 60 }],
    async handler({ deps, body }) {
      await enforceRateLimit(deps, `auth-reset-email:${sha256(body.email)}`, 3, 60 * 60);
      await callAuth(null, () =>
        deps.auth.api.requestPasswordReset({ body: { email: body.email, redirectTo: `${deps.config.STAFF_APP_URL.replace(/\/$/, '')}/reset-password` } })
      ).catch(() => undefined);
      return { ok: true as const };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/password/reset',
    operationId: 'resetPassword',
    summary: 'Set a new password with a reset token',
    description: 'Revokes all existing sessions for the account.',
    tags: ['Auth'],
    access: { kind: 'public' },
    body: z.object({ token: z.string().min(10).max(500), newPassword: Password }),
    response: Ok,
    rateLimits: [{ name: 'auth-reset-confirm', max: 10, windowSeconds: 60 * 60 }],
    async handler({ deps, body }) {
      await callAuth(null, () => deps.auth.api.resetPassword({ body: { token: body.token, newPassword: body.newPassword } }));
      return { ok: true as const };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/password/change',
    operationId: 'changePassword',
    summary: 'Change password (signs out other sessions)',
    tags: ['Auth'],
    access: { kind: 'staff', permission: null, allowWithoutMfa: true },
    body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: Password }),
    response: Ok,
    rateLimits: [{ name: 'auth-change', max: 10, windowSeconds: 60 * 60 }],
    async handler({ deps, req, reply, body, meta, staff }) {
      await callAuth(reply, () =>
        deps.auth.api.changePassword({
          body: { currentPassword: body.currentPassword, newPassword: body.newPassword, revokeOtherSessions: true },
          headers: toFetchHeaders(req.headers),
          returnHeaders: true
        })
      );
      await audit(deps.db, meta, { action: 'staff.password_changed', subjectType: 'staff_member', subjectId: staff.staffId });
      return { ok: true as const };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/two-factor/enable',
    operationId: 'startTwoFactorEnrollment',
    summary: 'Start TOTP enrollment',
    description: 'Returns an otpauth:// URI (render as a QR code) and one-time backup codes. Enrollment completes after POST /auth/two-factor/confirm.',
    tags: ['Auth'],
    access: { kind: 'staff', permission: null, allowWithoutMfa: true },
    body: z.object({ password: z.string().min(1).max(128) }),
    response: z.object({ totpUri: z.string(), backupCodes: z.array(z.string()) }).meta({ id: 'TwoFactorEnrollment' }),
    rateLimits: [{ name: 'auth-2fa-enable', max: 10, windowSeconds: 60 * 60 }],
    async handler({ deps, req, reply, body }) {
      const result = (await callAuth(reply, () =>
        deps.auth.api.enableTwoFactor({ body: { password: body.password }, headers: toFetchHeaders(req.headers), returnHeaders: true })
      )) as { totpURI: string; backupCodes: string[] };
      return { totpUri: result.totpURI, backupCodes: result.backupCodes };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/two-factor/confirm',
    operationId: 'confirmTwoFactorEnrollment',
    summary: 'Confirm TOTP enrollment with a current code',
    tags: ['Auth'],
    access: { kind: 'staff', permission: null, allowWithoutMfa: true },
    body: z.object({ code: z.string().trim().min(6).max(10) }),
    response: SessionState,
    rateLimits: [{ name: 'auth-2fa-confirm', max: 10, windowSeconds: 15 * 60 }],
    async handler({ deps, req, reply, body, meta, staff }) {
      await callAuth(reply, () => deps.auth.api.verifyTOTP({ body: { code: body.code }, headers: toFetchHeaders(req.headers), returnHeaders: true }));
      await audit(deps.db, meta, { action: 'staff.mfa_enabled', subjectType: 'staff_member', subjectId: staff.staffId });
      return sessionStateFor(deps, staff.userId, true);
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/two-factor/disable',
    operationId: 'disableTwoFactor',
    summary: 'Turn off two-factor authentication',
    description: 'Refused (403 mfa_required_by_agency) while the agency requires MFA.',
    tags: ['Auth'],
    access: { kind: 'staff', permission: null, allowWithoutMfa: true },
    body: z.object({ password: z.string().min(1).max(128) }),
    response: Ok,
    async handler({ deps, req, reply, body, meta, staff }) {
      if ((await getSettings(deps.db)).requireStaffMfa) throw forbidden('The agency requires two-factor authentication.', 'mfa_required_by_agency');
      await callAuth(reply, () => deps.auth.api.disableTwoFactor({ body: { password: body.password }, headers: toFetchHeaders(req.headers), returnHeaders: true }));
      await audit(deps.db, meta, { action: 'staff.mfa_disabled', subjectType: 'staff_member', subjectId: staff.staffId });
      return { ok: true as const };
    }
  }),

  defineRoute({
    method: 'GET',
    path: '/auth/sessions',
    operationId: 'listMySessions',
    summary: 'List my active sessions',
    tags: ['Auth'],
    access: { kind: 'staff', permission: null, allowWithoutMfa: true },
    response: z.object({
      items: z.array(z.object({ id: Id, createdAt: Timestamp, expiresAt: Timestamp, ipAddress: z.string().nullable(), userAgent: z.string().nullable(), current: z.boolean() }))
    }),
    async handler({ deps, staff }) {
      const rows = await deps.db
        .selectFrom('authSessions')
        .select(['id', 'createdAt', 'expiresAt', 'ipAddress', 'userAgent'])
        .where('userId', '=', staff.userId)
        .where('expiresAt', '>', deps.clock.now().toISOString())
        .orderBy('createdAt', 'desc')
        .execute();
      return { items: rows.map(row => ({ ...row, current: row.id === staff.sessionId })) };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/sessions/revoke-others',
    operationId: 'revokeOtherSessions',
    summary: 'Sign out everywhere else',
    tags: ['Auth'],
    access: { kind: 'staff', permission: null, allowWithoutMfa: true },
    response: Ok,
    async handler({ deps, staff, meta }) {
      await deps.db.deleteFrom('authSessions').where('userId', '=', staff.userId).where('id', '<>', staff.sessionId).execute();
      await audit(deps.db, meta, { action: 'staff.sessions_revoked', subjectType: 'staff_member', subjectId: staff.staffId });
      return { ok: true as const };
    }
  }),

  defineRoute({
    method: 'GET',
    path: '/auth/invitations/:token',
    operationId: 'getInvitation',
    summary: 'Look up a staff invitation by its emailed token',
    tags: ['Auth'],
    access: { kind: 'public' },
    params: z.object({ token: z.string().min(10).max(200) }),
    response: z.object({ email: z.string(), displayName: z.string(), role: StaffRoleSchema, expiresAt: Timestamp }).meta({ id: 'InvitationPreview' }),
    rateLimits: [{ name: 'invitation-lookup', max: 30, windowSeconds: 15 * 60 }],
    async handler({ deps, params }) {
      const invitation = await findInvitation(deps.db, params.token, deps.clock.now());
      if (!invitation) throw unauthorized('This invitation is invalid or has expired.', 'invitation_invalid');
      return { email: invitation.email, displayName: invitation.displayName, role: invitation.role as StaffRole, expiresAt: invitation.expiresAt };
    }
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/invitations/accept',
    operationId: 'acceptInvitation',
    summary: 'Accept an invitation and set a password',
    description: 'Creates the staff account. Sign in afterwards with POST /auth/sign-in.',
    tags: ['Auth'],
    access: { kind: 'public' },
    body: z.object({ token: z.string().min(10).max(200), password: Password, displayName: z.string().trim().min(1).max(120).optional() }),
    response: Ok,
    status: 201,
    rateLimits: [{ name: 'invitation-accept', max: 10, windowSeconds: 60 * 60 }],
    async handler({ deps, body }) {
      await acceptInvitation(deps, body);
      return { ok: true as const };
    }
  })
];
