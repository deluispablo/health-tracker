import type { createGoogleClient, DailyRollUpPoint } from "../google/client";
import { parseExerciseInstant } from "../google/client";
import { upsertStatements } from "../lib/d1";
import { dateTimeFormat, isCalendarDate, sleepLocalDate } from "../lib/time";
import { RECONCILE_TYPES } from "./poll";

interface DrainEnv { DB: D1Database; USER_TZ: string }
interface PendingRow {
  data_type: string;
  start_ts: number;
  end_ts: number;
  operation: "UPSERT" | "DELETE";
  received_at: number;
  attempts: number;
}

const dailyListTypes: Record<string, { metric: string; payload: string; field: string }> = {
  "daily-resting-heart-rate": { metric: "rhr", payload: "dailyRestingHeartRate", field: "beatsPerMinute" },
  "daily-heart-rate-variability": { metric: "hrv_rmssd", payload: "dailyHeartRateVariability", field: "averageHeartRateVariabilityMilliseconds" },
  "daily-oxygen-saturation": { metric: "spo2", payload: "dailyOxygenSaturation", field: "averagePercentage" },
  "daily-respiratory-rate": { metric: "resp_rate", payload: "dailyRespiratoryRate", field: "breathsPerMinute" },
  "daily-sleep-temperature-derivations": { metric: "skin_temp_dev", payload: "dailySleepTemperatureDerivations", field: "nightlyTemperatureCelsius" },
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function localDate(ts: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(ts * 1000);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

export function offsetMinutes(ts: number, formatter: Intl.DateTimeFormat): number {
  const offset = formatter.formatToParts(ts * 1000).find((part) => part.type === "timeZoneName")
    ?.value.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return offset ? (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
}

function localMidnight(date: string, formatter: Intl.DateTimeFormat): number {
  const civil = midnight(date);
  let ts = civil;
  for (let i = 0; i < 3; i++) ts = civil - offsetMinutes(ts, formatter) * 60;
  return ts;
}

const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 1000;
const addDays = (date: string, days: number): string => new Date((midnight(date) + days * 86400) * 1000).toISOString().slice(0, 10);

function sleepInterval(value: unknown): [number, number] | undefined {
  const interval = object(value);
  const instant = (v: unknown): number => typeof v === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) / 1000 : NaN;
  const start = instant(interval.startTime);
  const end = instant(interval.endTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [Math.floor(start), Math.floor(end)] : undefined;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const utcDate = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

function dirtyStatements(db: D1Database, first: string, last: string, sessions?: {
  table: "sleep_session" | "workout"; timestamp: "start_ts" | "end_ts";
  start: number; end: number; written: [string, string][];
}): D1PreparedStatement[] {
  const bindings: unknown[] = [first, last];
  let stored = "";
  if (sessions) {
    bindings.push(JSON.stringify(sessions.written), sessions.start, sessions.end);
    stored = `
      UNION SELECT local_date FROM ${sessions.table}
        WHERE source = 'gh' AND ${sessions.timestamp} >= ?4 AND ${sessions.timestamp} < ?5
      UNION SELECT local_date FROM ${sessions.table}
        WHERE source_id IN (SELECT json_extract(value, '$[0]') FROM json_each(?3))
      UNION SELECT json_extract(value, '$[1]') FROM json_each(?3)`;
  }
  return [
    // A persistent sequence prevents delete/reinsert from reusing a version held by another cron.
    db.prepare("UPDATE rollup_seq SET n = n + 1 WHERE id = 1"),
    db.prepare(`WITH RECURSIVE dates(local_date) AS (
      SELECT ?1 WHERE ?1 <= ?2
      UNION ALL SELECT date(local_date, '+1 day') FROM dates WHERE local_date < ?2
    )
    INSERT INTO rollup_dirty (local_date, version)
    SELECT local_date, (SELECT n FROM rollup_seq WHERE id = 1)
    FROM (SELECT local_date FROM dates ${stored})
    WHERE local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(local_date, '+0 days') = local_date AND local_date BETWEEN '2000-01-01' AND '2099-12-31'
    ON CONFLICT(local_date) DO UPDATE SET version = excluded.version`).bind(...bindings),
  ];
}

export async function drainSyncPending(
  env: DrainEnv, client: Pick<ReturnType<typeof createGoogleClient>, "rollUpHeartRate" | "rollUpSteps" | "dailyRollUp" | "listDaily" | "reconcile">,
  opts: { now?: () => number; deadlineMs?: number } = {},
): Promise<{ processed: number; failed: number }> {
  const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
  const db = env.DB;
  const dateFormatter = dateTimeFormat("en-US", {
    timeZone: env.USER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  let processed = 0;
  let failed = 0;
  const cutoff = (opts.now?.() ?? Math.floor(Date.now() / 1000)) - 86400;
  let remaining = 799; // Include the queue read in the 800-statement budget.
  // Admit at most one historical heart-rate row; drain all types oldest-first.
  const { results: pending } = await db.prepare(`SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY data_type, (end_ts < ?1)
      ORDER BY received_at, start_ts, operation, end_ts) AS rank
    FROM sync_pending WHERE attempts < 5 AND data_type IN (${RECONCILE_TYPES.map(() => "?").join(", ")})
  ) WHERE data_type != 'heart-rate' OR end_ts >= ?1 OR rank = 1
    ORDER BY received_at, start_ts, operation, end_ts,
      CASE data_type ${RECONCILE_TYPES.map((type, i) => `WHEN '${type}' THEN ${String(i)}`).join(" ")} END`).bind(cutoff, ...RECONCILE_TYPES).all<PendingRow>();
  for (const row of pending) {
    if (Date.now() >= deadline || remaining < 4) break;
    const type = row.data_type;

    const key = [row.data_type, row.start_ts, row.end_ts, row.operation];
    const predicate = "data_type = ? AND start_ts = ? AND end_ts = ? AND operation = ?";
    try {
      const remove = db.prepare(`DELETE FROM sync_pending WHERE ${predicate} AND received_at = ?`)
        .bind(...key, row.received_at);
      const statements: D1PreparedStatement[] = [];
      let advance: number | undefined;

      if (type === "exercise") {
        const end = Math.min(row.end_ts + 60, row.start_ts + 7 * 86400);
        const items = await client.reconcile(type, new Date(row.start_ts * 1000).toISOString(), new Date(end * 1000).toISOString());

        const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
        const answer = new Map<string, unknown[]>();
        for (const item of items) {
          const payload = object(item);
          const exercise = object(payload.exercise);
          const interval = object(exercise.interval);
          const start = parseExerciseInstant(interval.startTime);
          const finish = parseExerciseInstant(interval.endTime);
          const offset = interval.startUtcOffset;
          if (typeof payload.dataPointName !== "string" || !payload.dataPointName
            || typeof exercise.exerciseType !== "string" || !exercise.exerciseType
            || !Number.isFinite(start) || !Number.isFinite(finish) || finish <= start
            || typeof offset !== "string" || !/^-?\d+s$/.test(offset)) continue;
          const tz = Number(offset.slice(0, -1)) / 60;
          if (!Number.isInteger(tz)) continue;
          const startTs = Math.floor(start / 1000);
          const endTs = Math.floor(finish / 1000);
          const metrics = object(exercise.metricsSummary);
          const duration = exercise.activeDuration;
          const distance = readNumber(metrics.distanceMillimeters);
          answer.set(payload.dataPointName, [payload.dataPointName, "gh", exercise.exerciseType, startTs, endTs, tz,
            new Date((startTs + tz * 60) * 1000).toISOString().slice(0, 10),
            typeof duration === "string" && /^\d+(\.\d+)?s$/.test(duration)
              ? Number(duration.slice(0, -1)) / 60 : (endTs - startTs) / 60,
            readNumber(metrics.averageHeartRateBeatsPerMinute), null, readNumber(metrics.caloriesKcal),
            readNumber(metrics.activeZoneMinutes), distance === null ? null : distance / 1000, now]);
        }
        statements.push(...dirtyStatements(db, utcDate(row.start_ts - 14 * 3600), utcDate(end + 14 * 3600), {
          table: "workout", timestamp: "start_ts", start: row.start_ts, end,
          written: [...answer].map(([id, values]) => [id, values[6] as string]),
        }), db.prepare("DELETE FROM workout WHERE source = 'gh' AND start_ts >= ? AND start_ts < ?").bind(row.start_ts, end),
          ...upsertStatements(db, "workout",
            ["source_id", "source", "type", "start_ts", "end_ts", "tz_offset_min", "local_date", "duration_min", "avg_hr", "max_hr",
              "kcal", "azm", "distance_m", "updated_at"], ["source_id"], [...answer.values()]));
        if (end < row.end_ts + 60) advance = end;
      } else if (type === "sleep") {
        const end = Math.min(row.end_ts + 60, row.start_ts + 7 * 86400);
        const items = await client.reconcile("sleep", new Date(row.start_ts * 1000).toISOString(), new Date(end * 1000).toISOString());

        const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
        const answer = new Map<string, { session: unknown[]; stages: unknown[][] }>();
        for (const item of items) {
          const payload = object(item);
          const sleep = object(payload.sleep);
          const interval = sleepInterval(sleep.interval);
          const offset = object(sleep.interval).endUtcOffset;
          if (typeof payload.dataPointName !== "string" || !interval || typeof offset !== "string" || !/^-?\d+s$/.test(offset)) continue;
          const tz = Number(offset.slice(0, -1)) / 60;
          if (!Number.isInteger(tz)) continue;
          const [startTs, endTs] = interval;
          const summary = object(sleep.summary);
          const asleep = readNumber(summary.minutesAsleep);
          const inBed = readNumber(summary.minutesInSleepPeriod);
          const startHour = new Date((startTs + tz * 60) * 1000).getUTCHours();
          const isNap = object(sleep.metadata).mainSleep !== true
            || ((inBed ?? (endTs - startTs) / 60) < 180 && startHour >= 9 && startHour < 20);
          const stageMinutes = new Map<string, number>();
          for (const entry of Array.isArray(summary.stagesSummary) ? summary.stagesSummary : []) {
            const s = object(entry);
            const minutes = readNumber(s.minutes);
            if (typeof s.type === "string" && minutes !== null) stageMinutes.set(s.type, minutes);
          }
          const stages = (Array.isArray(sleep.stages) ? sleep.stages : []).flatMap((entry) => {
            const s = object(entry);
            const times = sleepInterval(s);
            return times && typeof s.type === "string" && ["LIGHT", "DEEP", "REM", "AWAKE"].includes(s.type)
              ? [[payload.dataPointName, ...times, s.type]] : [];
          });
          // A duplicate replaces the whole session, including its stages.
          answer.set(payload.dataPointName, { session: [payload.dataPointName, "gh", startTs, endTs, tz,
            sleepLocalDate(endTs, tz), isNap ? 1 : 0, asleep, inBed,
            asleep !== null && inBed !== null && inBed > 0 ? Math.round(asleep / inBed * 100) : null,
            ...["DEEP", "REM", "LIGHT", "AWAKE"].map((stage) => stageMinutes.get(stage) ?? null),
            readNumber(summary.minutesToFallAsleep), now], stages });
        }

        statements.push(...dirtyStatements(db, utcDate(row.start_ts - 14 * 3600), utcDate(end + 14 * 3600), {
          table: "sleep_session", timestamp: "end_ts", start: row.start_ts, end,
          written: [...answer].map(([id, item]) => [id, item.session[5] as string]),
        }), db.prepare(`DELETE FROM sleep_stage WHERE session_id IN
          (SELECT source_id FROM sleep_session WHERE source = 'gh' AND end_ts >= ? AND end_ts < ?)`)
          .bind(row.start_ts, end),
        db.prepare("DELETE FROM sleep_session WHERE source = 'gh' AND end_ts >= ? AND end_ts < ?").bind(row.start_ts, end));
        for (const id of answer.keys()) statements.push(db.prepare("DELETE FROM sleep_stage WHERE session_id = ?").bind(id));
        statements.push(...upsertStatements(db, "sleep_session",
          ["source_id", "source", "start_ts", "end_ts", "tz_offset_min", "local_date", "is_nap", "minutes_asleep", "minutes_in_bed",
            "efficiency", "deep_min", "rem_min", "light_min", "awake_min", "latency_min", "updated_at"],
          ["source_id"], [...answer.values()].map((item) => item.session)),
        ...upsertStatements(db, "sleep_stage", ["session_id", "start_ts", "end_ts", "stage"],
          ["session_id", "start_ts"], [...answer.values()].flatMap((item) => item.stages)));
        if (end < row.end_ts + 60) advance = end;
      } else if (type !== "heart-rate") {
        const first = localDate(row.start_ts, dateFormatter);
        const fullEnd = addDays(localDate(row.end_ts - 1, dateFormatter), 1);
        const cap = addDays(first, 31);
        const end = fullEnd < cap ? fullEnd : cap;
        const listed = dailyListTypes[type];
        let points: DailyRollUpPoint[];
        if (type === "steps" || type === "active-zone-minutes") {
          points = await client.dailyRollUp(type, first, end);
        } else {
          const items = await client.listDaily(type, first, end);
          points = items.map((item) => {
            const payload = object(object(item)[listed.payload]);
            const date = object(payload.date);
            let value = readNumber(payload[listed.field]);
            if (type === "daily-sleep-temperature-derivations") {
              const baseline = readNumber(payload.baselineTemperatureCelsius);
              value = value !== null && baseline !== null ? value - baseline : null;
            }
            return {
              date: [date.year, date.month, date.day].map((part, i) => String(part).padStart(i === 0 ? 4 : 2, "0")).join("-"),
              value,
            };
          });
        }

        if (type === "steps") {
          const formatter = dateTimeFormat("en-US", { timeZone: env.USER_TZ, timeZoneName: "longOffset" });
          for (let date = first; date < end;) {
            // Thirteen local dates stay below 14 elapsed days even over a fall-back.
            const next = addDays(date, 13) < end ? addDays(date, 13) : end;
            const startTs = localMidnight(date, formatter);
            const endTs = localMidnight(next, formatter);
            const hours = await client.rollUpSteps(new Date(startTs * 1000).toISOString(), new Date(endTs * 1000).toISOString());
            const rows = hours.filter((point) => point.ts >= startTs && point.ts < endTs).map((point) =>
              [point.ts, offsetMinutes(point.ts, formatter), point.steps]);
            // One JSON binding keeps a full 31-date slice within the D1 query budget.
            statements.push(db.prepare("DELETE FROM metric_minute WHERE metric = 'steps_h' AND source = 'gh' AND ts >= ? AND ts < ?")
              .bind(startTs, endTs), db.prepare(`INSERT INTO metric_minute
                (metric, ts, tz_offset_min, value, vmin, vmax, n, source)
                SELECT 'steps_h', json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                  json_extract(value, '$[2]'), json_extract(value, '$[2]'), json_extract(value, '$[2]'), NULL, 'gh'
                FROM json_each(?) WHERE true
                ON CONFLICT(metric, source, ts) DO UPDATE SET tz_offset_min = excluded.tz_offset_min,
                  value = excluded.value, vmin = excluded.vmin, vmax = excluded.vmax, n = excluded.n`)
              .bind(JSON.stringify(rows)));
            date = next;
          }
        }

        const metric = type === "steps" ? "steps" : type === "active-zone-minutes" ? "azm" : listed.metric;
        const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
        const rows = points.flatMap((point) => {
          let value = readNumber(type === "steps" ? object(point.value).countSum : point.value);
          if (type === "active-zone-minutes") {
            const zones = object(point.value);
            const parts = ["sumInCardioHeartZone", "sumInPeakHeartZone", "sumInFatBurnHeartZone"]
              .filter((field) => field in zones).map((field) => readNumber(zones[field]) ?? NaN);
            value = parts.length ? parts.reduce((sum, part) => sum + part, 0) : NaN;
          }
          if (!isCalendarDate(point.date) || point.date < first || point.date >= end || value === null || !Number.isFinite(value)) return [];
          return [[metric, point.date, value, "gh", null, now]];
        });
        statements.push(...dirtyStatements(db, first, addDays(end, -1)), db.prepare(`DELETE FROM metric_daily
          WHERE metric = ? AND source = 'gh' AND local_date >= ? AND local_date < ?`).bind(metric, first, end),
          ...upsertStatements(db, "metric_daily", ["metric", "local_date", "value", "source", "source_id", "updated_at"],
            ["metric", "source", "local_date"], rows));
        // Start early enough to re-read the boundary date in every zone, including across DST.
        if (end < fullEnd) advance = midnight(end) - 14 * 3600;
      } else if (row.operation === "DELETE") {
        statements.push(...dirtyStatements(db, utcDate(row.start_ts - 14 * 3600), utcDate(row.end_ts + 14 * 3600)),
          db.prepare(`DELETE FROM metric_minute
          WHERE metric = 'hr' AND source = 'gh' AND ts >= ? AND ts < ?`).bind(row.start_ts, row.end_ts));
      } else {
        const start = Math.floor(row.start_ts / 60) * 60;
        const roundedEnd = Math.ceil(row.end_ts / 60) * 60;
        const end = Math.min(roundedEnd, start + 86400);
        const points = await client.rollUpHeartRate(new Date(start * 1000).toISOString(), new Date(end * 1000).toISOString(), 60);

        const formatter = dateTimeFormat("en-US", { timeZone: env.USER_TZ, timeZoneName: "longOffset" });
        const rows = points.map((point) => {
          const offsetMin = offsetMinutes(point.ts, formatter);
          return ["hr", point.ts, offsetMin, point.avg, point.min, point.max, null, "gh"];
        });
        statements.push(...dirtyStatements(db, utcDate(start - 14 * 3600), utcDate(end + 14 * 3600)),
          ...upsertStatements(db, "metric_minute",
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

      // Reserve one statement to record a failed batch.
      if (statements.length + 2 > remaining && processed + failed > 0) break;
      remaining -= statements.length + 1;
      await db.batch([...statements, remove]);
      processed++;
    } catch (cause) {
      const status = cause instanceof Error ? cause.message.match(/^(?:Google API |Google token refresh failed: )([45]\d{2})$/) : null;
      console.error(type, cause instanceof Error ? cause.name : "UnknownError", ...(status ? [Number(status[1])] : []));
      remaining--;
      await db.prepare(`UPDATE sync_pending SET attempts = attempts + 1 WHERE ${predicate}`).bind(...key).run();
      failed++;
      if (status?.[1] === "429") break;
    }
  }
  return { processed, failed };
}
