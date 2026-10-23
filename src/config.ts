import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration. Every value the service reads from the environment is declared
 * and validated here; nothing else reads process.env directly.
 */

const list = z
  .string()
  .default('')
  .transform(value => value.split(',').map(item => item.trim()).filter(Boolean));

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform(value => (value === undefined ? fallback : value === 'true' || value === '1'));

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(5181),
  TRUST_PROXY: bool(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: bool(false),

  /** Secret used by the staff authentication library to sign cookies and tokens. */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  /** Secret used to sign short-lived content preview and download tokens. */
  SIGNING_SECRET: z.string().min(32, 'SIGNING_SECRET must be at least 32 characters'),

  /** Public origin of this API, e.g. https://api.aurenhouseholds.com */
  API_PUBLIC_URL: z.url().default('http://127.0.0.1:5181'),
  /** Public website origin, used to build applicant links in email. */
  PUBLIC_SITE_URL: z.url().default('http://127.0.0.1:5180'),
  /** Staff workspace origin, used to build staff links in email. */
  STAFF_APP_URL: z.url().default('http://127.0.0.1:5180/studio'),
  /** Exact browser origins allowed to call the API with credentials. */
  APP_ORIGINS: list,
  /** Cookie domain when the frontend and API share a parent domain (e.g. .aurenhouseholds.com). */
  COOKIE_DOMAIN: z.string().optional(),

  EMAIL_PROVIDER: z.enum(['resend', 'log', 'memory']).default('log'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().default('Auren Households <no-reply@example.invalid>'),
  EMAIL_REPLY_TO: z.string().optional(),
  /** Outside production, only these addresses or @domains receive real email. */
  EMAIL_ALLOWLIST: list,

  STORAGE_PROVIDER: z.enum(['s3', 'local', 'memory']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_PRIVATE_BUCKET: z.string().optional(),
  S3_PUBLIC_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  PUBLIC_MEDIA_BASE_URL: z.string().optional(),

  SCANNER_PROVIDER: z.enum(['clamd', 'dev-allow', 'none']).default('none'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),

  /** Bearer secret for the scheduled runner endpoint (Vercel Cron sends it as Authorization). */
  CRON_SECRET: z.string().min(24).optional(),
  RUNNER_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  RUNNER_MAX_MS: z.coerce.number().int().positive().default(20_000),

  TURNSTILE_SECRET_KEY: z.string().optional(),
  /** Multiplies every rate limit. Tests raise it; must stay 1 when deployed. */
  RATE_LIMIT_SCALE: z.coerce.number().positive().max(1000).default(1),
  SEED_SYNTHETIC_DATA: bool(false)
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
  isDeployed: boolean;
  isTest: boolean;
};

function loadDotEnv() {
  if (process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging') return;
  const file = resolve(process.env.ENV_FILE || '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const value = result.data;
  const isProduction = value.APP_ENV === 'production';
  const isDeployed = isProduction || value.APP_ENV === 'staging';
  const problems: string[] = [];
  if (isDeployed) {
    if (value.EMAIL_PROVIDER !== 'resend') problems.push('EMAIL_PROVIDER must be "resend" in staging and production.');
    if (value.EMAIL_PROVIDER === 'resend' && !value.RESEND_API_KEY) problems.push('RESEND_API_KEY is required.');
    if (!value.RESEND_WEBHOOK_SECRET) problems.push('RESEND_WEBHOOK_SECRET is required to accept delivery webhooks.');
    if (value.STORAGE_PROVIDER !== 's3') problems.push('STORAGE_PROVIDER must be "s3" in staging and production.');
    if (value.SCANNER_PROVIDER === 'dev-allow') problems.push('SCANNER_PROVIDER "dev-allow" is for local development only.');
    if (!value.CRON_SECRET) problems.push('CRON_SECRET is required so the scheduled runner can authenticate.');
    if (value.APP_ORIGINS.length === 0) problems.push('APP_ORIGINS must list the exact frontend origins.');
    if (value.SEED_SYNTHETIC_DATA) problems.push('SEED_SYNTHETIC_DATA cannot be enabled in staging or production.');
    if (value.RATE_LIMIT_SCALE !== 1) problems.push('RATE_LIMIT_SCALE must be 1 in staging and production.');
  }
  if (isProduction && value.EMAIL_ALLOWLIST.length > 0) problems.push('EMAIL_ALLOWLIST must be empty in production.');
  if (value.STORAGE_PROVIDER === 's3' && (!value.S3_PRIVATE_BUCKET || !value.S3_ACCESS_KEY_ID || !value.S3_SECRET_ACCESS_KEY)) {
    problems.push('S3_PRIVATE_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for S3 storage.');
  }
  if (problems.length) throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  const origins = value.APP_ORIGINS.length
    ? value.APP_ORIGINS
    : [new URL(value.PUBLIC_SITE_URL).origin, new URL(value.STAFF_APP_URL).origin];
  return {
    ...value,
    APP_ORIGINS: [...new Set(origins)],
    isProduction,
    isDeployed,
    isTest: value.APP_ENV === 'test'
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (!cached) {
    loadDotEnv();
    cached = parseConfig(process.env);
  }
  return cached;
}

export function setConfigForTests(config: Config) {
  cached = config;
}
