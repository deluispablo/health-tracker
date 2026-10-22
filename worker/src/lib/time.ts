const RFC3339_Z = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

const dateOf = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(0, 10);

export function isCalendarDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
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

/** Google physicalTime ("...Z") and utcOffset ("7200s") to epoch seconds, offset minutes and local date. */
export function fromGoogleTime(physicalTime: string, utcOffset: string): { ts: number; tzOffsetMin: number; localDate: string } {
  const m = RFC3339_Z.exec(physicalTime);
  if (!m) throw new TypeError(`bad physicalTime: ${physicalTime}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  // Date.UTC rolls impossible dates over (Feb 30), so compare the parts back.
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new TypeError(`bad physicalTime: ${physicalTime}`);
  }
  if (!/^-?\d+s$/.test(utcOffset) || parseInt(utcOffset, 10) % 60 !== 0) throw new TypeError(`bad utcOffset: ${utcOffset}`);
  const offset = parseInt(utcOffset, 10);
  const ts = ms / 1000;
  return { ts, tzOffsetMin: offset / 60, localDate: dateOf(ts + offset) };
}

/** A sleep session belongs to the local date it ends on (R5). */
export const sleepLocalDate = (endTs: number, tzOffsetMin: number): string => dateOf(endTs + tzOffsetMin * 60);

/** The night after behaviour on `localDate` is dated the next day. */
export const nightOf = (localDate: string): string => dateOf(Date.parse(`${localDate}T00:00:00Z`) / 1000 + 86400);
