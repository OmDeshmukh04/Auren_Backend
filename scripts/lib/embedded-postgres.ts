import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * A real PostgreSQL server (official binaries, no Docker) for local development and tests.
 * Staging and production use a managed Postgres (Neon) through DATABASE_URL instead.
 */
export interface LocalPostgres {
  url(database: string): string;
  createDatabase(name: string, template?: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startLocalPostgres(options: { dataDir: string; port: number; fresh?: boolean; log?: boolean }): Promise<LocalPostgres> {
  const dataDir = resolve(options.dataDir);
  if (options.fresh) await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: options.port,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'timezone=UTC', '-c', 'max_connections=200', '-c', 'fsync=off'],
    onLog: options.log ? message => process.stdout.write(`[postgres] ${message}`) : () => {},
    onError: options.log ? message => process.stderr.write(`[postgres] ${String(message)}\n`) : () => {}
  });
  if (!existsSync(resolve(dataDir, 'PG_VERSION'))) await server.initialise();
  await server.start();
  const admin = server.getPgClient();
  await admin.connect();
  const quote = (name: string) => {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe database name ${name}`);
    return `"${name}"`;
  };
  return {
    url: database => `postgres://postgres:postgres@127.0.0.1:${options.port}/${database}`,
    async createDatabase(name, template) {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (exists.rowCount) return;
      await admin.query(`CREATE DATABASE ${quote(name)}${template ? ` TEMPLATE ${quote(template)}` : ''}`);
    },
    async dropDatabase(name) {
      await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
    },
    async stop() {
      await admin.end().catch(() => {});
      await server.stop();
    }
  };
}
