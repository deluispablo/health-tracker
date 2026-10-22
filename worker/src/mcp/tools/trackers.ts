import { dateTimeFormat } from "../../lib/time";
import { trackerDailyStatements } from "../../rollup/trackers";

interface Tracker {
  id: string;
  name: string;
  unit: string;
  value_type: "count" | "amount" | "scale";
  default_value: number | null;
  min_value: number | null;
  max_value: number | null;
}

interface EventRow {
  id: string;
  tracker_id: string;
  ts: number;
  tz_offset_min: number;
  local_date: string;
  value: number;
  note: string | null;
}

function eventOutput(row: EventRow) {
  const local = new Date((row.ts + row.tz_offset_min * 60) * 1000);
  return {
    id: row.id, tracker_id: row.tracker_id,
    local_time: Number.isFinite(local.getTime()) ? local.toISOString().slice(11, 16) : null,
    value: row.value, note_untrusted: row.note === null ? null : Array.from(row.note).slice(0, 280).join(""),
  };
}

export async function healthTrackers(db: D1Database, { date }: { date: string }) {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight)
    || new Date(midnight).toISOString().slice(0, 10) !== date
    || date < "2000-01-01" || date > "2099-12-31") {
    throw new RangeError("date must be a real YYYY-MM-DD date between 2000-01-01 and 2099-12-31");
  }
  const [totalsResult, eventsResult] = await db.batch<Tracker & { total: number; n: number } | EventRow>([
    db.prepare(`
      SELECT t.id, t.name, t.unit, t.value_type, t.default_value, t.min_value, t.max_value,
        COALESCE(SUM(e.value), 0) AS total, COUNT(e.id) AS n
      FROM tracker t LEFT JOIN event e
        ON e.tracker_id = t.id AND e.local_date = ? AND e.deleted_at IS NULL
      WHERE t.archived_at IS NULL GROUP BY t.id ORDER BY t.id
    `).bind(date),
    db.prepare(`
      SELECT e.id, e.tracker_id, e.ts, e.tz_offset_min, e.local_date, e.value, e.note
      FROM event e JOIN tracker t ON t.id = e.tracker_id
      WHERE e.local_date = ? AND e.deleted_at IS NULL AND t.archived_at IS NULL
      ORDER BY e.ts, e.id LIMIT 51
    `).bind(date),
  ]);
  const trackers = totalsResult.results as (Tracker & { total: number; n: number })[];
  const events = eventsResult.results as EventRow[];
  return { date, trackers, events: events.slice(0, 50).map(eventOutput), events_truncated: events.length > 50 };
}

function eventById(db: D1Database, id: string) {
  return db.prepare("SELECT id, tracker_id, ts, tz_offset_min, local_date, value, note, deleted_at FROM event WHERE id = ?")
    .bind(id).first<EventRow & { deleted_at: number | null }>();
}

function dayTotalStatement(db: D1Database, event: EventRow) {
  return db.prepare(`
    SELECT COALESCE(SUM(value), 0) AS total FROM event
    WHERE tracker_id = ? AND local_date = ? AND deleted_at IS NULL
  `).bind(event.tracker_id, event.local_date);
}

function logOutput(event: EventRow, created: boolean, total: D1Result<{ total: number }>) {
  return { created, event: { ...eventOutput(event), local_date: event.local_date }, day_total: total.results[0].total };
}

function storedDateRefresh(db: D1Database, date: string) {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(midnight)
    && new Date(midnight).toISOString().slice(0, 10) === date && date >= "2000-01-01" && date <= "2099-12-31";
  return validDate ? trackerDailyStatements(db, date, date) : [];
}

async function logResult(db: D1Database, event: EventRow, created: boolean) {
  const results = await db.batch<{ total: number }>([
    ...storedDateRefresh(db, event.local_date), dayTotalStatement(db, event),
  ]);
  return logOutput(event, created, results[results.length - 1]);
}

function eventTime(at: string, now: number): number {
  const match = typeof at === "string"
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(at) : null;
  if (!match) throw new RangeError("at must be a strict RFC 3339 instant with at most 3 fractional digits");
  const midnight = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== match[1]
    || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || Number(match[5]) > 14 || Number(match[6]) > 59) {
    throw new RangeError("at must have a real date and valid clock and offset fields");
  }
  const instant = Date.parse(at) / 1000;
  if (!Number.isFinite(instant) || instant < now - 7 * 86400 || instant > now + 300) {
    throw new RangeError("at must be between 7 days ago and 300 seconds from now");
  }
  return Math.floor(instant);
}

export async function logEvent(db: D1Database, args: {
  tracker_id: string; value?: number; at?: string; note?: string; idempotency_key?: string;
}, { now, tz, idPrefix = "k_" }: { now: number; tz: string; idPrefix?: string }) {
  if (args.idempotency_key !== undefined) {
    if (typeof args.idempotency_key !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(args.idempotency_key)) {
      throw new RangeError("idempotency_key must contain 8 to 64 ASCII letters, digits, underscores or hyphens");
    }
  }
  const trackerStatement = db.prepare(`
    SELECT id, name, unit, value_type, default_value, min_value, max_value
    FROM tracker WHERE id = ? AND archived_at IS NULL
  `).bind(args.tracker_id);
  let tracker: Tracker | null;
  if (args.idempotency_key !== undefined) {
    const [existingResult, trackerResult] = await db.batch<EventRow | Tracker>([
      db.prepare("SELECT id, tracker_id, ts, tz_offset_min, local_date, value, note, deleted_at FROM event WHERE id = ?")
        .bind(`${idPrefix}${args.idempotency_key}`),
      trackerStatement,
    ]);
    const existing = existingResult.results[0] as EventRow | undefined;
    if (existing) return logResult(db, existing, false);
    tracker = trackerResult.results[0] as Tracker | undefined ?? null;
  } else {
    tracker = await trackerStatement.first<Tracker>();
  }
  if (!tracker) throw new RangeError("tracker_id must name an active tracker");
  const value = args.value === undefined ? tracker.default_value : args.value;
  if (typeof value !== "number" || !Number.isFinite(value)
    || (tracker.min_value !== null && value < tracker.min_value)
    || (tracker.max_value !== null && value > tracker.max_value)
    || (tracker.value_type === "count" && !Number.isInteger(value))) {
    throw new RangeError("value must be finite, within the tracker limits and an integer for count trackers");
  }
  const ts = args.at === undefined ? Math.floor(now) : eventTime(args.at, now);
  let note: string | null = null;
  if (args.note !== undefined) {
    if (typeof args.note !== "string") throw new RangeError("note must be a string");
    note = args.note.trim() || null;
    if (note !== null && Array.from(note).length > 280) throw new RangeError("note must contain at most 280 Unicode code points after trimming");
  }
  const offset = dateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(ts * 1000).find((part) => part.type === "timeZoneName")?.value.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  const tz_offset_min = offset ? (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  const event: EventRow = {
    id: args.idempotency_key === undefined ? crypto.randomUUID() : `${idPrefix}${args.idempotency_key}`,
    tracker_id: tracker.id, ts, tz_offset_min,
    local_date: new Date((ts + tz_offset_min * 60) * 1000).toISOString().slice(0, 10), value, note,
  };
  const results = await db.batch<{ total: number }>([
    db.prepare(`
      INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, note, origin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'mcp', ?) ON CONFLICT(id) DO NOTHING
    `).bind(event.id, event.tracker_id, ts, tz_offset_min, event.local_date, value, note, now),
    ...trackerDailyStatements(db, event.local_date, event.local_date, event.id),
    dayTotalStatement(db, event),
  ]);
  if (results[0].meta.changes === 0) {
    const existing = await eventById(db, event.id);
    if (!existing) throw new Error("Conflicting event is missing");
    return logResult(db, existing, false);
  }
  return logOutput(event, true, results[results.length - 1]);
}

export async function deleteEvent(db: D1Database, { event_id }: { event_id: string }, { now }: { now: number }) {
  if (typeof event_id !== "string" || event_id.length < 1 || event_id.length > 80) {
    throw new RangeError("event_id must name an existing event");
  }
  const event = await eventById(db, event_id);
  if (!event) throw new RangeError("event_id must name an existing event");
  const live = event.deleted_at === null;
  const results = await db.batch<{ total: number }>([
    ...(live ? [
      db.prepare("UPDATE event SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now, event_id),
      ...storedDateRefresh(db, event.local_date),
    ] : []),
    dayTotalStatement(db, event),
  ]);
  return {
    deleted: live && results[0].meta.changes > 0,
    event: { ...eventOutput(event), local_date: event.local_date },
    day_total: results[results.length - 1].results[0].total,
  };
}
