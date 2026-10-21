const DAY_MS = 86_400_000;

function calendarTime(date: string): number {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time)
    || new Date(time).toISOString().slice(0, 10) !== date) {
    throw new RangeError("date must be a real calendar date in YYYY-MM-DD format");
  }
  return time;
}

/** Replace tracker totals atomically using stored dates and each event's local time. */
export async function recomputeTrackerDaily(db: D1Database, from: string, to: string): Promise<number> {
  const count = (calendarTime(to) - calendarTime(from)) / DAY_MS + 1;
  if (count < 1 || count > 366) throw new RangeError("range must contain 1 to 366 dates");
  await db.batch([
    db.prepare("DELETE FROM tracker_daily WHERE local_date BETWEEN ?1 AND ?2").bind(from, to),
    db.prepare(`
      INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total, first_ts, last_ts)
      SELECT local_date, tracker_id, SUM(value), COUNT(*),
        SUM(CASE WHEN ((ts + tz_offset_min * 60) % 86400 + 86400) % 86400 >= 18 * 3600
          THEN value ELSE 0 END),
        MIN(ts), MAX(ts)
      FROM event
      WHERE deleted_at IS NULL AND local_date BETWEEN ?1 AND ?2
      GROUP BY local_date, tracker_id
    `).bind(from, to),
  ]);
  return count;
}
