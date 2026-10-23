import pino from 'pino';
import type { Config } from './config.js';
import type { AppDeps, Logger } from './context.js';
import { createDatabase, createPool } from './db/index.js';
import { createStaffAuth } from './auth/staff-auth.js';
import { systemClock, type Clock } from './lib/time.js';
import { LogEmailProvider, MemoryEmailProvider, ResendEmailProvider, type EmailProvider } from './providers/email.js';
import { LocalStorageProvider, MemoryStorageProvider, S3StorageProvider, type StorageProvider } from './providers/storage.js';
import { ClamdScanner, DevAllowScanner, NoScanner, type MalwareScanner } from './providers/scanner.js';
import { noCaptcha, TurnstileVerifier, type CaptchaVerifier } from './providers/captcha.js';
import { queuePasswordResetEmail } from './modules/auth/password-reset.js';

export interface DepsOverrides {
  clock?: Clock;
  email?: EmailProvider;
  privateStorage?: StorageProvider;
  publicStorage?: StorageProvider;
  scanner?: MalwareScanner;
  captcha?: CaptchaVerifier;
  log?: Logger;
}

export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.token'], remove: true }
  });
}

function emailProvider(config: Config): EmailProvider {
  switch (config.EMAIL_PROVIDER) {
    case 'resend':
      return new ResendEmailProvider(config.RESEND_API_KEY!, config.RESEND_WEBHOOK_SECRET);
    case 'memory':
      return new MemoryEmailProvider();
    default:
      return new LogEmailProvider();
  }
}

function storage(config: Config, kind: 'private' | 'public'): StorageProvider {
  if (config.STORAGE_PROVIDER === 's3') {
    const bucket = kind === 'private' ? config.S3_PRIVATE_BUCKET! : config.S3_PUBLIC_BUCKET;
    if (!bucket) return new MemoryStorageProvider();
    return new S3StorageProvider(
      bucket,
      { endpoint: config.S3_ENDPOINT, region: config.S3_REGION, accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
      kind === 'public' ? config.PUBLIC_MEDIA_BASE_URL : undefined
    );
  }
  if (config.STORAGE_PROVIDER === 'memory') return new MemoryStorageProvider();
  return new LocalStorageProvider(`${config.LOCAL_STORAGE_DIR}/${kind}`, kind === 'public' ? config.PUBLIC_MEDIA_BASE_URL : undefined);
}

function scanner(config: Config): MalwareScanner {
  if (config.SCANNER_PROVIDER === 'clamd') return new ClamdScanner(config.CLAMD_HOST, config.CLAMD_PORT);
  if (config.SCANNER_PROVIDER === 'dev-allow') return new DevAllowScanner();
  return new NoScanner();
}

export function createDeps(config: Config, overrides: DepsOverrides = {}): AppDeps {
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL
  });
  const db = createDatabase(pool);
  const deps = {
    config,
    pool,
    db,
    clock: overrides.clock ?? systemClock,
    log: overrides.log ?? createLogger(config),
    email: overrides.email ?? emailProvider(config),
    privateStorage: overrides.privateStorage ?? storage(config, 'private'),
    publicStorage: overrides.publicStorage ?? storage(config, 'public'),
    scanner: overrides.scanner ?? scanner(config),
    captcha: overrides.captcha ?? (config.TURNSTILE_SECRET_KEY ? new TurnstileVerifier(config.TURNSTILE_SECRET_KEY) : noCaptcha)
  } as AppDeps;
  deps.auth = createStaffAuth({
    pool,
    config,
    hooks: { sendPasswordReset: input => queuePasswordResetEmail(deps, input) }
  });
  return deps;
}

export async function closeDeps(deps: AppDeps) {
  await deps.db.destroy();
}
