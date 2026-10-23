import { sql, type SelectQueryBuilder } from 'kysely';
import type { DB } from '../db/schema.js';
import type { Executor } from '../db/index.js';
import type { StaffActor } from '../context.js';
import { forbidden, notFound, versionConflict } from '../http/errors.js';
import { getSettings } from './settings.js';
import { makeReference } from '../lib/crypto.js';

type VersionedTable = {
  [K in keyof DB]: DB[K] extends { id: unknown; version: unknown } ? K : never;
}[keyof DB];

/**
 * Optimistic concurrency: updates only if the caller's version matches, then increments it.
 * A stale version returns 409 version_conflict with the current version.
 */
export async function updateVersioned<T extends VersionedTable>(
  db: Executor,
  table: T,
  id: string,
  version: number,
  values: Record<string, unknown>,
  what = 'Record'
) {
  const updated = await (db as Executor)
    .updateTable(table as 'families')
    .set({ ...(values as object), version: sql`version + 1` } as never)
    .where('id', '=', id)
    .where('version', '=', version)
    .returningAll()
    .executeTakeFirst();
  if (updated) return updated as unknown as DB[T] extends infer R ? { [K in keyof R]: unknown } & Record<string, unknown> : never;
  const current = await (db as Executor).selectFrom(table as 'families').select('version').where('id', '=', id).executeTakeFirst();
  if (!current) throw notFound(what);
  throw versionConflict(current.version);
}

/** Serializes JSON columns for insert/update. */
export const json = (value: unknown) => JSON.stringify(value ?? null);

/** Generates a unique human reference, retrying on the rare collision. */
export async function uniqueReference(db: Executor, table: 'families' | 'enquiries' | 'candidates' | 'applications' | 'jobOrders' | 'placements' | 'presentations', prefix: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = makeReference(prefix);
    const clash = await db.selectFrom(table).select('id').where('reference', '=', reference).executeTakeFirst();
    if (!clash) return reference;
  }
  throw new Error('Could not allocate a unique reference');
}

/**
 * Record scoping for coordinators. With the agency setting coordinator_scope = 'assigned',
 * coordinators see only records assigned to them (or unassigned); owners always see everything.
 */
export async function assignedOnly(db: Executor, staff: StaffActor): Promise<boolean> {
  if (staff.role !== 'coordinator') return false;
  return (await getSettings(db)).coordinatorScope === 'assigned';
}

export function applyAssignedScope<QB extends SelectQueryBuilder<DB, keyof DB, object>>(
  query: QB,
  column: string,
  staffId: string,
  enabled: boolean
): QB {
  if (!enabled) return query;
  return query.where(sql<boolean>`(${sql.ref(column)} = ${staffId} or ${sql.ref(column)} is null)`) as QB;
}

export async function assertInScope(db: Executor, staff: StaffActor, assignedStaffId: string | null | undefined) {
  if (!(await assignedOnly(db, staff))) return;
  if (assignedStaffId && assignedStaffId !== staff.staffId) throw forbidden('This record is assigned to another coordinator.', 'out_of_scope');
}

/** Escapes LIKE wildcards in user search input. */
export const likeEscape = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export const pageArgs = (page: number, pageSize: number) => ({ limit: pageSize, offset: (page - 1) * pageSize });
