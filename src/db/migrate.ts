import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type pg from 'pg';

/**
 * Versioned SQL migrations. Files in /migrations run in name order, each inside its own
 * transaction, under an advisory lock so two deploys cannot migrate concurrently. An applied
 * file whose contents later change is refused: write a new migration instead of editing one.
 * The API never migrates on request; migrations run from a release step or `npm run db:migrate`.
 */

const LOCK_ID = 7_340_112_001;
export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map(name => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') };
    });
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: pg.Pool, options: { dir?: string; log?: (line: string) => void } = {}): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  const files = readMigrations(options.dir);
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const done = new Map(rows.map(row => [row.name, row.checksum]));
    for (const name of done.keys()) {
      if (!files.some(file => file.name === name)) throw new Error(`Migration ${name} is applied but missing from the repository.`);
    }
    for (const file of files) {
      const previous = done.get(file.name);
      if (previous) {
        if (previous !== file.checksum) throw new Error(`Migration ${file.name} changed after it was applied. Add a new migration instead.`);
        skipped.push(file.name);
        continue;
      }
      log(`Applying ${file.name}`);
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(file.name);
    }
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

/** Pending migrations, used by the health check to report a schema behind the code. */
export async function pendingMigrations(pool: pg.Pool, dir?: string): Promise<string[]> {
  const files = readMigrations(dir);
  const exists = await pool.query(`SELECT to_regclass('schema_migrations') AS t`);
  if (!exists.rows[0]?.t) return files.map(file => file.name);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(rows.map(row => row.name));
  return files.filter(file => !done.has(file.name)).map(file => file.name);
}
