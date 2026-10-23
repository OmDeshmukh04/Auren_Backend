import { getMigrations } from 'better-auth/db/migration';
import { staffAuthOptions } from '../src/auth/staff-auth.js';
import { parseConfig } from '../src/config.js';
import { createPool } from '../src/db/index.js';
import { startLocalPostgres } from './lib/embedded-postgres.js';

/**
 * Prints the SQL Better Auth needs for the configured tables, compiled against an empty
 * database. Used to write migrations/0001_staff_auth.sql and to diff after a library upgrade.
 */
const local = await startLocalPostgres({ dataDir: '.data/auth-schema-pg', port: 54339, fresh: true });
try {
  await local.createDatabase('auth_schema');
  const pool = createPool({ connectionString: local.url('auth_schema') });
  const config = parseConfig({
    APP_ENV: 'development',
    DATABASE_URL: local.url('auth_schema'),
    AUTH_SECRET: 'x'.repeat(32),
    SIGNING_SECRET: 'y'.repeat(32)
  });
  const { compileMigrations } = await getMigrations(staffAuthOptions({ pool, config }) as never);
  process.stdout.write(`${await compileMigrations()}\n`);
  await pool.end();
} finally {
  await local.stop();
}
