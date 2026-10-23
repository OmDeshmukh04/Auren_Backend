import type pg from 'pg';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import type { Clock } from './lib/time.js';
import type { Permission, StaffRole } from './auth/permissions.js';
import type { StaffAuth } from './auth/staff-auth.js';
import type { EmailProvider } from './providers/email.js';
import type { StorageProvider } from './providers/storage.js';
import type { MalwareScanner } from './providers/scanner.js';
import type { CaptchaVerifier } from './providers/captcha.js';

export interface Logger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/** Long-lived dependencies shared by the API, the runner and tests. */
export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  db: Database;
  clock: Clock;
  log: Logger;
  auth: StaffAuth;
  email: EmailProvider;
  /** Private bucket: applicant documents, generated PDFs and exports. */
  privateStorage: StorageProvider;
  /** Public bucket: licensed website media only. */
  publicStorage: StorageProvider;
  scanner: MalwareScanner;
  captcha: CaptchaVerifier;
}

export interface StaffActor {
  type: 'staff';
  staffId: string;
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  role: StaffRole;
  permissions: ReadonlySet<Permission>;
  mfaEnabled: boolean;
}

export interface ApplicantActor {
  type: 'applicant';
  draftId: string;
  sessionTokenId: string;
}

export interface PublicActor {
  type: 'public';
}

export interface SystemActor {
  type: 'system';
  component: string;
}

export type Actor = StaffActor | ApplicantActor | PublicActor | SystemActor;

/** Who is acting and on which request; passed to every domain service. */
export interface RequestMeta {
  actor: Actor;
  requestId: string;
  ipHash?: string;
  /** The request's single notion of "now" (from the app clock), used for every timestamp it writes. */
  now: Date;
}

export const systemMeta = (component: string, now: Date, requestId = `system:${component}`): RequestMeta => ({
  actor: { type: 'system', component },
  requestId,
  now
});

export function actorStaffId(meta: RequestMeta): string | null {
  return meta.actor.type === 'staff' ? meta.actor.staffId : null;
}

export function actorType(meta: RequestMeta): 'staff' | 'applicant' | 'public' | 'system' {
  return meta.actor.type;
}
