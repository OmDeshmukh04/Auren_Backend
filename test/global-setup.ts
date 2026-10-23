import type { TestProject } from 'vitest/node';
import { createPool } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { startLocalPostgres, type LocalPostgres } from '../scripts/lib/embedded-postgres.js';

/**
 * One real PostgreSQL server for the whole run. Migrations are applied once to a template
 * database; every test file clones its own database from it, so files run in parallel.
 */
let server: LocalPostgres | undefined;
export const TEST_PG_PORT = 54340;

export default async function setup(project: TestProject) {
  server = await startLocalPostgres({ dataDir: '.test-data/postgres', port: TEST_PG_PORT, fresh: true });
  await server.createDatabase('auren_template');
  const pool = createPool({ connectionString: server.url('auren_template'), max: 2 });
  await migrate(pool);
  await pool.end();
  project.provide('pgPort', TEST_PG_PORT);
  return async () => {
    await server?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgPort: number;
  }
}
