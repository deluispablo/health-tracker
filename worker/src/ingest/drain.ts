import type { createGoogleClient, DailyRollUpPoint, RollUpPoint } from "../google/client";
import { upsertStatements } from "../lib/d1";
import { sleepLocalDate } from "../lib/time";

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

const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 1000;
const addDays = (date: string, days: number): string => new Date((midnight(date) + days * 86400) * 1000).toISOString().slice(0, 10);

function validDate(date: unknown): date is string {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(midnight(date)) && addDays(date, 0) === date;
}

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

export async function drainSyncPending(
  env: DrainEnv, client: Pick<ReturnType<typeof createGoogleClient>, "rollUpHeartRate" | "dailyRollUp" | "listDaily" | "reconcile">,
  opts: { now?: () => number } = {},
): Promise<{ processed: number; failed: number }> {
  const db = env.DB;
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: env.USER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  let processed = 0;
  let failed = 0;
  for (const type of ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability",
    "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes"]) {
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

    if (type === "sleep") {
      const end = Math.min(row.end_ts + 60, row.start_ts + 7 * 86400);
      let items: unknown[];
      try {
        items = await client.reconcile("sleep", new Date(row.start_ts * 1000).toISOString(), new Date(end * 1000).toISOString());
      } catch {
        await db.prepare(`UPDATE sync_pending SET attempts = attempts + 1 WHERE ${predicate}`).bind(...key).run();
        failed++;
        continue;
      }

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
          sleepLocalDate(endTs, tz), object(sleep.metadata).mainSleep === true ? 0 : 1, asleep, inBed,
          asleep !== null && inBed !== null && inBed > 0 ? Math.round(asleep / inBed * 100) : null,
          ...["DEEP", "REM", "LIGHT", "AWAKE"].map((stage) => stageMinutes.get(stage) ?? null),
          readNumber(summary.minutesToFallAsleep), now], stages });
      }

      statements.push(db.prepare(`DELETE FROM sleep_stage WHERE session_id IN
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
      try {
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
      } catch {
        await db.prepare(`UPDATE sync_pending SET attempts = attempts + 1 WHERE ${predicate}`).bind(...key).run();
        failed++;
        continue;
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
        if (!validDate(point.date) || point.date < first || point.date >= end || value === null || !Number.isFinite(value)) return [];
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
