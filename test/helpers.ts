import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { closeDeps, createDeps } from '../src/deps.js';
import type { AppDeps } from '../src/context.js';
import { ManualClock } from '../src/lib/time.js';
import { MemoryEmailProvider } from '../src/providers/email.js';
import { MemoryStorageProvider } from '../src/providers/storage.js';
import { DevAllowScanner, type MalwareScanner } from '../src/providers/scanner.js';
import { createStaffUser } from '../src/modules/staff/service.js';
import type { StaffRole } from '../src/auth/permissions.js';

export const ORIGIN = 'http://app.test';
export const START = new Date('2026-10-22T16:00:00.000Z'); // Thursday 10:00 in Denver

export interface TestContext {
  app: FastifyInstance;
  deps: AppDeps;
  clock: ManualClock;
  email: MemoryEmailProvider;
  storage: MemoryStorageProvider;
  databaseUrl: string;
  close(): Promise<void>;
}

/** A fresh database cloned from the migrated template, plus an app wired to test doubles. */
export async function createTestContext(options: { scanner?: MalwareScanner; env?: Record<string, string>; email?: MemoryEmailProvider } = {}): Promise<TestContext> {
  const port = inject('pgPort');
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const admin = new pg.Client(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE auren_template`);
  await admin.end();
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/${name}`;
  const config = parseConfig({
    APP_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '6',
    AUTH_SECRET: 'test-auth-secret-0123456789abcdefghijklmnop',
    SIGNING_SECRET: 'test-signing-secret-0123456789abcdefghijkl',
    CRON_SECRET: 'test-cron-secret-0123456789abcd',
    API_PUBLIC_URL: 'http://api.test',
    PUBLIC_SITE_URL: ORIGIN,
    STAFF_APP_URL: `${ORIGIN}/studio`,
    APP_ORIGINS: ORIGIN,
    EMAIL_PROVIDER: 'memory',
    STORAGE_PROVIDER: 'memory',
    SCANNER_PROVIDER: 'dev-allow',
    RATE_LIMIT_SCALE: '100',
    LOG_LEVEL: process.env.TEST_LOG === '1' ? 'error' : 'silent',
    ...options.env
  });
  const clock = new ManualClock(START);
  const email = options.email ?? new MemoryEmailProvider();
  const storage = new MemoryStorageProvider();
  const deps = createDeps(config, {
    clock,
    email,
    privateStorage: storage,
    publicStorage: new MemoryStorageProvider(),
    scanner: options.scanner ?? new DevAllowScanner(),
    log: { debug() {}, info() {}, warn() {}, error() {} }
  });
  const app = await buildApp(deps, { logger: process.env.TEST_LOG === '1' });
  return {
    app,
    deps,
    clock,
    email,
    storage,
    databaseUrl,
    async close() {
      await app.close();
      await closeDeps(deps);
      const cleanup = new pg.Client(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    }
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

/** HTTP client over app.inject that keeps cookies, like a browser on the frontend origin. */
export class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly app: FastifyInstance, private readonly origin = ORIGIN) {}

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await this.app.inject({
      method: method as 'GET',
      url: path.startsWith('/api/') ? path : `/api/v1${path}`,
      headers: {
        origin: this.origin,
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      ...(body !== undefined ? { payload: body instanceof Buffer ? body : JSON.stringify(body) } : {})
    });
    const setCookie = response.headers['set-cookie'];
    for (const raw of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair, ...attributes] = raw.split(';');
      const [key, ...value] = pair!.split('=');
      const expired = attributes.some(attribute => /max-age=0/i.test(attribute.trim()));
      if (expired || value.join('=') === '') this.cookies.delete(key!.trim());
      else this.cookies.set(key!.trim(), value.join('='));
    }
    let parsed: unknown = response.body;
    if ((response.headers['content-type'] ?? '').toString().includes('application/json') && response.body) parsed = JSON.parse(response.body);
    return { status: response.statusCode, body: parsed as T, headers: response.headers as ApiResponse['headers'] };
  }
  get = <T = any>(path: string, headers?: Record<string, string>) => this.request<T>('GET', path, undefined, headers);
  post = <T = any>(path: string, body: unknown = {}, headers?: Record<string, string>) => this.request<T>('POST', path, body, headers);
  patch = <T = any>(path: string, body: unknown, headers?: Record<string, string>) => this.request<T>('PATCH', path, body, headers);
  put = <T = any>(path: string, body: unknown, headers?: Record<string, string>) => this.request<T>('PUT', path, body, headers);
  delete = <T = any>(path: string, headers?: Record<string, string>) => this.request<T>('DELETE', path, undefined, headers);
  cookie(name: string) {
    return this.cookies.get(name);
  }
  clearCookies() {
    this.cookies.clear();
  }
}

let counter = 0;
/** Creates a staff account with the role and returns a signed-in client. */
export async function signedIn(ctx: TestContext, role: StaffRole = 'owner', name?: string) {
  const email = `${role}.${++counter}.${randomUUID().slice(0, 6)}@example.invalid`;
  const password = 'correct-horse-battery-staple';
  const { staffId } = await createStaffUser(ctx.deps, { email, displayName: name ?? `${role} user`, password, role });
  const client = new Client(ctx.app);
  const response = await client.post('/auth/sign-in', { email, password });
  if (response.status !== 200 || response.body.status !== 'signed_in') throw new Error(`Sign-in failed: ${JSON.stringify(response.body)}`);
  return { client, staffId, email, password };
}

export function expectOk<T>(response: ApiResponse<T>, status = 200): T {
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}

/** Activates the seeded draft screening policy (owner decision in production). */
export async function activateSeedPolicy(ctx: TestContext) {
  await ctx.deps.db.updateTable('screeningPolicies').set({ status: 'active', publishedAt: new Date().toISOString() }).where('versionNumber', '=', 1).execute();
}

export const uuid = () => randomUUID();
