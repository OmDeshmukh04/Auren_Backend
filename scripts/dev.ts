import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createPool } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { startLocalPostgres, type LocalPostgres } from './lib/embedded-postgres.js';

/**
 * Local development: with LOCAL_POSTGRES=true (the default .env), starts a persistent local
 * PostgreSQL for DATABASE_URL's port, applies migrations, then runs the API with file watching.
 * Point DATABASE_URL at another server (e.g. a Neon dev branch) and unset LOCAL_POSTGRES to use it.
 */
if (existsSync('.env')) process.loadEnvFile('.env');

let local: LocalPostgres | undefined;
if (process.env.LOCAL_POSTGRES === 'true' || !process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:54330/auren_dev');
  const port = Number(url.port || 54330);
  const database = url.pathname.slice(1) || 'auren_dev';
  local = await startLocalPostgres({ dataDir: '.data/postgres', port });
  await local.createDatabase(database);
  process.env.DATABASE_URL = local.url(database);
  console.log(`Local PostgreSQL ready on port ${port} (data in .data/postgres)`);
}

const pool = createPool({ connectionString: process.env.DATABASE_URL! });
const result = await migrate(pool, { log: line => console.log(line) });
console.log(`Migrations: ${result.applied.length} applied, ${result.skipped.length} already current`);
await pool.end();

const child = spawn(process.execPath, ['--import', 'tsx', '--watch', 'src/server.ts'], {
  stdio: 'inherit',
  env: process.env
});

const shutdown = async () => {
  child.kill();
  if (local) await local.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', async code => {
  if (local) await local.stop();
  process.exit(code ?? 0);
});
