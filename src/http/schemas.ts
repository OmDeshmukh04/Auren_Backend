import { z } from 'zod';

/** Shared schema building blocks for the /api/v1 contract. */

export const Id = z.uuid().meta({ description: 'Record id (UUID).' });
export const Timestamp = z.iso.datetime().meta({ description: 'Instant, ISO-8601 UTC (e.g. 2026-10-22T17:06:49.184Z).' });
export const DateOnly = z.iso.date().meta({ description: 'Calendar date (YYYY-MM-DD) without time zone.' });
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/).meta({ description: 'ISO 4217 currency code.' });
export const Version = z.int().positive().meta({ description: 'Optimistic-concurrency version. Send back the version you read; a stale value returns 409 version_conflict.' });
export const Email = z.email().max(254).transform(value => value.trim().toLowerCase());
export const Phone = z.string().trim().min(7).max(40).regex(/^[0-9+().\-\s]+$/, 'Use digits and + ( ) - only');

export const Money = z
  .object({ amountMinor: z.int().min(0), currency: CurrencyCode })
  .meta({ id: 'Money', description: 'Money as integer minor units (cents) with currency. Never mixed across currencies.' });

export const CompensationPeriod = z.enum(['hour', 'day', 'week', 'month', 'year']);

export const CompensationRange = z
  .object({
    minMinor: z.int().min(0).nullable(),
    maxMinor: z.int().min(0).nullable(),
    currency: CurrencyCode,
    period: CompensationPeriod
  })
  .refine(v => v.minMinor === null || v.maxMinor === null || v.maxMinor >= v.minMinor, { message: 'Maximum must be at least the minimum', path: ['maxMinor'] })
  .meta({ id: 'CompensationRange', description: 'Compensation range in minor units for one period. Ranges with different periods are not compared.' });

export const AgeGroup = z.enum(['newborn', 'infant', 'toddler', 'preschool', 'school_age', 'teen']).meta({ id: 'AgeGroup' });
export const ChildAgeBand = z.enum(['expecting', 'newborn', 'infant', 'toddler', 'preschool', 'school_age', 'teen']).meta({ id: 'ChildAgeBand' });
export const ScheduleType = z
  .enum(['full_time', 'part_time', 'temporary', 'overnight', 'weekend', 'evening', 'date_night', 'travel', 'rotational'])
  .meta({ id: 'ScheduleType' });
export const Arrangement = z.enum(['live_in', 'live_out', 'either']).meta({ id: 'Arrangement' });
export const Provenance = z
  .enum(['self_reported', 'document_supplied', 'agency_verified'])
  .meta({ id: 'Provenance', description: 'Where a fact came from.' });

export const WeeklyWindow = z
  .object({
    dayOfWeek: z.int().min(1).max(7).meta({ description: 'ISO weekday, 1 = Monday ... 7 = Sunday' }),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).meta({ description: 'Local start time HH:MM' }),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/).meta({ description: 'Local end time HH:MM (24:00 allowed)' })
  })
  .refine(w => w.end > w.start, { message: 'End must be after start', path: ['end'] })
  .meta({ id: 'WeeklyWindow', description: 'A weekly availability or schedule window. Split overnight windows at midnight.' });

/** Query value that may be repeated (?a=1&a=2) or sent once. */
export function queryList<T extends z.ZodType>(item: T) {
  return z.union([item, z.array(item)]).transform(value => (Array.isArray(value) ? value : [value]) as z.output<T>[]);
}

export const queryBoolean = z.enum(['true', 'false']).transform(value => value === 'true');

export const PageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
};

export function pageOf<T extends z.ZodType>(item: T, id?: string) {
  const schema = z.object({
    items: z.array(item),
    page: z.int(),
    pageSize: z.int(),
    total: z.int()
  });
  return id ? schema.meta({ id }) : schema;
}

export const IdParams = z.object({ id: Id });

export const NoContent = z.null().meta({ description: 'No response body.' });
export const Ok = z.object({ ok: z.literal(true) }).meta({ id: 'Ok' });

export const StaffRef = z
  .object({ id: Id, displayName: z.string() })
  .nullable()
  .meta({ id: 'StaffRef', description: 'A staff member, or null.' });

export const minutesToHhmm = (minutes: number) =>
  minutes === 1440 ? '24:00' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const hhmmToMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Numeric fields from Postgres numeric columns arrive as numbers; keep nulls as null. */
export const num = (value: number | string | null | undefined) => (value === null || value === undefined ? null : Number(value));
