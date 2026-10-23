import { dateRangeDays } from "../lib/time";

const BASE_COLUMNS = [
  "rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev",
  "sleep_min", "sleep_eff", "deep_min", "rem_min", "sleep_latency_min", "bedtime_local", "waketime_local",
  "steps", "azm", "workout_min", "hr_wear_min", "computed_at",
];

const BASE_SQL = `
WITH RECURSIVE dates(local_date) AS (
  SELECT ?1 UNION ALL SELECT date(local_date, '+1 day') FROM dates WHERE local_date < ?2
), metrics AS (
  SELECT local_date,
    MAX(CASE WHEN metric = 'rhr' THEN value END) AS rhr,
    MAX(CASE WHEN metric = 'hrv_rmssd' THEN value END) AS hrv_rmssd,
    MAX(CASE WHEN metric = 'resp_rate' THEN value END) AS resp_rate,
    MAX(CASE WHEN metric = 'spo2' THEN value END) AS spo2_avg,
    MAX(CASE WHEN metric = 'skin_temp_dev' THEN value END) AS skin_temp_dev,
    MAX(CASE WHEN metric = 'steps' THEN value END) AS steps,
    MAX(CASE WHEN metric = 'azm' THEN value END) AS azm
  FROM metric_daily
  WHERE metric IN ('rhr', 'hrv_rmssd', 'resp_rate', 'spo2', 'skin_temp_dev', 'steps', 'azm')
    AND source = 'gh' AND local_date BETWEEN ?1 AND ?2
  GROUP BY local_date
), sleeps AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY local_date ORDER BY minutes_in_bed DESC NULLS LAST, end_ts DESC, source_id DESC
  ) AS rank
  FROM sleep_session WHERE is_nap = 0 AND local_date BETWEEN ?1 AND ?2
), workouts AS (
  SELECT local_date, SUM(duration_min) AS minutes FROM workout
  WHERE local_date BETWEEN ?1 AND ?2 GROUP BY local_date
), wear AS (
  SELECT date(ts + tz_offset_min * 60, 'unixepoch') AS local_date, COUNT(*) AS minutes
  FROM metric_minute WHERE metric = 'hr' AND source = 'gh'
    AND ts >= unixepoch(?1) - 14 * 3600 AND ts < unixepoch(?2) + 86400 + 14 * 3600
    AND date(ts + tz_offset_min * 60, 'unixepoch') BETWEEN ?1 AND ?2
  GROUP BY local_date
)
INSERT INTO daily_summary (local_date, ${BASE_COLUMNS.join(", ")})
SELECT d.local_date, m.rhr, m.hrv_rmssd, CASE WHEN m.hrv_rmssd > 0 THEN ln(m.hrv_rmssd) END,
  m.resp_rate, m.spo2_avg, m.skin_temp_dev,
  s.minutes_asleep, s.efficiency, s.deep_min, s.rem_min, s.latency_min,
  strftime('%H:%M', s.start_ts + COALESCE(s.start_tz_offset_min, s.tz_offset_min) * 60, 'unixepoch'),
  strftime('%H:%M', s.end_ts + s.tz_offset_min * 60, 'unixepoch'),
  m.steps, m.azm, w.minutes, h.minutes, ?3
FROM dates d
LEFT JOIN metrics m ON m.local_date = d.local_date
LEFT JOIN sleeps s ON s.local_date = d.local_date AND s.rank = 1
LEFT JOIN workouts w ON w.local_date = d.local_date
LEFT JOIN wear h ON h.local_date = d.local_date
WHERE true
ON CONFLICT(local_date) DO UPDATE SET
  ${BASE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")}
`;

const BASELINES = [
  { column: "ln_rmssd", z: "z_ln_rmssd" },
  { column: "rhr", z: "z_rhr" },
  { column: "sleep_min", z: "z_sleep" },
];
const HISTORY_JOIN = "h.local_date >= date(d.local_date, '-28 days') AND h.local_date < d.local_date";

// Two passes avoid cancellation in E[x²] - E[x]² for nearly constant histories.
const SCORES_SQL = `
WITH means AS (
  SELECT d.local_date, ${BASELINES.map(({ column: c }) => `
    COUNT(h.${c}) AS n_${c}, AVG(h.${c}) AS mean_${c}`).join(", ")}
  FROM daily_summary d LEFT JOIN daily_summary h ON ${HISTORY_JOIN}
  WHERE d.local_date BETWEEN ?1 AND ?2 GROUP BY d.local_date
), deviations AS (
  SELECT d.*, ${BASELINES.map(({ column: c }) => `
    sqrt(SUM((h.${c} - d.mean_${c}) * (h.${c} - d.mean_${c})) / (d.n_${c} - 1)) AS sd_${c}`).join(", ")}
  FROM means d LEFT JOIN daily_summary h ON ${HISTORY_JOIN}
  GROUP BY d.local_date
), scores AS (
  SELECT s.local_date, ${BASELINES.map(({ column: c, z }) => `
    CASE WHEN d.n_${c} >= 7 AND d.sd_${c} > 1e-9
      THEN (s.${c} - d.mean_${c}) / d.sd_${c} END AS ${z}`).join(", ")}
  FROM daily_summary s JOIN deviations d ON d.local_date = s.local_date
)
UPDATE daily_summary
SET (z_ln_rmssd, z_rhr, z_sleep, readiness_proxy) = (
  SELECT z_ln_rmssd, z_rhr, z_sleep, 0.5 * z_ln_rmssd - 0.3 * z_rhr + 0.2 * z_sleep
  FROM scores WHERE scores.local_date = daily_summary.local_date
)
WHERE local_date BETWEEN ?1 AND ?2
`;

/** Replace daily bases and scores atomically; histories include stored summaries outside the range. */
export async function recomputeDailySummary(db: D1Database, from: string, to: string, now: number): Promise<number> {
  const count = dateRangeDays(from, to, 366);
  await db.batch([
    db.prepare(BASE_SQL).bind(from, to, now),
    db.prepare(SCORES_SQL).bind(from, to),
  ]);
  return count;
}
