import type { createGoogleClient, DailyRollUpPoint, RollUpPoint } from "../google/client";
import { upsertStatements } from "../lib/d1";

interface DrainEnv { DB: D1Database; USER_TZ: string }
interface PendingRow {
  data_type: string;
  start_ts: number;
  end_ts: number;
  operation: "UPSERT" | "DELETE";
  received_at: number;
  attempts: number;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function localDate(ts: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(ts * 1000);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 1000;
const addDays = (date: string, days: number): string => new Date((midnight(date) + days * 86400) * 1000).toISOString().slice(0, 10);

function validDate(date: unknown): date is string {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(midnight(date)) && addDays(date, 0) === date;
}

export async function drainSyncPending(
  env: DrainEnv, client: Pick<ReturnType<typeof createGoogleClient>, "rollUpHeartRate" | "dailyRollUp" | "listDaily">,
  opts: { now?: () => number } = {},
): Promise<{ processed: number; failed: number }> {
  const db = env.DB;
  let processed = 0;
  let failed = 0;
  for (const type of ["heart-rate", "steps", "daily-resting-heart-rate"]) {
    const row = await db.prepare(`SELECT * FROM sync_pending
      WHERE data_type = ? AND attempts < 5
      ORDER BY received_at, start_ts, operation, end_ts LIMIT 1`).bind(type).first<PendingRow>();
    if (!row) continue;

    const key = [row.data_type, row.start_ts, row.end_ts, row.operation];
    const predicate = "data_type = ? AND start_ts = ? AND end_ts = ? AND operation = ?";
    const remove = db.prepare(`DELETE FROM sync_pending WHERE ${predicate} AND received_at = ?`)
      .bind(...key, row.received_at);
    const statements: D1PreparedStatement[] = [];
    let advance: number | undefined;

    if (type !== "heart-rate") {
      const first = localDate(row.start_ts, env.USER_TZ);
      const fullEnd = addDays(localDate(row.end_ts - 1, env.USER_TZ), 1);
      const cap = addDays(first, 31);
      const end = fullEnd < cap ? fullEnd : cap;
      let points: DailyRollUpPoint[];
      try {
        if (type === "steps") {
          points = await client.dailyRollUp("steps", first, end);
        } else {
          const items = await client.listDaily("daily-resting-heart-rate", first, end);
          points = items.map((item) => {
            const payload = object(object(item).dailyRestingHeartRate);
            const date = object(payload.date);
            return {
              date: [date.year, date.month, date.day].map((part, i) => String(part).padStart(i === 0 ? 4 : 2, "0")).join("-"),
              value: payload.beatsPerMinute,
            };
          });
        }
      } catch {
        await db.prepare(`UPDATE sync_pending SET attempts = attempts + 1 WHERE ${predicate}`).bind(...key).run();
        failed++;
        continue;
      }

      const metric = type === "steps" ? "steps" : "rhr";
      const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
      const rows = points.flatMap((point) => {
        const value = Number(type === "steps" ? object(point.value).countSum : point.value);
        if (!validDate(point.date) || point.date < first || point.date >= end || !Number.isFinite(value)) return [];
        return [[metric, point.date, value, "gh", null, now]];
      });
      statements.push(db.prepare(`DELETE FROM metric_daily
        WHERE metric = ? AND source = 'gh' AND local_date >= ? AND local_date < ?`).bind(metric, first, end),
        ...upsertStatements(db, "metric_daily", ["metric", "local_date", "value", "source", "source_id", "updated_at"],
          ["metric", "source", "local_date"], rows));
      // Start early enough to re-read the boundary date in every zone, including across DST.
      if (end < fullEnd) advance = midnight(end) - 14 * 3600;
    } else if (row.operation === "DELETE") {
      statements.push(db.prepare(`DELETE FROM metric_minute
        WHERE metric = 'hr' AND source = 'gh' AND ts >= ? AND ts < ?`).bind(row.start_ts, row.end_ts));
    } else {
      const start = Math.floor(row.start_ts / 60) * 60;
      const roundedEnd = Math.ceil(row.end_ts / 60) * 60;
      const end = Math.min(roundedEnd, start + 3600);
      let points: RollUpPoint[];
      try {
        points = await client.rollUpHeartRate(new Date(start * 1000).toISOString(), new Date(end * 1000).toISOString(), 60);
      } catch {
        await db.prepare(`UPDATE sync_pending SET attempts = attempts + 1 WHERE ${predicate}`).bind(...key).run();
        failed++;
        continue;
      }

      const formatter = new Intl.DateTimeFormat("en-US", { timeZone: env.USER_TZ, timeZoneName: "longOffset" });
      const rows = points.map((point) => {
        const offset = formatter.formatToParts(point.ts * 1000).find((part) => part.type === "timeZoneName")
          ?.value.match(/^GMT([+-])(\d{2}):(\d{2})$/);
        const offsetMin = offset ? (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
        return ["hr", point.ts, offsetMin, point.avg, point.min, point.max, null, "gh"];
      });
      statements.push(...upsertStatements(db, "metric_minute",
        ["metric", "ts", "tz_offset_min", "value", "vmin", "vmax", "n", "source"], ["metric", "source", "ts"], rows));

      if (end < roundedEnd) advance = end;
    }

    if (advance !== undefined) {
      // Preserve a concurrent receipt; merge any existing remainder without losing its retry budget.
      statements.push(db.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts)
        SELECT data_type, ?, end_ts, operation, received_at, attempts FROM sync_pending
        WHERE ${predicate} AND received_at = ?
        ON CONFLICT (data_type, start_ts, end_ts, operation) DO UPDATE SET
          received_at = max(received_at, excluded.received_at), attempts = min(attempts, excluded.attempts)`)
        .bind(advance, ...key, row.received_at));
    }

    await db.batch([...statements, remove]);
    processed++;
  }
  return { processed, failed };
}
