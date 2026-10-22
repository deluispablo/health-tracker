interface StreamRow {
  ts: number;
  tz_offset_min: number;
}

export async function healthStatus(db: D1Database, { now, tz }: { now: number; tz: string }) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const localTime = (ts: number) => {
    const parts = formatter.formatToParts(ts * 1000);
    const part = (name: string) => parts.find((p) => p.type === name)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  };
  const now_local = localTime(now);
  const today = now_local.slice(0, 10);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  const dates = Array.from({ length: 14 }, (_, i) =>
    new Date(midnight - (13 - i) * 86400000).toISOString().slice(0, 10));
  const yesterday = new Date(midnight - 86400000).toISOString().slice(0, 10);

  // Step between metric names in the primary key without reading their history.
  const { results: names } = await db.prepare(`
    SELECT metric FROM (
      WITH RECURSIVE names(metric) AS (
        SELECT min(metric) FROM metric_minute
        UNION ALL
        SELECT (SELECT min(metric) FROM metric_minute WHERE metric > names.metric)
        FROM names WHERE metric IS NOT NULL
      )
      SELECT metric FROM names WHERE metric IS NOT NULL
    ) ORDER BY metric
  `).all<{ metric: string }>();
  const [sleepResult, dailyResult, watchResult, queueResult, googleResult, coverageResult,
    freshResult, ...metricResults] = await db.batch([
    db.prepare(`
      SELECT end_ts AS ts, tz_offset_min FROM sleep_session
      WHERE source = 'gh' AND is_nap = 0 ORDER BY end_ts DESC LIMIT 1
    `),
    db.prepare(`
      SELECT local_date, computed_at FROM daily_summary ORDER BY local_date DESC LIMIT 1
    `),
    db.prepare(`
      SELECT synced_until FROM sync_state WHERE data_type = 'watch'
    `),
    db.prepare(`
      SELECT count(*) AS pending, count(CASE WHEN attempts >= 5 THEN 1 END) AS stuck,
        min(received_at) AS oldest FROM sync_pending
    `),
    db.prepare(`
      SELECT updated_at FROM secret_blob WHERE name = 'google_refresh_token'
    `),
    db.prepare(`
      SELECT local_date AS date, hr_wear_min AS hr_minutes
      FROM daily_summary WHERE local_date BETWEEN ? AND ?
    `).bind(dates[0], today),
    db.prepare(`
      SELECT 1 AS present FROM metric_minute
      WHERE metric = 'hr' AND source = 'gh' AND ts BETWEEN ? AND ? LIMIT 1
    `).bind(now - 172800, now),
    ...names.map(({ metric }) => db.prepare(`
      SELECT metric, ts, tz_offset_min FROM metric_minute
      WHERE metric = ? AND source = 'gh' ORDER BY ts DESC LIMIT 1
    `).bind(metric)),
  ]);
  const sleep = sleepResult.results[0] as StreamRow | undefined;
  const daily = dailyResult.results[0] as { local_date: string; computed_at: number } | undefined;
  const watch = watchResult.results[0] as { synced_until: number | null } | undefined;
  const queue = queueResult.results[0] as { pending: number; stuck: number; oldest: number | null } | undefined;
  const google = googleResult.results[0] as { updated_at: number } | undefined;
  const coverage = coverageResult.results as { date: string; hr_minutes: number | null }[];
  const fresh = freshResult.results[0];
  const metrics = metricResults.flatMap(({ results }) => results) as (StreamRow & { metric: string })[];

  const stream = (name: string, ts: number | null, offset?: number) => ({
    stream: name,
    latest_local: ts === null ? null : offset === undefined ? localTime(ts)
      : new Date((ts + offset * 60) * 1000).toISOString().slice(0, 16),
    age_hours: ts === null ? null : Math.round(Math.max(0, now - ts) / 360) / 10,
  });
  const alerts: { code: string; message: string }[] = [];
  if (!google) alerts.push({ code: "google_disconnected", message: "Google no está conectado." });
  if (!fresh) alerts.push({ code: "no_data_48h", message: "Sin datos de frecuencia cardíaca en las últimas 48 horas." });
  if (google && (!sleep || sleep.ts < now - 172800)) {
    alerts.push({ code: "no_sleep_48h", message: "Sin sesiones de sueño principal en las últimas 48 horas."
      + (sleep ? ` Último sueño principal: ${localTime(sleep.ts)}.` : "") });
  }
  if (queue && queue.stuck > 0) alerts.push({ code: "queue_stuck", message: "Hay elementos de la cola con cinco o más intentos." });
  if (!daily || daily.local_date < yesterday) alerts.push({ code: "daily_stale", message: "El resumen diario no está actualizado." });
  if (google && (watch?.synced_until == null || now - watch.synced_until > 86400)) {
    alerts.push({ code: "watch_not_syncing", message: "El reloj no se ha sincronizado en las últimas 24 h." });
  }
  const minutesByDate = new Map(coverage.map((row) => [row.date, row.hr_minutes]));
  let gap: string[] = [];
  for (const date of dates) {
    const minutes = minutesByDate.get(date);
    if (date < today && minutes != null && minutes <= 1) {
      gap.push(date);
    } else if (gap.length >= 3) {
      alerts.push({ code: "hr_coverage_gap",
        message: `Cobertura de frecuencia cardíaca casi nula (≤1 min/día) desde ${gap[0]} hasta ${gap.at(-1)}.` });
      break;
    } else {
      gap = [];
    }
  }
  return {
    now_local,
    streams: [
      ...metrics.map((row) => stream(`metric:${row.metric}`, row.ts, row.tz_offset_min)),
      stream("sleep", sleep?.ts ?? null, sleep?.tz_offset_min),
      stream("daily", daily?.computed_at ?? null),
      stream("watch", watch?.synced_until ?? null),
    ],
    queue: {
      pending: queue?.pending ?? 0, stuck: queue?.stuck ?? 0,
      oldest_received_local: queue?.oldest == null ? null : localTime(queue.oldest),
    },
    google: { connected: google !== undefined, token_updated_local: google ? localTime(google.updated_at) : null },
    coverage: dates.map((date) => ({ date, hr_minutes: Math.round(minutesByDate.get(date) ?? 0) })),
    alerts,
  };
}
