import { existsSync } from 'node:fs';
import { createPool } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

/** Release step: apply pending migrations to DATABASE_URL. */
if (existsSync('.env') && !['production', 'staging'].includes(process.env.APP_ENV ?? '')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL (run `npm run db:start` for a local database).');
  process.exit(1);
}
const pool = createPool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true', max: 1 });
try {
  const result = await migrate(pool, { log: line => console.log(line) });
  console.log(`Done: ${result.applied.length} applied, ${result.skipped.length} already current.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
