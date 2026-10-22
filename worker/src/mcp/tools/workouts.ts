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
    SELECT source_id, local_date, type, start_ts, end_ts, tz_offset_min, duration_min, avg_hr, kcal, azm, distance_m
    FROM workout WHERE local_date BETWEEN ? AND ? ORDER BY start_ts, source_id
  `).bind(start, end).all<WorkoutRow>();
  const { results: maxima } = await db.prepare(`
    SELECT w.source_id, (
      SELECT MAX(m.vmax) FROM metric_minute m
      WHERE m.metric = 'hr' AND m.source = 'gh' AND m.ts >= w.start_ts AND m.ts < w.end_ts
    ) AS max_hr
    FROM workout w WHERE w.local_date BETWEEN ? AND ?
  `).bind(start, end).all<{ source_id: string; max_hr: number | null }>();
  const maxHr = new Map(maxima.map((row) => [row.source_id, row.max_hr]));
  const workouts = rows.map((row) => ({
    local_date: row.local_date, type: row.type,
    start_local: localTime(row.start_ts, row.tz_offset_min), end_local: localTime(row.end_ts, row.tz_offset_min),
    tz_offset_min: row.tz_offset_min, duration_min: round(row.duration_min), avg_hr: round(row.avg_hr),
    max_hr: round(maxHr.get(row.source_id) ?? null),
    kcal: round(row.kcal), azm: round(row.azm), distance_m: round(row.distance_m),
  }));
  return { workouts, count: workouts.length };
}
