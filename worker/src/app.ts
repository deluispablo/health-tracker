import { finishGoogleConnect, loadGoogleRefreshToken, startGoogleConnect } from "./auth/googleHealthConnect";
import { createGoogleClient } from "./google/client";
import { drainSyncPending } from "./ingest/drain";
import { enqueueReconcile } from "./ingest/poll";
import { handleGoogleWebhook } from "./ingest/webhook";
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
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: env.USER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now * 1000);
  const to = ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
  await recomputeDailySummary(env.DB, from, to, now);
  await recomputeTrackerDaily(env.DB, from, to);
}

export async function route(request: Request, env: AppEnv, deps: AppDeps): Promise<Response> {
  switch (new URL(request.url).pathname) {
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
