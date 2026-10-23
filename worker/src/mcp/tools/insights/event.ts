import { dateTimeFormat } from "../../../lib/time";
import { offsetMinutes } from "../../../ingest/drain";
import type { AcuteTracker, Interval } from "./types";

export const ACUTE = {
  baselineMin: 15, response: { cigarettes: [0, 15], caffeine: [30, 120], alcohol: [0, 60] },
  days: 28, maxEvents: 40, maxControlsPerDay: 8, gridMin: 30, clearanceMin: 60,
  coverage: 0.8, sessionGapMin: 120,
} as const;
const trackers: AcuteTracker[] = ["cigarettes", "caffeine", "alcohol"];
const dateAt = (ts: number, offset: number) => new Date((ts + offset * 60) * 1000).toISOString().slice(0, 10);
const midnight = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

export interface WindowAgg {
  tz_offset_min: number | null;
  base_mean: number | null;
  base_n: number;
  resp: Record<AcuteTracker, { mean: number | null; n: number }>;
}
export interface AcuteInput {
  taps: { tracker: AcuteTracker; ts: number; tz_offset_min: number }[];
  sleeps: Interval[];
  workouts: Interval[];
  windows: Map<number, WindowAgg>;
  nowSec: number;
}
export interface AcuteDays {
  tracker: AcuteTracker;
  dates: string[];
  d: (number | null)[];
  eventDays: number;
  events: number;
  controls: number;
  excluded: Record<"overlap" | "workout" | "sleep" | "coverage" | "dst" | "no_control" | "future", number>;
}

function gridStarts(taps: AcuteInput["taps"]): Map<string, number> {
  const starts = new Map<string, number>();
  for (const tap of [...taps].sort((a, b) => a.ts - b.ts || a.tz_offset_min - b.tz_offset_min)) {
    const date = dateAt(tap.ts, tap.tz_offset_min);
    if (!starts.has(date)) starts.set(date, midnight(date) - tap.tz_offset_min * 60);
  }
  return starts;
}

export async function loadAcuteInput(db: D1Database, p: {
  start: string; end: string; nowSec: number; tz: string;
}): Promise<AcuteInput> {
  const start = midnight(p.end) - (ACUTE.days - 1) * 86400;
  // Padding preserves neighbouring taps for clearance, overlap and alcohol sessions.
  const { results } = await db.prepare(`
    WITH RECURSIVE
    taps AS MATERIALIZED (
      SELECT tracker_id AS tracker, ts, tz_offset_min,
        date(ts + tz_offset_min * 60, 'unixepoch') AS day
      FROM event WHERE deleted_at IS NULL AND tracker_id IN ('cigarettes', 'caffeine', 'alcohol')
        AND ts >= ?1 AND ts < ?2
    ),
    ranked AS (
      SELECT *, row_number() OVER (PARTITION BY day ORDER BY ts, tz_offset_min) AS rank FROM taps
    ),
    grid(i) AS (SELECT 0 UNION ALL SELECT i + 30 FROM grid WHERE i < 1410),
    candidates(ts) AS MATERIALIZED (
      SELECT ts FROM taps UNION
      SELECT unixepoch(day) - tz_offset_min * 60 + i * 60 FROM ranked, grid WHERE rank = 1
    ),
    windows AS (
      SELECT c.ts,
        avg(CASE WHEN m.ts < c.ts THEN value END) AS base_mean,
        count(CASE WHEN m.ts < c.ts THEN 1 END) AS base_n,
        avg(CASE WHEN m.ts >= c.ts AND m.ts < c.ts + 900 THEN value END) AS cigarette_mean,
        count(CASE WHEN m.ts >= c.ts AND m.ts < c.ts + 900 THEN 1 END) AS cigarette_n,
        avg(CASE WHEN m.ts >= c.ts + 1800 AND m.ts < c.ts + 7200 THEN value END) AS caffeine_mean,
        count(CASE WHEN m.ts >= c.ts + 1800 AND m.ts < c.ts + 7200 THEN 1 END) AS caffeine_n,
        avg(CASE WHEN m.ts >= c.ts AND m.ts < c.ts + 3600 THEN value END) AS alcohol_mean,
        count(CASE WHEN m.ts >= c.ts AND m.ts < c.ts + 3600 THEN 1 END) AS alcohol_n,
        (SELECT tz_offset_min FROM metric_minute WHERE metric = 'hr' AND source = 'gh'
          AND ts >= c.ts - 900 AND ts < c.ts ORDER BY ts DESC LIMIT 1) AS hr_offset
      FROM candidates c LEFT JOIN metric_minute m
        ON m.metric = 'hr' AND m.source = 'gh' AND m.ts >= c.ts - 900 AND m.ts < c.ts + 7200
      GROUP BY c.ts
    )
    SELECT 'tap' AS kind, json_object('tracker', tracker, 'ts', ts, 'tz_offset_min', tz_offset_min) AS data FROM taps
    UNION ALL SELECT 'sleep', json_array(start_ts, end_ts) FROM sleep_session WHERE start_ts < ?2 + 86400 AND end_ts > ?1 - 86400
    UNION ALL SELECT 'workout', json_array(start_ts, end_ts) FROM workout WHERE start_ts < ?2 + 86400 AND end_ts > ?1 - 86400
    UNION ALL SELECT 'window', json_object('ts', ts, 'base_mean', base_mean, 'base_n', base_n, 'hr_offset', hr_offset,
      'resp', json_object('cigarettes', json_object('mean', cigarette_mean, 'n', cigarette_n),
        'caffeine', json_object('mean', caffeine_mean, 'n', caffeine_n),
        'alcohol', json_object('mean', alcohol_mean, 'n', alcohol_n))) FROM windows
  `).bind(start - 16 * 3600, midnight(p.end) + 40 * 3600)
    .all<{ kind: "tap" | "sleep" | "workout" | "window"; data: string }>();
  const input: AcuteInput = { taps: [], sleeps: [], workouts: [], windows: new Map(), nowSec: p.nowSec };
  const formatter = dateTimeFormat("en-US", { timeZone: p.tz, timeZoneName: "longOffset" });
  for (const row of results) {
    if (row.kind === "tap") input.taps.push(JSON.parse(row.data) as AcuteInput["taps"][number]);
    else if (row.kind === "sleep") input.sleeps.push(JSON.parse(row.data) as Interval);
    else if (row.kind === "workout") input.workouts.push(JSON.parse(row.data) as Interval);
    else {
      const { ts, hr_offset, ...window } = JSON.parse(row.data) as Omit<WindowAgg, "tz_offset_min"> & { ts: number; hr_offset: number | null };
      input.windows.set(ts, { ...window, tz_offset_min: hr_offset });
    }
  }
  // Recorded offsets win (the tap's, else the latest heart-rate minute before the window); only a window with none uses the current zone.
  for (const tap of input.taps) {
    const window = input.windows.get(tap.ts);
    if (window) window.tz_offset_min = tap.tz_offset_min;
  }
  for (const [ts, window] of input.windows) {
    if (window.tz_offset_min === null) window.tz_offset_min = offsetMinutes(ts, formatter);
  }
  return input;
}

export function acuteDays(input: AcuteInput, p: { start: string; end: string }): AcuteDays[] {
  const start = new Date((midnight(p.end) - (ACUTE.days - 1) * 86400) * 1000).toISOString().slice(0, 10);
  const taps = [...input.taps].sort((a, b) => a.ts - b.ts);
  const starts = gridStarts(taps);
  const dates = new Map<AcuteInput["taps"][number], string>();
  for (const tap of taps) {
    const date = dateAt(tap.ts, tap.tz_offset_min);
    dates.set(tap, date);
  }
  const grids = new Map<string, { ts: number; w: WindowAgg | undefined; sameDay: boolean }[]>();
  const firstTapAt = (ts: number): number => {
    let lo = 0, hi = taps.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (taps[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return trackers.map((tracker) => {
    const result: AcuteDays = { tracker, dates: [], d: [], eventDays: 0, events: 0, controls: 0,
      excluded: { overlap: 0, workout: 0, sleep: 0, coverage: 0, dst: 0, no_control: 0, future: 0 } };
    const [r0, r1] = ACUTE.response[tracker];
    const isSessionStart = (tap: AcuteInput["taps"][number]): boolean => {
      if (tap.tracker !== "alcohol") return true;
      for (let i = firstTapAt(tap.ts) - 1; i >= 0 && taps[i].ts >= tap.ts - ACUTE.sessionGapMin * 60; i--) {
        if (taps[i].tracker === "alcohol") return false;
      }
      return true;
    };
    const candidates = taps.filter((tap) => {
      if (tap.tracker !== tracker) return false;
      const date = dates.get(tap) ?? dateAt(tap.ts, tap.tz_offset_min);
      return date >= start && date <= p.end && isSessionStart(tap);
    }).slice(-ACUTE.maxEvents);
    const overlaps = (lo: number, hi: number, event?: AcuteInput["taps"][number]): boolean => {
      for (let i = firstTapAt(lo); i < taps.length && taps[i].ts < hi; i++) {
        const other = taps[i];
        if (other !== event && !(event?.tracker === "alcohol" && other.tracker === "alcohol"
          && other.ts > event.ts && !isSessionStart(other))) return true;
      }
      return false;
    };
    const delta = (ts: number, event?: AcuteInput["taps"][number]): number | null => {
      const lo = ts - ACUTE.baselineMin * 60, hi = ts + r1 * 60;
      let reason: keyof AcuteDays["excluded"] | undefined;
      if (hi >= input.nowSec) reason = "future";
      else if (overlaps(lo, hi, event)) reason = "overlap";
      else if (input.workouts.some(([a, b]) => a < hi + 900 && b > lo)) reason = "workout";
      else if (input.sleeps.some(([a, b]) => a < hi && b > lo)) reason = "sleep";
      if (reason) { result.excluded[reason]++; return null; }
      const w = input.windows.get(ts);
      const response = w?.resp[tracker];
      if (!w || w.base_mean === null || !Number.isFinite(w.base_mean) || w.base_n < ACUTE.coverage * ACUTE.baselineMin
        || !response || response.mean === null || !Number.isFinite(response.mean) || response.n < ACUTE.coverage * (r1 - r0)) {
        result.excluded.coverage++; return null;
      }
      return response.mean - w.base_mean;
    };
    const days = new Map<string, { delta: number; offset: number }[]>();
    for (const tap of candidates) {
      const d = delta(tap.ts, tap);
      if (d === null) continue;
      result.events++;
      const date = dates.get(tap) ?? dateAt(tap.ts, tap.tz_offset_min);
      const events = days.get(date) ?? [];
      events.push({ delta: d, offset: tap.tz_offset_min });
      days.set(date, events);
    }
    for (const [date, events] of days) {
      const controls: { delta: number; offset: number }[] = [];
      const dayStart = starts.get(date);
      if (dayStart === undefined) continue;
      let grid = grids.get(date);
      if (!grid) {
        grid = [];
        const localStart = midnight(date);
        let next = firstTapAt(dayStart);
        for (let minute = 0; minute < 1440; minute += ACUTE.gridMin) {
          const ts = dayStart + minute * 60;
          while (next < taps.length && taps[next].ts < ts) next++;
          if ((next < taps.length && taps[next].ts - ts < ACUTE.clearanceMin * 60)
            || (next > 0 && ts - taps[next - 1].ts < ACUTE.clearanceMin * 60)) continue;
          const w = input.windows.get(ts);
          const local = ts + (w?.tz_offset_min ?? 0) * 60;
          grid.push({ ts, w, sameDay: local >= localStart && local < localStart + 86400 });
        }
        grids.set(date, grid);
      }
      const offsets = new Set(events.map((event) => event.offset));
      for (const { ts, w, sameDay } of grid) {
        if (!w) { result.excluded.coverage++; continue; }
        if (w.tz_offset_min === null || !offsets.has(w.tz_offset_min)) { result.excluded.dst++; continue; }
        if (!sameDay) continue;
        const d = delta(ts);
        if (d !== null) controls.push({ delta: d, offset: w.tz_offset_min });
      }
      const picks = controls.length <= ACUTE.maxControlsPerDay ? controls
        : Array.from({ length: ACUTE.maxControlsPerDay }, (_, i) => controls[Math.round(i * (controls.length - 1) / (ACUTE.maxControlsPerDay - 1))]);
      const matchedOffsets = new Set(picks.map((control) => control.offset));
      result.dates.push(date);
      if (events.some((event) => !matchedOffsets.has(event.offset))) {
        result.d.push(null); result.excluded.no_control++;
      } else {
        result.d.push(events.reduce((sum, event) => sum + event.delta, 0) / events.length
          - picks.reduce((sum, control) => sum + control.delta, 0) / picks.length);
        result.eventDays++; result.controls += picks.length;
      }
    }
    return result;
  });
}
