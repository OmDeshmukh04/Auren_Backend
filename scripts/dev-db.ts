import { existsSync } from 'node:fs';
import { startLocalPostgres } from './lib/embedded-postgres.js';

/** Runs only the local PostgreSQL server in the foreground (for tools such as db:codegen). */
if (existsSync('.env')) process.loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:54330/auren_dev');
const database = url.pathname.slice(1) || 'auren_dev';
const local = await startLocalPostgres({ dataDir: '.data/postgres', port: Number(url.port || 54330) });
await local.createDatabase(database);
console.log(`Local PostgreSQL running: ${local.url(database)}`);
console.log('Press Ctrl+C to stop.');

const stop = async () => {
  await local.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
