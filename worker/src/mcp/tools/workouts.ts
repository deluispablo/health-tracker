import { roundOneDecimal as round } from "./stats";

interface WorkoutRow {
  source_id: string;
  local_date: string;
  type: string;
  start_ts: number;
  end_ts: number;
  tz_offset_min: number;
  duration_min: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  kcal: number | null;
  azm: number | null;
  distance_m: number | null;
}

function calendarTime(date: string): number {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time)
    || new Date(time).toISOString().slice(0, 10) !== date) {
    throw new RangeError("date must be a real calendar date in YYYY-MM-DD format");
  }
  return time;
}

const localTime = (ts: number, offset: number): string => new Date((ts + offset * 60) * 1000).toISOString().slice(0, 16);

export async function healthWorkouts(db: D1Database, { start, end }: { start: string; end: string }) {
  const days = (calendarTime(end) - calendarTime(start)) / 86400000 + 1;
  if (days < 1 || days > 31) throw new RangeError("range must contain 1 to 31 dates");

  const { results: rows } = await db.prepare(`
    SELECT w.source_id, w.local_date, w.type, w.start_ts, w.end_ts, w.tz_offset_min,
      w.duration_min, w.avg_hr, w.kcal, w.azm, w.distance_m, (
        SELECT MAX(m.vmax) FROM metric_minute m
        WHERE m.metric = 'hr' AND m.source = 'gh' AND m.ts >= w.start_ts AND m.ts < w.end_ts
      ) AS max_hr
    FROM workout w WHERE local_date BETWEEN ? AND ? ORDER BY start_ts, source_id
  `).bind(start, end).all<WorkoutRow>();
  const workouts = rows.map((row) => ({
    local_date: row.local_date, type: row.type,
    start_local: localTime(row.start_ts, row.tz_offset_min), end_local: localTime(row.end_ts, row.tz_offset_min),
    tz_offset_min: row.tz_offset_min, duration_min: round(row.duration_min), avg_hr: round(row.avg_hr),
    max_hr: round(row.max_hr),
    kcal: round(row.kcal), azm: round(row.azm), distance_m: round(row.distance_m),
  }));
  return { workouts, count: workouts.length };
}
