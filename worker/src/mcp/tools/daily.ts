export const DAILY_COLUMNS: readonly string[] = [
  "rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev",
  "sleep_min", "sleep_eff", "deep_min", "rem_min", "sleep_latency_min", "bedtime_local", "waketime_local",
  "steps", "azm", "workout_min", "hr_wear_min", "z_ln_rmssd", "z_rhr", "z_sleep", "readiness_proxy",
  "cigarettes", "alcohol_g", "caffeine_mg",
];

const UNITS: Record<string, string> = {
  rhr: "bpm", hrv_rmssd: "ms", ln_rmssd: "ln(ms)", resp_rate: "brpm", spo2_avg: "%", skin_temp_dev: "°C",
  sleep_min: "min", sleep_eff: "%", deep_min: "min", rem_min: "min", sleep_latency_min: "min",
  bedtime_local: "HH:MM", waketime_local: "HH:MM", steps: "count", azm: "min", workout_min: "min", hr_wear_min: "min",
  z_ln_rmssd: "z", z_rhr: "z", z_sleep: "z", readiness_proxy: "score", cigarettes: "count", alcohol_g: "g", caffeine_mg: "mg",
};

function calendarTime(date: string): number {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time)
    || new Date(time).toISOString().slice(0, 10) !== date) {
    throw new RangeError("date must be a real calendar date in YYYY-MM-DD format");
  }
  return time;
}

export async function healthDaily(db: D1Database, { start, end, metrics = DAILY_COLUMNS }: {
  start: string; end: string; metrics?: readonly string[];
}): Promise<{
  columns: string[]; rows: unknown[][]; units: Record<string, string>;
  coverage: { days_requested: number; days_with_data: number };
}> {
  const daysRequested = (calendarTime(end) - calendarTime(start)) / 86_400_000 + 1;
  if (daysRequested < 1 || daysRequested > 90) throw new RangeError("range must contain 1 to 90 dates");
  if (metrics.length === 0 || new Set(metrics).size !== metrics.length || metrics.some((m) => !DAILY_COLUMNS.includes(m))) {
    throw new RangeError("metrics must be distinct names from DAILY_COLUMNS");
  }

  const columns = ["local_date", ...metrics];
  const { results } = await db.prepare(
    `SELECT ${columns.join(", ")} FROM v_daily WHERE local_date BETWEEN ? AND ? ORDER BY local_date`,
  ).bind(start, end).all();
  return {
    columns,
    rows: results.map((row) => columns.map((column) => row[column])),
    units: Object.fromEntries(metrics.map((metric) => [metric, UNITS[metric]])),
    coverage: { days_requested: daysRequested, days_with_data: results.length },
  };
}
