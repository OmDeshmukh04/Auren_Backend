import pg from 'pg';
import { CamelCasePlugin, Kysely, PostgresDialect, type Transaction } from 'kysely';
import type { DB } from './schema.js';

/**
 * Type parsing is set once for the process so query results already match the JSON contract:
 * instants are ISO-8601 UTC strings, date-only values stay "YYYY-MM-DD", and integer money or
 * counts are numbers. Values beyond Number.MAX_SAFE_INTEGER are refused rather than rounded.
 */
const { types } = pg;
// Postgres sends "2026-10-22 17:06:49.184+00"; JavaScript needs "T" and a "+00:00" offset.
const toIsoInstant = (value: string) => new Date(value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();
types.setTypeParser(types.builtins.TIMESTAMPTZ, toIsoInstant);
types.setTypeParser(types.builtins.TIMESTAMP, value => toIsoInstant(`${value}Z`));
types.setTypeParser(types.builtins.DATE, value => value);
// date[] ("{2026-12-25,2027-01-01}") stays an array of "YYYY-MM-DD" strings.
types.setTypeParser(1182 as never, (value: string) => (value === '{}' ? [] : value.slice(1, -1).split(',')));
types.setTypeParser(types.builtins.NUMERIC, value => Number(value));
types.setTypeParser(types.builtins.INT8, value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Integer ${value} exceeds the safe range.`);
  return parsed;
});

export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Either the root database handle or an open transaction. */
export type Executor = Kysely<DB> | Transaction<DB>;

export interface DatabaseOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
  applicationName?: string;
}

export function createPool(options: DatabaseOptions) {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
    application_name: options.applicationName ?? 'auren-api',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000
  });
}

export function createDatabase(pool: pg.Pool): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    // Only top-level column names are converted; JSON document keys are stored exactly as sent.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })]
  });
}

/** Run `work` inside a transaction unless the executor already is one. */
export async function inTransaction<T>(db: Executor, work: (trx: Tx) => Promise<T>): Promise<T> {
  if (db.isTransaction) return work(db as Tx);
  return (db as Kysely<DB>).transaction().execute(work);
}
