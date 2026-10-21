import { mean, sampleSd, welch } from "./stats";

export const BEHAVIORS: readonly string[] = ["cigarettes", "alcohol_g", "caffeine_mg"];
export const OUTCOMES: readonly string[] = [
  "rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev", "sleep_min", "sleep_eff",
  "deep_min", "rem_min", "sleep_latency_min", "steps", "azm", "readiness_proxy",
];
const DEFAULT_BINS: Record<string, number[]> = { cigarettes: [5, 10], alcohol_g: [20, 40], caffeine_mg: [200, 400] };
const DAY = 86_400_000;

export function round(value: number): number;
export function round(value: number | null): number | null;
export function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

export function caveats(n: number): string {
  return `Asociacional, no causal. n=${String(n)}. Posibles confusores: alcohol, entrenamiento, hora de acostarse, enfermedad.`;
}

function calendarTime(date: string): number {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time)
    || new Date(time).toISOString().slice(0, 10) !== date || date < "2000-01-01" || date > "2099-12-31") {
    throw new RangeError("date must be a real calendar date in YYYY-MM-DD format");
  }
  return time;
}

// Callers validate column names before interpolation; dates always use bound parameters.
export async function analysisSeries(db: D1Database, start: string, end: string, lag: number, columns: string[]): Promise<{
  days: number; series: (number | null)[][];
}> {
  const first = calendarTime(start);
  const days = (calendarTime(end) - first) / DAY + 1;
  if (days < 1 || days > 365) throw new RangeError("range must contain 1 to 365 dates");
  const dates = Array.from({ length: days + lag }, (_, i) => new Date(first + i * DAY).toISOString().slice(0, 10));
  const { results } = await db.prepare(
    `SELECT local_date, ${columns.join(", ")} FROM v_daily WHERE local_date BETWEEN ? AND ? ORDER BY local_date`,
  ).bind(start, dates[dates.length - 1]).all<{ local_date: string; [column: string]: unknown }>();
  const rows = new Map(results.map((row) => [row.local_date, row]));
  return { days, series: columns.map((column) => dates.map((date) => {
    const value = rows.get(date)?.[column];
    return typeof value === "number" && Number.isFinite(value) ? value : BEHAVIORS.includes(column) ? 0 : null;
  })) };
}

export async function healthCompare(db: D1Database, { behavior, outcome, start, end, lag_days = 1, bins = DEFAULT_BINS[behavior] }: {
  behavior: string; outcome: string; start: string; end: string; lag_days?: number; bins?: number[];
}) {
  if (!BEHAVIORS.includes(behavior)) throw new RangeError(`behavior must be one of: ${BEHAVIORS.join(", ")}`);
  if (!OUTCOMES.includes(outcome)) throw new RangeError(`outcome must be one of: ${OUTCOMES.join(", ")}`);
  if (!Number.isInteger(lag_days) || lag_days < 0 || lag_days > 7) throw new RangeError("lag_days must be an integer from 0 to 7");
  if (bins.length < 1 || bins.length > 5 || bins.some((t, i) => !Number.isFinite(t) || t <= 0 || (i > 0 && t <= bins[i - 1]))) {
    throw new RangeError("bins must be 1 to 5 ascending positive finite numbers");
  }
  const { days, series: [behaviors, outcomes] } = await analysisSeries(db, start, end, lag_days, [behavior, outcome]);
  const labels = ["0", ...bins.map((t, i) => `>${String(i === 0 ? 0 : bins[i - 1])}–${String(t)}`), `>${String(bins[bins.length - 1])}`];
  const groups = labels.map((): number[] => []);
  let n = 0;
  let nonZeroDays = 0;
  for (let i = 0; i < days; i++) {
    const value = outcomes[i + lag_days];
    if (value === null) continue;
    const total = behaviors[i] ?? 0;
    const group = total <= 0 ? 0 : 1 + bins.filter((t) => total > t).length;
    groups[group].push(value);
    n++;
    if (total !== 0) nonZeroDays++;
  }
  const reference = groups.findIndex((group) => group.length >= 2);
  const comparisons: { group: string; vs: string; diff: number; df: number | null; ci95: [number, number] | null }[] = [];
  if (reference !== -1) {
    for (let i = reference + 1; i < groups.length; i++) {
      const result = welch(groups[i], groups[reference]);
      if (result === null) continue;
      comparisons.push({ group: labels[i], vs: labels[reference], diff: round(result.diff), df: round(result.df),
        ci95: result.ci95 === null ? null : [round(result.ci95[0]), round(result.ci95[1])] });
    }
  }
  const notes: string[] = [];
  if (nonZeroDays < 3) {
    notes.push(`${behavior} solo tiene valores distintos de 0 en ${String(nonZeroDays)} de ${String(n)} días; los días sin registro cuentan como 0.`);
  } else if (comparisons.length === 0) {
    notes.push("Ningún grupo distinto del de referencia tiene al menos 2 días; no hay comparaciones.");
  }
  return { behavior, outcome, lag_days, start, end, n,
    groups: groups.map((group, i) => ({ label: labels[i], n: group.length, mean: round(mean(group)), sd: round(sampleSd(group)) })),
    comparisons, notes, caveats: caveats(n) };
}
