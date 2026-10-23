import type pg from 'pg';
import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import type { Config } from '../config.js';

/**
 * Staff authentication uses Better Auth (a maintained library) for password hashing, database
 * sessions, password reset tokens and TOTP multi-factor authentication. Its HTTP router is not
 * mounted: our /api/v1/auth endpoints call its server API so the public contract, rate limits,
 * audit and staff-status checks stay under our control, and sign-up is impossible.
 */

export interface StaffAuthHooks {
  /** Queue a password reset email. Must not throw for unknown users (enumeration safety). */
  sendPasswordReset(input: { userId: string; email: string; token: string }): Promise<void>;
}

export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export function staffAuthOptions(input: { pool: pg.Pool; config: Config; hooks?: StaffAuthHooks }) {
  const { config } = input;
  const secure = new URL(config.API_PUBLIC_URL).protocol === 'https:';
  return {
    appName: 'Auren Households',
    baseURL: config.API_PUBLIC_URL,
    basePath: '/api/v1/auth/library',
    secret: config.AUTH_SECRET,
    database: input.pool,
    trustedOrigins: config.APP_ORIGINS,
    telemetry: { enabled: false },
    user: {
      modelName: 'auth_users',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false }
    },
    session: {
      modelName: 'auth_sessions',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id'
      },
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 60 * 30,
      freshAge: 60 * 15,
      cookieCache: { enabled: false }
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      },
      accountLinking: { enabled: false }
    },
    verification: {
      modelName: 'auth_verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' }
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: 14,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }: { user: { id: string; email: string }; url: string; token: string }) => {
        await input.hooks?.sendPasswordReset({ userId: user.id, email: user.email, token });
      }
    },
    // Request limits are enforced by our Postgres-backed limiter on the wrapping endpoints.
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: 'auren',
      useSecureCookies: secure,
      defaultCookieAttributes: { sameSite: 'lax' as const, httpOnly: true, secure, path: '/' },
      ...(config.COOKIE_DOMAIN ? { crossSubDomainCookies: { enabled: true, domain: config.COOKIE_DOMAIN } } : {}),
      ipAddress: { ipAddressHeaders: config.TRUST_PROXY ? ['x-forwarded-for'] : [] },
      database: { generateId: 'uuid' as const }
    },
    plugins: [
      twoFactor({
        issuer: 'Auren Households',
        twoFactorTable: 'auth_two_factors',
        skipVerificationOnEnable: false,
        twoFactorCookieMaxAge: 60 * 10,
        trustDeviceMaxAge: 60 * 60 * 24 * 30,
        backupCodeOptions: { amount: 10, length: 10 },
        schema: {
          user: { fields: { twoFactorEnabled: 'two_factor_enabled' } },
          twoFactor: {
            fields: {
              backupCodes: 'backup_codes',
              userId: 'user_id',
              failedVerificationCount: 'failed_verification_count',
              lockedUntil: 'locked_until'
            }
          }
        }
      })
    ]
  };
}

export function createStaffAuth(input: { pool: pg.Pool; config: Config; hooks?: StaffAuthHooks }) {
  return betterAuth(staffAuthOptions(input));
}

export type StaffAuth = ReturnType<typeof createStaffAuth>;
