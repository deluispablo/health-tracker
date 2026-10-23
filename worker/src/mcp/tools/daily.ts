import { dateRangeDays } from "../../lib/time";
import { round } from "./compare";
import { roundOneDecimal } from "./stats";

export const DAILY_COLUMNS: readonly string[] = [
  "rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev",
  "sleep_min", "sleep_eff", "deep_min", "rem_min", "sleep_latency_min", "bedtime_local", "waketime_local",
  "steps", "azm", "workout_min", "hr_wear_min", "z_ln_rmssd", "z_rhr", "z_sleep", "readiness_proxy",
  "cigarettes", "alcohol_g", "caffeine_mg",
  "mood_genial", "mood_bien", "mood_tranquilo", "mood_cansado", "mood_estresado", "mood_ansioso", "mood_triste", "mood_enfadado",
];

const UNITS: Record<string, string> = {
  rhr: "bpm", hrv_rmssd: "ms", ln_rmssd: "ln(ms)", resp_rate: "brpm", spo2_avg: "%", skin_temp_dev: "°C",
  sleep_min: "min", sleep_eff: "%", deep_min: "min", rem_min: "min", sleep_latency_min: "min",
  bedtime_local: "HH:MM", waketime_local: "HH:MM", steps: "count", azm: "min", workout_min: "min", hr_wear_min: "min",
  z_ln_rmssd: "z", z_rhr: "z", z_sleep: "z", readiness_proxy: "score", cigarettes: "count", alcohol_g: "g", caffeine_mg: "mg",
  mood_genial: "count", mood_bien: "count", mood_tranquilo: "count", mood_cansado: "count",
  mood_estresado: "count", mood_ansioso: "count", mood_triste: "count", mood_enfadado: "count",
};

export async function healthDaily(db: D1Database, { start, end, metrics = DAILY_COLUMNS }: {
  start: string; end: string; metrics?: readonly string[];
}): Promise<{
  columns: string[]; rows: unknown[][]; units: Record<string, string>;
  coverage: { days_requested: number; days_with_data: number };
}> {
  const daysRequested = dateRangeDays(start, end, 90, true);
  if (metrics.length === 0) throw new RangeError("metrics must not be empty");
  const unknown = metrics.find((metric) => !DAILY_COLUMNS.includes(metric));
  if (unknown !== undefined) throw new RangeError(`unknown metric "${unknown}"; valid: ${DAILY_COLUMNS.join(", ")}`);
  const repeated = metrics.find((metric, i) => metrics.indexOf(metric) !== i);
  if (repeated !== undefined) throw new RangeError(`metric "${repeated}" is repeated; valid: ${DAILY_COLUMNS.join(", ")}`);

  const columns = ["local_date", ...metrics];
  const { results } = await db.prepare(
    `SELECT ${columns.join(", ")} FROM v_daily WHERE local_date BETWEEN ? AND ? ORDER BY local_date`,
  ).bind(start, end).all();
  return {
    columns,
    rows: results.map((row) => columns.map((column) => {
      const value = row[column];
      return typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)
        ? UNITS[column] === "min" ? roundOneDecimal(value) : round(value) : value;
    })),
    units: Object.fromEntries(metrics.map((metric) => [metric, UNITS[metric]])),
    coverage: { days_requested: daysRequested, days_with_data: results.length },
  };
}
