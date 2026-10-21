interface BucketRow {
  bucket_start: number;
  avg: number;
  min: number;
  max: number;
  minutes: number;
}

export async function healthIntraday(db: D1Database, { metric, date, resolution }: {
  metric: string; date: string; resolution: "1m" | "5m" | "1h";
}): Promise<{
  metric: string; unit: string; date: string; resolution: string;
  points: [string, number, number, number][]; coverage: { minutes_with_data: number };
}> {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (metric !== "hr") throw new RangeError("metric must be hr");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight)
    || new Date(midnight).toISOString().slice(0, 10) !== date
    || date < "2000-01-01" || date > "2099-12-31") {
    throw new RangeError("date must be a real YYYY-MM-DD date between 2000-01-01 and 2099-12-31");
  }
  if (!["1m", "5m", "1h"].includes(resolution)) {
    throw new RangeError("resolution must be 1m, 5m or 1h");
  }
  const size = resolution === "1m" ? "60" : resolution === "5m" ? "300" : "3600";
  const { results } = await db.prepare(`
    SELECT floor((ts + tz_offset_min * 60) / ${size}.0) * ${size} AS bucket_start,
      round(avg(value), 1) AS avg, min(coalesce(vmin, value)) AS min,
      max(coalesce(vmax, value)) AS max, count(*) AS minutes
    FROM metric_minute
    WHERE metric = ? AND source = 'gh' AND ts >= ? AND ts < ?
      AND date(ts + tz_offset_min * 60, 'unixepoch') = ?
    GROUP BY tz_offset_min, bucket_start ORDER BY min(ts)
  `).bind(metric, midnight / 1000 - 14 * 3600, midnight / 1000 + 38 * 3600, date).all<BucketRow>();

  return {
    metric, unit: "bpm", date, resolution,
    points: results.map((row) => [
      new Date(row.bucket_start * 1000).toISOString().slice(0, 16), row.avg, row.min, row.max,
    ]),
    coverage: { minutes_with_data: results.reduce((sum, row) => sum + row.minutes, 0) },
  };
}
