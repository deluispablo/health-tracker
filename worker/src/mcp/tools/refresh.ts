import { rollupDirty } from "../../app";
import type { AppDeps, AppEnv } from "../../app";
import { loadGoogleRefreshToken } from "../../auth/googleHealthConnect";
import { createGoogleClient } from "../../google/client";
import { drainSyncPending } from "../../ingest/drain";
import { RECONCILE_TYPES } from "../../ingest/poll";
import { upsertStatements } from "../../lib/d1";

const COOLDOWN_S = 120;

/** Queue the last 24 h of every type, drain what fits in ~20 s and roll up; at most once per 120 s. */
export async function healthRefresh(env: AppEnv, deps: AppDeps) {
  const now = deps.now();
  const db = env.DB;
  const last = await db.prepare("SELECT last_ok_at FROM sync_state WHERE data_type = 'refresh'").first<number | null>("last_ok_at");
  if (last !== null && now - last < COOLDOWN_S) return { throttled: true, retry_after_s: Math.ceil(COOLDOWN_S - (now - last)) };

  const refreshToken = await loadGoogleRefreshToken(env);
  if (refreshToken === null) throw new Error("Google not connected");

  const end = Math.ceil(now / 60) * 60 + 60;
  const start = end - 86400; // exactly one heart-rate drain step, so the newest minute lands in this call
  await db.batch([
    ...upsertStatements(db, "sync_pending",
      ["data_type", "start_ts", "end_ts", "operation", "received_at", "attempts"],
      ["data_type", "start_ts", "end_ts", "operation"],
      RECONCILE_TYPES.map((type) => [type, start, end, "UPSERT", now, 0])),
    ...upsertStatements(db, "sync_state", ["data_type", "last_ok_at"], ["data_type"], [["refresh", now]]),
  ]);

  const client = createGoogleClient({
    fetch: deps.fetch, kv: env.OAUTH_KV, clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken, sleep: deps.sleep,
  });
  // Soft budget: checked between rows, so a slow Google retry can overrun it.
  const { processed, failed } = await drainSyncPending(env, client, { now: () => now, deadlineMs: 20_000 });
  await rollupDirty(env, now);

  const [queue, hr] = await db.batch([
    db.prepare("SELECT count(*) AS n FROM sync_pending WHERE attempts < 5"),
    db.prepare("SELECT ts, tz_offset_min FROM metric_minute WHERE metric = 'hr' AND source = 'gh' ORDER BY ts DESC LIMIT 1"),
  ]);
  const newest = hr.results.at(0) as { ts: number; tz_offset_min: number } | undefined;
  return {
    throttled: false, processed, failed, pending: (queue.results[0] as { n: number }).n,
    latest_hr_local: newest === undefined ? null
      : new Date((newest.ts + newest.tz_offset_min * 60) * 1000).toISOString().slice(0, 16),
  };
}
