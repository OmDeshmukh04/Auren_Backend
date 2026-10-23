import { DateTime } from 'luxon';

/**
 * Time handling. Instants are UTC ISO strings; business rules (business hours, quiet hours,
 * "today" for expiry checks) are evaluated in the agency timezone, America/Denver by default,
 * including daylight-saving transitions.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can move. */
export class ManualClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return new Date(this.current);
  }
  set(value: Date | string) {
    this.current = new Date(value);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Agency-local calendar date ("YYYY-MM-DD") for an instant. */
export function localDate(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toISODate()!;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export type BusinessHours = Partial<Record<Weekday, Array<[string, string]>>>;

export interface Calendar {
  timezone: string;
  businessHours: BusinessHours;
  holidays: string[];
  quietHours?: { start: string; end: string } | null;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function windowsFor(day: DateTime, calendar: Calendar): Array<[DateTime, DateTime]> {
  const iso = day.toISODate()!;
  if (calendar.holidays.includes(iso)) return [];
  const key = WEEKDAYS[day.weekday - 1]!;
  return (calendar.businessHours[key] ?? []).map(([start, end]) => [
    day.startOf('day').plus({ minutes: minutesOf(start) }),
    day.startOf('day').plus({ minutes: minutesOf(end) })
  ]);
}

/** The instant itself if inside business hours, otherwise the next business-hours opening. */
export function nextBusinessInstant(at: Date, calendar: Calendar): Date {
  let cursor = DateTime.fromJSDate(at, { zone: calendar.timezone });
  for (let i = 0; i < 400; i++) {
    for (const [start, end] of windowsFor(cursor, calendar)) {
      if (cursor < start) return start.toJSDate();
      if (cursor >= start && cursor < end) return cursor.toJSDate();
    }
    cursor = cursor.plus({ days: 1 }).startOf('day');
  }
  throw new Error('No business hours configured in the next 400 days.');
}

/** Adds whole business days in the agency calendar, keeping the local time of day. */
export function addBusinessDays(at: Date, days: number, calendar: Calendar): Date {
  let cursor = DateTime.fromJSDate(at, { zone: calendar.timezone });
  let remaining = days;
  while (remaining > 0) {
    cursor = cursor.plus({ days: 1 });
    if (windowsFor(cursor, calendar).length > 0) remaining--;
  }
  return cursor.toJSDate();
}

/** Adds a delay expressed in agency-local terms (days keep wall-clock time across DST). */
export function addDelay(at: Date, delay: { minutes?: number; hours?: number; days?: number; businessDays?: number }, calendar: Calendar): Date {
  let result = DateTime.fromJSDate(at, { zone: calendar.timezone });
  if (delay.days) result = result.plus({ days: delay.days });
  if (delay.hours) result = result.plus({ hours: delay.hours });
  if (delay.minutes) result = result.plus({ minutes: delay.minutes });
  let instant = result.toJSDate();
  if (delay.businessDays) instant = addBusinessDays(instant, delay.businessDays, calendar);
  return instant;
}

/** If the instant falls inside quiet hours, returns the end of quiet hours; otherwise the instant. */
export function outsideQuietHours(at: Date, calendar: Calendar): Date {
  if (!calendar.quietHours) return at;
  const local = DateTime.fromJSDate(at, { zone: calendar.timezone });
  const minute = local.hour * 60 + local.minute;
  const start = minutesOf(calendar.quietHours.start);
  const end = minutesOf(calendar.quietHours.end);
  const inQuiet = start > end ? minute >= start || minute < end : minute >= start && minute < end;
  if (!inQuiet) return at;
  let release = local.startOf('day').plus({ minutes: end });
  if (release <= local) release = release.plus({ days: 1 }).startOf('day').plus({ minutes: end });
  return release.toJSDate();
}

/** Local wall-clock time on a local date, as an instant (handles DST gaps by moving forward). */
export function localInstant(isoDate: string, hhmm: string, timezone: string): Date {
  const dt = DateTime.fromISO(`${isoDate}T${hhmm}`, { zone: timezone });
  return dt.toJSDate();
}

export const iso = (date: Date) => date.toISOString();
