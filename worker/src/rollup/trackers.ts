import { dateRangeDays } from "../lib/time";

export function trackerDailyStatements(db: D1Database, from: string, to: string, eventId?: string): D1PreparedStatement[] {
  dateRangeDays(from, to, 366);
  // A losing insert must not refresh its proposed date instead of the stored event's date.
  const guard = eventId === undefined ? "" : `AND EXISTS (
    SELECT 1 FROM event WHERE id = ?3 AND local_date BETWEEN ?1 AND ?2
  )`;
  const bindings = eventId === undefined ? [from, to] : [from, to, eventId];
  return [
    db.prepare(`DELETE FROM tracker_daily WHERE local_date BETWEEN ?1 AND ?2 ${guard}`).bind(...bindings),
    db.prepare(`
      INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total, first_ts, last_ts)
      SELECT local_date, tracker_id, SUM(value), COUNT(*),
        SUM(CASE WHEN ((ts + tz_offset_min * 60) % 86400 + 86400) % 86400 >= 18 * 3600
          THEN value ELSE 0 END),
        MIN(ts), MAX(ts)
      FROM event
      WHERE deleted_at IS NULL AND local_date BETWEEN ?1 AND ?2 ${guard}
      GROUP BY local_date, tracker_id
    `).bind(...bindings),
  ];
}

/** Replace tracker totals atomically using stored dates and each event's local time. */
export async function recomputeTrackerDaily(db: D1Database, from: string, to: string): Promise<number> {
  await db.batch(trackerDailyStatements(db, from, to));
  return dateRangeDays(from, to, 366);
}
