import type { createGoogleClient, RollUpPoint } from "../google/client";
import { upsertStatements } from "../lib/d1";

interface DrainEnv { DB: D1Database; USER_TZ: string }
interface PendingRow {
  data_type: string;
  start_ts: number;
  end_ts: number;
  operation: "UPSERT" | "DELETE";
  received_at: number;
  attempts: number;
}

export async function drainSyncPending(
  env: DrainEnv, client: Pick<ReturnType<typeof createGoogleClient>, "rollUpHeartRate">,
): Promise<{ processed: number; failed: number }> {
  const db = env.DB;
  const row = await db.prepare(`SELECT * FROM sync_pending
    WHERE data_type = 'heart-rate' AND attempts < 5
    ORDER BY received_at, start_ts, operation, end_ts LIMIT 1`).first<PendingRow>();
  if (!row) return { processed: 0, failed: 0 };

  const key = [row.data_type, row.start_ts, row.end_ts, row.operation];
  const predicate = "data_type = ? AND start_ts = ? AND end_ts = ? AND operation = ?";
  const remove = db.prepare(`DELETE FROM sync_pending WHERE ${predicate} AND received_at = ?`)
    .bind(...key, row.received_at);
  const statements: D1PreparedStatement[] = [];

  if (row.operation === "DELETE") {
    statements.push(db.prepare(`DELETE FROM metric_minute
      WHERE metric = 'hr' AND source = 'gh' AND ts >= ? AND ts < ?`).bind(row.start_ts, row.end_ts));
  } else {
    const start = Math.floor(row.start_ts / 60) * 60;
    const roundedEnd = Math.ceil(row.end_ts / 60) * 60;
    const end = Math.min(roundedEnd, start + 3600);
    let points: RollUpPoint[];
    try {
      points = await client.rollUpHeartRate(new Date(start * 1000).toISOString(), new Date(end * 1000).toISOString(), 60);
    } catch {
      await db.prepare(`UPDATE sync_pending SET attempts = attempts + 1 WHERE ${predicate}`).bind(...key).run();
      return { processed: 0, failed: 1 };
    }

    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: env.USER_TZ, timeZoneName: "longOffset" });
    const rows = points.map((point) => {
      const offset = formatter.formatToParts(point.ts * 1000).find((part) => part.type === "timeZoneName")
        ?.value.match(/^GMT([+-])(\d{2}):(\d{2})$/);
      const offsetMin = offset ? (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
      return ["hr", point.ts, offsetMin, point.avg, point.min, point.max, null, "gh"];
    });
    statements.push(...upsertStatements(db, "metric_minute",
      ["metric", "ts", "tz_offset_min", "value", "vmin", "vmax", "n", "source"], ["metric", "source", "ts"], rows));

    if (end < roundedEnd) {
      // Preserve a concurrent receipt; merge any existing remainder without losing its retry budget.
      statements.push(db.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts)
        SELECT data_type, ?, end_ts, operation, received_at, attempts FROM sync_pending
        WHERE ${predicate} AND received_at = ?
        ON CONFLICT (data_type, start_ts, end_ts, operation) DO UPDATE SET
          received_at = max(received_at, excluded.received_at), attempts = min(attempts, excluded.attempts)`)
        .bind(end, ...key, row.received_at));
    }
  }

  await db.batch([...statements, remove]);
  return { processed: 1, failed: 0 };
}
