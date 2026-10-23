import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createPool } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { startLocalPostgres } from './lib/embedded-postgres.js';

/**
 * Regenerates src/db/schema.ts from the migrations: applies them to a fresh local PostgreSQL,
 * then introspects it with kysely-codegen. Run after adding a migration.
 */
const local = await startLocalPostgres({ dataDir: '.data/codegen-pg', port: 54338, fresh: true });
try {
  await local.createDatabase('codegen');
  const url = local.url('codegen');
  const pool = createPool({ connectionString: url, max: 2 });
  const result = await migrate(pool, { log: line => console.log(line) });
  await pool.end();
  console.log(`Applied ${result.applied.length} migrations.`);
  const bin = resolve('node_modules/kysely-codegen/dist/cli/bin.js');
  execFileSync(process.execPath, [
    bin,
    '--url', url,
    '--dialect', 'postgres',
    '--camel-case',
    '--numeric-parser', 'number',
    '--date-parser', 'string',
    '--type-mapping', JSON.stringify({ timestamptz: 'string', timestamp: 'string', date: 'string', int8: 'number' }),
    '--exclude-pattern', 'schema_migrations',
    '--out-file', 'src/db/schema.ts'
  ], { stdio: 'inherit' });
} finally {
  await local.stop();
}
