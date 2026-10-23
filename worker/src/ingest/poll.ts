import { upsertStatements } from "../lib/d1";

export const RECONCILE_TYPES = [
  "heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability",
  "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "exercise",
];

export async function enqueueReconcile(db: D1Database, now: number): Promise<number> {
  const recent = await db.prepare("SELECT data_type FROM sync_state WHERE synced_until > ?")
    .bind(now - 20 * 3600).all<{ data_type: string }>();
  const skipped = new Set(recent.results.map((row) => row.data_type));
  const types = RECONCILE_TYPES.filter((type) => !skipped.has(type));
  if (!types.length) return 0;

  const end = Math.floor(now / 60) * 60;
  const start = end - 48 * 3600;
  await db.batch([
    ...upsertStatements(db, "sync_pending",
      ["data_type", "start_ts", "end_ts", "operation", "received_at", "attempts"],
      ["data_type", "start_ts", "end_ts", "operation"],
      types.map((type) => [type, start, end, "UPSERT", now, 0])),
    ...upsertStatements(db, "sync_state", ["data_type", "synced_until"], ["data_type"],
      types.map((type) => [type, end])),
  ]);
  return types.length;
}

/** Queue a catch-up pull when Google's watch sync is over an hour ahead of the newest stored gh HR minute; at most once per 3 h. */
export async function enqueueLagPull(db: D1Database, now: number, lastSync: number): Promise<number> {
  const [{ results: hr }, { results: marker }, { results: busy }] = await db.batch<{ ts?: number; last_ok_at?: number | null; data_type?: string }>([
    db.prepare("SELECT ts FROM metric_minute WHERE metric = 'hr' AND source = 'gh' ORDER BY ts DESC LIMIT 1"),
    db.prepare("SELECT last_ok_at FROM sync_state WHERE data_type = 'lag_pull'"),
    db.prepare("SELECT DISTINCT data_type FROM sync_pending WHERE attempts < 5"),
  ]);
  const newest = hr[0]?.ts ?? null;
  if (newest !== null && lastSync - newest <= 3600) return 0;
  const last = marker[0]?.last_ok_at ?? null;
  if (last !== null && now - last < 3 * 3600) return 0;
  const pending = new Set(busy.map((row) => row.data_type));
  const types = RECONCILE_TYPES.filter((type) => !pending.has(type));
  if (!types.length) return 0;

  const start = Math.floor(Math.max(newest ?? -Infinity, lastSync - 48 * 3600) / 60) * 60;
  const end = Math.ceil(lastSync / 60) * 60 + 60;
  await db.batch([
    ...upsertStatements(db, "sync_pending",
      ["data_type", "start_ts", "end_ts", "operation", "received_at", "attempts"],
      ["data_type", "start_ts", "end_ts", "operation"],
      types.map((type) => [type, start, end, "UPSERT", now, 0])),
    ...upsertStatements(db, "sync_state", ["data_type", "last_ok_at"], ["data_type"], [["lag_pull", now]]),
  ]);
  return types.length;
}
