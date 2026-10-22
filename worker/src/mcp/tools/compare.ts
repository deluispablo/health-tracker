import { mean, sampleSd, welch } from "./stats";

export const BEHAVIORS: readonly string[] = ["cigarettes", "alcohol_g", "caffeine_mg"];
export const OUTCOMES: readonly string[] = [
  "rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev", "sleep_min", "sleep_eff",
  "deep_min", "rem_min", "sleep_latency_min", "steps", "azm", "readiness_proxy",
];
const DEFAULT_BINS: Record<string, number[]> = { cigarettes: [5, 10], alcohol_g: [20, 40], caffeine_mg: [200, 400] };
const MIN_DAYS_PER_GROUP = 2;
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
function analysisSeriesQuery(db: D1Database, start: string, end: string, lag: number, columns: string[]) {
  const first = calendarTime(start);
  const days = (calendarTime(end) - first) / DAY + 1;
  if (days < 1 || days > 365) throw new RangeError("range must contain 1 to 365 dates");
  const dates = Array.from({ length: days + lag }, (_, i) => new Date(first + i * DAY).toISOString().slice(0, 10));
  const trackers: Record<string, string> = { cigarettes: "cigarettes", alcohol_g: "alcohol", caffeine_mg: "caffeine" };
  const behaviors = [...new Set(columns.filter((column) => BEHAVIORS.includes(column)))];
  const eligibility = behaviors.length === 0 ? [] : [
    "EXISTS (SELECT 1 FROM event e WHERE e.deleted_at IS NULL AND e.local_date = calendar.local_date) AS active_logging",
    ...behaviors.map((column) => `(SELECT date(ts + tz_offset_min * 60 - 18000, 'unixepoch') FROM event WHERE tracker_id = ? ORDER BY ts LIMIT 1) AS first_bday_${column}`),
  ];
  const source = behaviors.length === 0 ? "v_daily WHERE local_date BETWEEN ? AND ?" : `(
    WITH RECURSIVE dates(local_date) AS (
      SELECT ? UNION ALL SELECT date(local_date, '+1 day') FROM dates WHERE local_date < ?
    ) SELECT local_date FROM dates
  ) calendar LEFT JOIN v_daily USING (local_date)
    ${behaviors.map((column) => `LEFT JOIN tracker_daily total_${column}
      ON total_${column}.local_date = calendar.local_date AND total_${column}.tracker_id = '${trackers[column]}'`).join(" ")}`;
  const selected = columns.map((column) => behaviors.includes(column) ? `total_${column}.total AS ${column}` : `v_daily.${column}`);
  const dateColumn = behaviors.length === 0 ? "local_date" : "calendar.local_date";
  const statement = db.prepare(
    `SELECT ${dateColumn}, ${[...selected, ...eligibility].join(", ")} FROM ${source} ORDER BY ${dateColumn}`,
  ).bind(...behaviors.map((column) => trackers[column]), start, dates[dates.length - 1]);
  const parse = (results: { local_date: string; [column: string]: unknown }[]) => {
    const rows = new Map(results.map((row) => [row.local_date, row]));
    return { days, series: columns.map((column) => dates.map((date) => {
      const row = rows.get(date);
      if (BEHAVIORS.includes(column)) {
        const firstBday = row?.[`first_bday_${column}`];
        if (!row?.active_logging || typeof firstBday !== "string" || date <= firstBday) return null;
      }
      const value = row?.[column];
      return typeof value === "number" && Number.isFinite(value) ? value : BEHAVIORS.includes(column) ? 0 : null;
    })) };
  };
  return { statement, parse };
}

export async function analysisSeries(db: D1Database, start: string, end: string, lag: number, columns: string[]) {
  const query = analysisSeriesQuery(db, start, end, lag, columns);
  const { results } = await query.statement.all<{ local_date: string; [column: string]: unknown }>();
  return query.parse(results);
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
  const query = analysisSeriesQuery(db, start, end, lag_days, [behavior, outcome]);
  const tracker = { cigarettes: "cigarettes", alcohol_g: "alcohol", caffeine_mg: "caffeine" }[behavior];
  const [seriesResult, loggingResult] = await db.batch<{ local_date: string; [column: string]: unknown } | { logged_days: number; first_logged_date: string | null; last_logged_date: string | null }>([
    query.statement,
    db.prepare(
      "SELECT COUNT(*) AS logged_days, MIN(local_date) AS first_logged_date, MAX(local_date) AS last_logged_date FROM tracker_daily WHERE tracker_id = ? AND local_date BETWEEN ? AND ?",
    ).bind(tracker, start, end),
  ]);
  const { days, series: [behaviors, outcomes] } = query.parse(seriesResult.results as { local_date: string; [column: string]: unknown }[]);
  const behavior_logging = loggingResult.results[0] as { logged_days: number; first_logged_date: string | null; last_logged_date: string | null };
  const labels = ["0", ...bins.map((t, i) => `>${String(i === 0 ? 0 : bins[i - 1])}–${String(t)}`), `>${String(bins[bins.length - 1])}`];
  const groups = labels.map((): number[] => []);
  let n = 0;
  let nonZeroDays = 0;
  for (let i = 0; i < days; i++) {
    const value = outcomes[i + lag_days];
    const total = behaviors[i];
    if (value === null || total === null) continue;
    const group = total <= 0 ? 0 : 1 + bins.filter((t) => total > t).length;
    groups[group].push(value);
    n++;
    if (total !== 0) nonZeroDays++;
  }
  const reference = groups.findIndex((group) => group.length >= MIN_DAYS_PER_GROUP);
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
    notes.push(`${behavior} solo tiene valores distintos de 0 en ${String(nonZeroDays)} de ${String(n)} días; los días hasta el primer día de registro y los días sin ningún registro no cuentan; los demás días sin registro de este hábito cuentan como 0.`);
  } else if (comparisons.length === 0) {
    notes.push("Ningún grupo distinto del de referencia tiene al menos 2 días; no hay comparaciones.");
  }
  notes.push(`${behavior} tiene registros en ${String(behavior_logging.logged_days)} día(s) del rango solicitado; primer registro: ${behavior_logging.first_logged_date ?? "ninguno"}; último registro: ${behavior_logging.last_logged_date ?? "ninguno"}. Se usa todo el rango solicitado; los días hasta el primer día de registro y los días sin ningún registro no cuentan; los demás días sin registro de este hábito cuentan como 0.`);
  if (comparisons.length === 0) {
    notes.push(`Se necesitan al menos ${String(MIN_DAYS_PER_GROUP)} días con resultado disponible en cada uno de al menos 2 grupos para una comparación.`);
  }
  return { behavior, outcome, lag_days, start, end, n,
    groups: groups.map((group, i) => ({ label: labels[i], n: group.length, mean: round(mean(group)), sd: round(sampleSd(group)) })),
    comparisons, notes, caveats: caveats(n), behavior_logging, min_days_per_group: MIN_DAYS_PER_GROUP };
}
