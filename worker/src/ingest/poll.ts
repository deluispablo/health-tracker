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
