import type { Executor } from '../db/index.js';
import type { BusinessHours, Calendar } from '../lib/time.js';

/**
 * Agency settings, cached briefly per process. Settings change rarely; a few seconds of
 * staleness is acceptable and avoids a query on every request. Writes call invalidate().
 */
const TTL_MS = 5_000;
const cache = new WeakMap<object, { at: number; value: AgencySettings }>();

export type AgencySettings = Awaited<ReturnType<typeof loadSettings>>;

async function loadSettings(db: Executor) {
  const row = await db.selectFrom('agencySettings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
  return {
    ...row,
    businessHours: row.businessHours as BusinessHours,
    quietHours: row.quietHours as { start: string; end: string } | null,
    branding: row.branding as Record<string, unknown>,
    seoDefaults: row.seoDefaults as Record<string, unknown>
  };
}

export async function getSettings(db: Executor, options: { fresh?: boolean } = {}): Promise<AgencySettings> {
  const hit = cache.get(db);
  if (!options.fresh && hit && Date.now() - hit.at < TTL_MS && !db.isTransaction) return hit.value;
  const value = await loadSettings(db);
  if (!db.isTransaction) cache.set(db, { at: Date.now(), value });
  return value;
}

export function invalidateSettings(db: object) {
  cache.delete(db);
}

export function calendarOf(settings: AgencySettings): Calendar {
  return {
    timezone: settings.timezone,
    businessHours: settings.businessHours,
    holidays: settings.holidays,
    quietHours: settings.quietHours
  };
}
