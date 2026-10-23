const dateOf = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(0, 10);

export function isCalendarDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

/** Inclusive day count of a YYYY-MM-DD start/end pair; `bounded` limits both dates to 2000-01-01..2099-12-31. */
export function dateRangeDays(start: string, end: string, maxDays: number, bounded = false): number {
  for (const date of [start, end]) {
    if (!isCalendarDate(date) || (bounded && (date < "2000-01-01" || date > "2099-12-31"))) {
      throw new RangeError("date must be a real calendar date in YYYY-MM-DD format");
    }
  }
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
  if (days < 1 || days > maxDays) throw new RangeError(`range must contain 1 to ${String(maxDays)} dates`);
  return days;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

/** A sleep session belongs to the local date it ends on (R5). */
export const sleepLocalDate = (endTs: number, tzOffsetMin: number): string => dateOf(endTs + tzOffsetMin * 60);
