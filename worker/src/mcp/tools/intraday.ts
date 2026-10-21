interface BucketRow {
  bucket_start: number;
  avg: number;
  min: number;
  max: number;
  minutes: number;
}

export async function healthIntraday(db: D1Database, { metric, date, resolution, from = "00:00", to = "24:00" }: {
  metric: string; date: string; resolution: "1m" | "5m" | "1h"; from?: string; to?: string;
}): Promise<{
  metric: string; unit: string; date: string; resolution: string;
  points: [string, number, number, number][]; coverage: { minutes_with_data?: number; hours_with_data?: number };
}> {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (metric !== "hr" && metric !== "steps") throw new RangeError("metric must be hr or steps");
  if (metric === "steps" && resolution !== "1h") throw new RangeError("steps supports only 1h resolution");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight)
    || new Date(midnight).toISOString().slice(0, 10) !== date
    || date < "2000-01-01" || date > "2099-12-31") {
    throw new RangeError("date must be a real YYYY-MM-DD date between 2000-01-01 and 2099-12-31");
  }
  if (!["1m", "5m", "1h"].includes(resolution)) {
    throw new RangeError("resolution must be 1m, 5m or 1h");
  }
  if ([from, to].some((time) => time.length !== 5 || !/^(?:[01]\d:[0-5]\d|2[0-3]:[0-5]\d|24:00)$/.test(time)) || from >= to) {
    throw new RangeError("from and to must be HH:MM with from before to");
  }
  const [start, end] = [from, to].map((time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3)));
  if (resolution === "1m" && end - start > 180) {
    throw new RangeError("1m resolution covers at most 3 hours: pass from and to, or use 5m");
  }
  const size = resolution === "1m" ? "60" : resolution === "5m" ? "300" : "3600";
  const { results } = await db.prepare(`
    SELECT ${metric === "steps" ? "ts + tz_offset_min * 60" : `floor((ts + tz_offset_min * 60) / ${size}.0) * ${size}`} AS bucket_start,
      ${metric === "steps" ? "sum(value)" : "round(avg(value), 1)"} AS avg,
      ${metric === "steps" ? "sum(value)" : "min(coalesce(vmin, value))"} AS min,
      ${metric === "steps" ? "sum(value)" : "max(coalesce(vmax, value))"} AS max, count(*) AS minutes
    FROM metric_minute
    WHERE metric = ? AND source = 'gh' AND ts >= ? AND ts < ?
      AND date(ts + tz_offset_min * 60, 'unixepoch') = ?
      AND strftime('%H:%M', ts + tz_offset_min * 60, 'unixepoch') >= ?
      AND strftime('%H:%M', ts + tz_offset_min * 60, 'unixepoch') < ?
    GROUP BY tz_offset_min, bucket_start ORDER BY min(ts)
  `).bind(metric === "steps" ? "steps_h" : metric, midnight / 1000 - 14 * 3600, midnight / 1000 + 38 * 3600, date, from, to).all<BucketRow>();

  return {
    metric, unit: metric === "steps" ? "count" : "bpm", date, resolution,
    points: results.map((row) => [
      new Date(row.bucket_start * 1000).toISOString().slice(metric === "steps" ? 11 : 0, 16), row.avg, row.min, row.max,
    ]),
    coverage: metric === "steps" ? { hours_with_data: results.reduce((sum, row) => sum + row.minutes, 0) }
      : { minutes_with_data: results.reduce((sum, row) => sum + row.minutes, 0) },
  };
}
