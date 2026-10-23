import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as drain from "../../src/ingest/drain";
import { encryptSecret } from "../../src/lib/crypto";
import { healthRefresh } from "../../src/mcp/tools/refresh";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-23T10:00:30Z");
const END = at("2026-10-23T10:02:00Z"); // now rounded up to the minute + 60 s
const START = END - 86400;
const MINUTE_BEFORE_NOW = at("2026-10-23T09:59:00Z");
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 3)));
const appEnv = () => ({
  DB: env.DB, OAUTH_KV: env.OAUTH_KV, USER_TZ: "Europe/Madrid", WEBHOOK_SECRET: "Bearer hook-secret-0123456789",
  GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", ALLOWED_EMAIL: "owner@example.com", TOKEN_ENC_KEY: KEY,
  WATCH_TOKEN: "watch-token-0123456789abcdef0123456789",
});
const TYPES = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability",
  "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "exercise"];

// Heart-rate points (epoch seconds) are answered only inside the requested range.
function google(points: number[] = []) {
  const calls: { path: string; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "at", expires_in: 3599 });
    const body = await req.text();
    calls.push({ path: new URL(req.url).pathname, body });
    if (req.url.endsWith("/heart-rate/dataPoints:rollUp")) {
      const { range } = JSON.parse(body) as { range: { startTime: string; endTime: string } };
      const [from, to] = [Date.parse(range.startTime), Date.parse(range.endTime)];
      return Response.json({ rollupDataPoints: points.map((ts) => ts * 1000).filter((ms) => ms >= from && ms < to).map((ms) => ({
        startTime: new Date(ms).toISOString(), heartRate: { beatsPerMinuteAvg: 70, beatsPerMinuteMin: 65, beatsPerMinuteMax: 75 },
      })) });
    }
    return Response.json({ rollupDataPoints: [], dataPoints: [] });
  };
  return { fetch, calls };
}
const deps = (fetch: typeof globalThis.fetch, now = NOW) => ({ fetch, now: () => now, sleep: () => Promise.resolve() });
const queue = async () => (await env.DB.prepare(
  "SELECT data_type, start_ts, end_ts, operation, received_at, attempts FROM sync_pending ORDER BY data_type, start_ts, operation").all()).results;
const marker = () => env.DB.prepare("SELECT last_ok_at FROM sync_state WHERE data_type = 'refresh'").first("last_ok_at");

async function storeRefreshToken() {
  const { iv, ciphertext } = await encryptSecret(KEY, "refresh-token");
  await env.DB.prepare("INSERT INTO secret_blob (name, iv, ciphertext, updated_at) VALUES ('google_refresh_token', ?, ?, 1)")
    .bind(new Uint8Array(iv), new Uint8Array(ciphertext)).run();
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["DROP TRIGGER IF EXISTS fail_refresh", ...["rollup_dirty", "sync_pending", "sync_state", "metric_minute", "metric_daily",
    "daily_summary", "secret_blob"].map((t) => `DELETE FROM ${t}`)].map((sql) => env.DB.prepare(sql)));
  const { keys } = await env.OAUTH_KV.list();
  await Promise.all(keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("RF1 health_refresh", () => {
  it("pulls the last 24 h of every type in one step, stores a rollUp point 1 minute before now, rolls up and reports it", async () => {
    await storeRefreshToken();
    const spy = vi.spyOn(drain, "drainSyncPending");
    const g = google([START - 60, START, START + 600 * 60, MINUTE_BEFORE_NOW]);
    try {
      expect(await healthRefresh(appEnv(), deps(g.fetch))).toEqual({
        throttled: false, processed: 10, failed: 0, pending: 0, latest_hr_local: "2026-10-23T11:59",
      });
      expect(spy.mock.calls[0][2]).toMatchObject({ deadlineMs: 20000 });
    } finally { spy.mockRestore(); }
    expect(g.calls.map((c) => /\/dataTypes\/([^/]+)/.exec(c.path)?.[1])).toEqual(expect.arrayContaining(TYPES));
    const hr = g.calls.find((c) => c.path.endsWith("/heart-rate/dataPoints:rollUp"));
    expect(JSON.parse(hr?.body ?? "{}")).toMatchObject({ range: { startTime: new Date(START * 1000).toISOString(),
      endTime: new Date(END * 1000).toISOString() } });
    expect(g.calls.filter((c) => c.path.endsWith("/heart-rate/dataPoints:rollUp"))).toHaveLength(1);
    expect(await env.DB.prepare("SELECT ts, tz_offset_min FROM metric_minute WHERE metric = 'hr' AND source = 'gh' ORDER BY ts").all())
      .toMatchObject({ results: [START, START + 600 * 60, MINUTE_BEFORE_NOW].map((ts) => ({ ts, tz_offset_min: 120 })) });
    expect(await queue()).toEqual([]);
    expect(await marker()).toBe(NOW);
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-10-23'").first("computed_at")).toBe(NOW);
  });

  it("throttles within 120 s without calling Google and allows the call at exactly 120 s", async () => {
    await storeRefreshToken();
    // A newer non-Google minute is ignored; an empty Google answer leaves latest_hr_local null.
    await env.DB.prepare("INSERT INTO metric_minute (metric, ts, tz_offset_min, value, source) VALUES ('hr', ?, 120, 60, 'watch')").bind(NOW - 60).run();
    expect(await healthRefresh(appEnv(), deps(google().fetch))).toMatchObject({ throttled: false, latest_hr_local: null });
    const g = google();
    expect(await healthRefresh(appEnv(), deps(g.fetch, NOW + 1))).toEqual({ throttled: true, retry_after_s: 119 });
    expect(await healthRefresh(appEnv(), deps(g.fetch, NOW + 119))).toEqual({ throttled: true, retry_after_s: 1 });
    expect(g.calls).toEqual([]);
    expect(await marker()).toBe(NOW);
    expect(await healthRefresh(appEnv(), deps(g.fetch, NOW + 120))).toMatchObject({ throttled: false });
    expect(g.calls.length).toBeGreaterThan(0);
    expect(await marker()).toBe(NOW + 120);
  });

  it("rejects when Google is not connected without queueing, throttling or calling Google", async () => {
    const g = google();
    await expect(healthRefresh(appEnv(), deps(g.fetch))).rejects.toThrow();
    expect(g.calls).toEqual([]);
    expect(await queue()).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_state").first("n")).toBe(0);
  });

  it("resets an identical window, leaves other windows and DELETE rows alone and counts only live rows as pending", async () => {
    await storeRefreshToken();
    const old = NOW - 3600;
    const seed = [
      ["steps", START, END, "UPSERT", old, 5],
      ["steps", START - 60, END, "UPSERT", old, 5],
      ["heart-rate", START, END, "DELETE", old, 5],
      ["weight", START, END, "UPSERT", old, 0], // live but never drained: counts as pending
    ];
    await env.DB.batch(seed.map((row) => env.DB.prepare(`INSERT INTO sync_pending
      (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES (?, ?, ?, ?, ?, ?)`).bind(...row)));
    expect(await healthRefresh(appEnv(), deps(google().fetch))).toMatchObject({ processed: 10, failed: 0, pending: 1 });
    expect(await queue()).toEqual([
      { data_type: "heart-rate", start_ts: START, end_ts: END, operation: "DELETE", received_at: old, attempts: 5 },
      { data_type: "steps", start_ts: START - 60, end_ts: END, operation: "UPSERT", received_at: old, attempts: 5 },
      { data_type: "weight", start_ts: START, end_ts: END, operation: "UPSERT", received_at: old, attempts: 0 },
    ]);
  });

  it("drains only its own window, leaving an older pending heart-rate row received earlier", async () => {
    await storeRefreshToken();
    const old = [NOW - 3 * 86400, NOW - 2 * 86400];
    await env.DB.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts)
      VALUES ('heart-rate', ?, ?, 'UPSERT', ?, 0)`).bind(old[0], old[1], NOW - 600).run();
    const spy = vi.spyOn(drain, "drainSyncPending");
    try {
      expect(await healthRefresh(appEnv(), deps(google([old[0], MINUTE_BEFORE_NOW]).fetch)))
        .toMatchObject({ processed: 10, failed: 0, pending: 1, latest_hr_local: "2026-10-23T11:59" });
      expect(spy.mock.calls[0][2]).toMatchObject({ window: { start: START, end: END } });
    } finally { spy.mockRestore(); }
    expect(await queue()).toEqual([
      { data_type: "heart-rate", start_ts: old[0], end_ts: old[1], operation: "UPSERT", received_at: NOW - 600, attempts: 0 },
    ]);
    expect(await env.DB.prepare("SELECT ts FROM metric_minute WHERE metric = 'hr' AND source = 'gh'").all())
      .toMatchObject({ results: [{ ts: MINUTE_BEFORE_NOW }] });
  });

  it.each(["sync_pending", "sync_state"])("rolls back the queue and the marker together when the %s write fails", async (table) => {
    await storeRefreshToken();
    await env.DB.prepare(`CREATE TRIGGER fail_refresh BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'write failed'); END`).run();
    const g = google();
    await expect(healthRefresh(appEnv(), deps(g.fetch))).rejects.toThrow();
    expect(g.calls).toEqual([]);
    expect(await queue()).toEqual([]);
    expect(await marker()).toBeNull();
  });
});
