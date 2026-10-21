import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { finishGoogleConnect, loadGoogleRefreshToken, startGoogleConnect } from "./auth/googleHealthConnect";
import { createGoogleClient } from "./google/client";
import { drainSyncPending } from "./ingest/drain";
import { enqueueReconcile } from "./ingest/poll";
import { handleGoogleWebhook } from "./ingest/webhook";
import { homepage, pageResponse, privacy } from "./pages";
import { recomputeDailySummary } from "./rollup/daily";
import { recomputeTrackerDaily } from "./rollup/trackers";

export interface AppEnv {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  USER_TZ: string;
  WEBHOOK_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAIL: string;
  TOKEN_ENC_KEY: string;
}

export interface AppDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ConnectorEnv extends AppEnv {
  PUBLIC_ORIGIN: string;
  OAUTH_PROVIDER?: OAuthHelpers;
}

const KEYSET_URL = "https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json";

export async function handleScheduled(cron: string, env: AppEnv, deps: AppDeps): Promise<void> {
  const now = deps.now();
  if (cron === "30 4 * * *") {
    await enqueueReconcile(env.DB, now);
    await env.DB.prepare("DELETE FROM oauth_state WHERE expires_at < ?").bind(now).run();
    return;
  }
  if (cron !== "*/5 * * * *") throw new Error(`Unknown cron: ${cron}`);

  const refreshToken = await loadGoogleRefreshToken(env);
  if (refreshToken !== null) {
    const client = createGoogleClient({
      fetch: deps.fetch, kv: env.OAUTH_KV, clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken, sleep: deps.sleep,
    });
    await drainSyncPending(env, client, { now: () => now });
    if (Math.floor(now / 300) % 6 === 0) {
      try {
        let syncedUntil: number | null = null;
        let lastError: string | null = null;
        try {
          const lastSyncTime = await client.watchLastSync();
          if (lastSyncTime !== null) {
            const parsed = Date.parse(lastSyncTime);
            if (!Number.isFinite(parsed)) throw new Error(`invalid lastSyncTime: ${lastSyncTime}`);
            syncedUntil = Math.floor(parsed / 1000);
          }
        } catch (error) {
          lastError = String(error instanceof Error ? error.message : error).slice(0, 200);
        }
        await env.DB.prepare(`
          INSERT INTO sync_state (data_type, synced_until, last_ok_at, last_error) VALUES ('watch', ?, ?, ?)
          ON CONFLICT (data_type) DO UPDATE SET
            synced_until = CASE WHEN excluded.last_error IS NULL THEN excluded.synced_until ELSE sync_state.synced_until END,
            last_ok_at = CASE WHEN excluded.last_error IS NULL THEN excluded.last_ok_at ELSE sync_state.last_ok_at END,
            last_error = excluded.last_error
        `).bind(syncedUntil, lastError === null ? now : null, lastError).run();
      } catch { /* Watch persistence failures must not skip the rollups. */ }
    }
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: env.USER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now * 1000);
  const today = ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
  const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  await env.DB.prepare(`DELETE FROM rollup_dirty WHERE (
    local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(local_date, '+0 days') = local_date AND local_date BETWEEN '2000-01-01' AND '2099-12-31'
  ) IS NOT TRUE`).run();
  const { results: dirty } = await env.DB.prepare("SELECT local_date, version FROM rollup_dirty WHERE local_date <= ? ORDER BY local_date")
    .bind(today).all<{ local_date: string; version: number }>();
  const dates = dirty.map((row) => row.local_date);
  if (!await env.DB.prepare("SELECT 1 FROM daily_summary WHERE local_date = ?").bind(today).first()) dates.push(today);
  if (dates.length) {
    const from = dates[0];
    const to = [addDays(dates[dates.length - 1], 28), today, addDays(from, 365)].sort()[0];
    await recomputeDailySummary(env.DB, from, to, now);
    // Clear only complete score tails whose versions still match the pre-recompute snapshot.
    const cleared = dirty.filter((row) => {
      const tail = addDays(row.local_date, 28);
      return (tail < today ? tail : today) <= to;
    });
    await env.DB.prepare(`DELETE FROM rollup_dirty WHERE (local_date, version) IN (
      SELECT json_extract(value, '$.local_date'), json_extract(value, '$.version') FROM json_each(?)
    )`).bind(JSON.stringify(cleared)).run();
  }
  await recomputeTrackerDaily(env.DB, addDays(today, -2), today);
}

export async function route(request: Request, env: AppEnv, deps: AppDeps): Promise<Response> {
  switch (new URL(request.url).pathname) {
    case "/":
      return pageResponse(request, homepage);
    case "/privacy":
      return pageResponse(request, privacy);
    case "/webhooks/google":
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return handleGoogleWebhook(request, env, {
        keyset: async () => (await deps.fetch(KEYSET_URL)).json(), now: deps.now,
      });
    case "/google/connect":
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return startGoogleConnect(request, env, deps);
    case "/google/callback":
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return finishGoogleConnect(request, env, deps);
    default:
      return new Response(null, { status: 404 });
  }
}
