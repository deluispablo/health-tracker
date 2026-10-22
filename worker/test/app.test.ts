import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleScheduled, route } from "../src/app";
import * as googleClient from "../src/google/client";
import { encryptSecret } from "../src/lib/crypto";
import { dateTimeFormat } from "../src/lib/time";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T04:30:27Z");
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const appEnv = () => ({
  DB: env.DB, OAUTH_KV: env.OAUTH_KV, USER_TZ: "Europe/Madrid", WEBHOOK_SECRET: "Bearer hook-secret-0123456789",
  GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", ALLOWED_EMAIL: "owner@example.com", TOKEN_ENC_KEY: KEY,
  WATCH_TOKEN: "watch-token-0123456789abcdef0123456789",
});

interface Call { url: string; method: string; body: string }
function google(rollup: unknown[] = [], lastSyncTime: string | null = "2026-10-21T04:00:00Z") {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, body: await req.text() });
    if (req.url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "at", expires_in: 3599 });
    if (req.url.endsWith("dataPoints:rollUp")) return Response.json({ rollupDataPoints: rollup });
    if (req.url.endsWith("/pairedDevices")) return Response.json({ pairedDevices: lastSyncTime === null ? []
      : [{ deviceVersion: "Pixel Watch 3", lastSyncTime }] });
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, calls };
}
const deps = (fetch: typeof globalThis.fetch) => ({ fetch, now: () => NOW, sleep: () => Promise.resolve() });

async function storeRefreshToken() {
  const { iv, ciphertext } = await encryptSecret(KEY, "refresh-token");
  await env.DB.prepare("INSERT INTO secret_blob (name, iv, ciphertext, updated_at) VALUES ('google_refresh_token', ?, ?, 1)")
    .bind(new Uint8Array(iv), new Uint8Array(ciphertext)).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch(["rollup_dirty", "sync_pending", "sync_state", "metric_minute", "metric_daily", "daily_summary", "tracker_daily", "event", "secret_blob", "oauth_state", "audit_log", "analysis_log"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const { keys } = await env.OAUTH_KV.list();
  await Promise.all(keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("T31 idle cron", () => {
  it.each([false, true])("AC2/AC4 skips token reads, client construction and fetch while completing rollups (exhausted: %s)", async (exhausted) => {
    await storeRefreshToken();
    if (exhausted) await env.DB.prepare(`INSERT INTO sync_pending
      (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES ('heart-rate', 0, 60, 'UPSERT', 1, 5)`).run();
    await env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at)
      VALUES ('idle', 'caffeine', ?, 120, '2026-10-21', 80, 'mcp', ?)`).bind(NOW, NOW).run();
    const now = NOW + 300;
    expect(Math.floor(now / 300) % 6).not.toBe(0);
    const tokenReads: string[] = [];
    const db = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => {
        if (/\bSELECT\b/i.test(sql) && /\bsecret_blob\b/i.test(sql)) tokenReads.push(sql);
        return t.prepare(sql);
      };
      const value: unknown = Reflect.get(t, p);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    } });
    const createClient = vi.spyOn(googleClient, "createGoogleClient");
    const g = google();
    try {
      await handleScheduled("*/5 * * * *", { ...appEnv(), DB: db }, { ...deps(g.fetch), now: () => now });
      expect(tokenReads).toEqual([]);
      expect(createClient).not.toHaveBeenCalled();
      expect(g.calls).toEqual([]);
      expect(await env.DB.prepare("SELECT local_date, computed_at FROM daily_summary").first())
        .toEqual({ local_date: "2026-10-21", computed_at: now });
      expect(await env.DB.prepare("SELECT local_date, total FROM tracker_daily").first())
        .toBeNull();
      expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first("n")).toBe(exhausted ? 1 : 0);
    } finally { createClient.mockRestore(); }
  });

  it("AC4 drains all ten types in order on a busy non-watch tick", async () => {
    await storeRefreshToken();
    const types = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability",
      "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "exercise"];
    await env.DB.batch([...types].reverse().map((type) => env.DB.prepare(`INSERT INTO sync_pending
      (data_type, start_ts, end_ts, operation, received_at) VALUES (?, ?, ?, 'UPSERT', ?)`)
      .bind(type, NOW - 120, NOW - 60, NOW - 30)));
    const g = google();
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://oauth2.googleapis.com/token") return g.fetch(input, init);
      requests.push(new URL(request.url).pathname);
      return Promise.resolve(Response.json({ rollupDataPoints: [], dataPoints: [] }));
    };
    await handleScheduled("*/5 * * * *", appEnv(), { ...deps(fetch), now: () => NOW + 300 });
    expect(requests.map((path) => /\/dataTypes\/([^/]+)/.exec(path)?.[1])).toEqual([types[0], "steps", ...types.slice(1)]);
    expect(requests.filter((path) => path.includes("/steps/"))).toEqual([
      "/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp", "/v4/users/me/dataTypes/steps/dataPoints:rollUp",
    ]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM daily_summary").first("n")).toBe(2);
  });

  it("AC3 reuses the shared civil-date formatter across ticks", async () => {
    dateTimeFormat("en-US", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
    const constructor = vi.spyOn(Intl, "DateTimeFormat");
    try {
      for (let i = 1; i <= 2; i++) {
        await handleScheduled("*/5 * * * *", appEnv(), { ...deps(google().fetch), now: () => NOW + i * 300 });
      }
      expect(constructor).not.toHaveBeenCalled();
    } finally { constructor.mockRestore(); }
  });
});

describe("AC1 five-minute cron", () => {
  it("drains the queue with the stored token, then recomputes the touched dates through today", async () => {
    await storeRefreshToken();
    await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES ('heart-rate', ?, ?, 'UPSERT', ?)")
      .bind(at("2026-10-20T21:00:00Z"), at("2026-10-20T21:01:00Z"), NOW - 60).run();
    const g = google([{ startTime: "2026-10-20T21:00:00Z", endTime: "2026-10-20T21:01:00Z", heartRate: { beatsPerMinuteAvg: 61, beatsPerMinuteMin: 60, beatsPerMinuteMax: 62 } }]);
    await handleScheduled("*/5 * * * *", appEnv(), deps(g.fetch));
    expect(g.calls.map((c) => new URL(c.url).pathname)).toEqual(["/token", "/v4/users/me/dataTypes/heart-rate/dataPoints:rollUp", "/v4/users/me/pairedDevices"]);
    expect(await env.DB.prepare("SELECT * FROM sync_state WHERE data_type = 'watch'").first()).toEqual({
      data_type: "watch", synced_until: at("2026-10-21T04:00:00Z"), last_ok_at: NOW, last_error: null,
    });
    expect((await env.DB.prepare("SELECT metric, ts, value FROM metric_minute").all()).results).toEqual([{ metric: "hr", ts: at("2026-10-20T21:00:00Z"), value: 61 }]);
    expect((await env.DB.prepare("SELECT local_date, hr_wear_min, computed_at FROM daily_summary ORDER BY local_date").all()).results).toEqual([
      { local_date: "2026-10-20", hr_wear_min: 1, computed_at: NOW },
      { local_date: "2026-10-21", hr_wear_min: 0, computed_at: NOW }]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first()).toEqual({ n: 0 });
  });

  it("skips Google entirely without a stored token but still recomputes", async () => {
    await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES ('heart-rate', 0, 60, 'UPSERT', 1)").run();
    const g = google();
    await handleScheduled("*/5 * * * *", appEnv(), deps(g.fetch));
    expect(g.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM daily_summary").first()).toEqual({ n: 1 });
  });

  it("uses the local date of USER_TZ: just after local midnight the window moves forward", async () => {
    // 22:30Z on 20 Oct is 00:30 on 21 Oct in Madrid.
    await handleScheduled("*/5 * * * *", appEnv(), { ...deps(google().fetch), now: () => at("2026-10-20T22:30:00Z") });
    expect((await env.DB.prepare("SELECT local_date FROM daily_summary ORDER BY local_date").all()).results.map((r) => r.local_date))
      .toEqual(["2026-10-21"]);
  });

  it("rejects and skips the summaries when the stored token cannot be decrypted", async () => {
    await storeRefreshToken();
    const g = google();
    await expect(handleScheduled("*/5 * * * *", { ...appEnv(), TOKEN_ENC_KEY: btoa(String.fromCharCode(...new Uint8Array(32))) }, deps(g.fetch))).rejects.toThrow();
    expect(g.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM daily_summary").first()).toEqual({ n: 0 });
  });

  it("propagates a drain failure so the run is marked failed", async () => {
    await storeRefreshToken();
    await env.DB.prepare("CREATE TRIGGER fail_q BEFORE UPDATE ON sync_pending BEGIN SELECT RAISE(ABORT, 'x'); END").run();
    await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES ('heart-rate', 0, 60, 'UPSERT', 1)").run();
    const failing = async () => Promise.resolve(new Response("down", { status: 503 }));
    try {
      await expect(handleScheduled("*/5 * * * *", appEnv(), deps(failing))).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_q").run();
    }
  });
});

describe("T10e AC1/AC2 watch sync in the five-minute cron", () => {
  const previous = { data_type: "watch", synced_until: NOW - 7200, last_ok_at: NOW - 1800, last_error: "previous error" };
  const other = { data_type: "sleep", synced_until: 123, last_ok_at: 456, last_error: "unrelated" };
  const state = () => env.DB.prepare("SELECT * FROM sync_state WHERE data_type = 'watch'").first();
  const seedWatch = () => env.DB.prepare("INSERT INTO sync_state (data_type, synced_until, last_ok_at, last_error) VALUES (?, ?, ?, ?)")
    .bind(previous.data_type, previous.synced_until, previous.last_ok_at, previous.last_error).run();

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sync_state (data_type, synced_until, last_ok_at, last_error) VALUES (?, ?, ?, ?)")
        .bind(other.data_type, other.synced_until, other.last_ok_at, other.last_error),
      env.DB.prepare("INSERT INTO metric_daily (metric, local_date, value, updated_at) VALUES ('steps', '2026-10-21', 8123, 1)"),
      env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at)
        VALUES ('watch-rollup', 'caffeine', ?, 120, '2026-10-21', 80, 'mcp', ?)`).bind(NOW, NOW),
    ]);
  });

  async function rollupsCompleted(now = NOW) {
    expect((await env.DB.prepare("SELECT local_date, steps, computed_at FROM daily_summary ORDER BY local_date").all()).results).toEqual([
      { local_date: "2026-10-21", steps: 8123, computed_at: now },
    ]);
    expect((await env.DB.prepare("SELECT local_date, tracker_id, total, n FROM tracker_daily").all()).results)
      .toEqual([]);
    expect(await env.DB.prepare("SELECT * FROM sync_state WHERE data_type = 'sleep'").first()).toEqual(other);
  }

  it.each(["2026-10-21T04:30:00Z", "2026-10-21T04:30:27Z", "2026-10-21T04:34:59Z", "2026-10-21T05:00:27Z"])(
    "samples throughout a due five-minute bucket at %s, honours offsets and floors fractional seconds", async (iso) => {
      await storeRefreshToken();
      const instant = "2026-10-21T08:15:09.987+05:30";
      const g = google([], instant);
      const now = at(iso);
      await handleScheduled("*/5 * * * *", appEnv(), { ...deps(g.fetch), now: () => now });
      expect(g.calls.filter((c) => new URL(c.url).pathname.endsWith("/pairedDevices"))).toHaveLength(1);
      expect(await state()).toEqual({ data_type: "watch", synced_until: Math.floor(Date.parse(instant) / 1000), last_ok_at: now, last_error: null });
      await rollupsCompleted(now);
    },
  );

  it.each(["2026-10-21T04:29:59Z", "2026-10-21T04:35:00Z", "2026-10-21T04:59:59Z"])(
    "preserves every watch column and makes no pairedDevices request on a non-due run at %s", async (iso) => {
      await storeRefreshToken();
      await seedWatch();
      const g = google();
      const now = at(iso);
      await handleScheduled("*/5 * * * *", appEnv(), { ...deps(g.fetch), now: () => now });
      expect(g.calls).toEqual([]);
      expect(await state()).toEqual(previous);
      await rollupsCompleted(now);
    },
  );

  it("preserves every watch column on a due run without a token", async () => {
    await seedWatch();
    const g = google();
    await handleScheduled("*/5 * * * *", appEnv(), deps(g.fetch));
    expect(g.calls).toEqual([]);
    expect(await state()).toEqual(previous);
    await rollupsCompleted();
  });

  it("replaces success, preserves it on failure, recovers and clears it on a null result", async () => {
    await storeRefreshToken();
    await seedWatch();
    const first = "2026-10-21T04:15:00Z";
    await handleScheduled("*/5 * * * *", appEnv(), deps(google([], first).fetch));
    expect(await state()).toEqual({ data_type: "watch", synced_until: at(first), last_ok_at: NOW, last_error: null });
    const failure = new Error("watch's \"private\" failure " + "x".repeat(210));
    const failFetch: typeof fetch = () => Promise.reject(failure);
    await handleScheduled("*/5 * * * *", appEnv(), { ...deps(failFetch), now: () => NOW + 1800 });
    expect(await state()).toEqual({ data_type: "watch", synced_until: at(first), last_ok_at: NOW, last_error: failure.message.slice(0, 200) });
    await rollupsCompleted();
    const recovered = "2026-10-21T05:15:00Z";
    await handleScheduled("*/5 * * * *", appEnv(), { ...deps(google([], recovered).fetch), now: () => NOW + 3600 });
    expect(await state()).toEqual({ data_type: "watch", synced_until: at(recovered), last_ok_at: NOW + 3600, last_error: null });
    await handleScheduled("*/5 * * * *", appEnv(), { ...deps(google([], null).fetch), now: () => NOW + 5400 });
    expect(await state()).toEqual({ data_type: "watch", synced_until: null, last_ok_at: NOW + 5400, last_error: null });
    await rollupsCompleted();
  });

  it("stores a successful null result on the first watch lookup", async () => {
    await storeRefreshToken();
    const g = google([], null);
    await handleScheduled("*/5 * * * *", appEnv(), deps(g.fetch));
    expect(await state()).toEqual({ data_type: "watch", synced_until: null, last_ok_at: NOW, last_error: null });
    await rollupsCompleted();
  });

  it.each([
    new Error("watch's \"failure\" " + "e".repeat(210)),
    "watch's \"rejected string\" " + "s".repeat(210),
    42,
  ])("creates only error state on a first-call rejection: %s", async (failure) => {
    await storeRefreshToken();
    const g = google();
    const fetch: typeof globalThis.fetch = (input, init) => new Request(input, init).url.endsWith("/pairedDevices")
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- The spec requires handling non-Error rejections.
      ? Promise.reject(failure) : g.fetch(input, init);
    await handleScheduled("*/5 * * * *", appEnv(), deps(fetch));
    await rollupsCompleted();
    expect(await state()).toEqual({ data_type: "watch", synced_until: null, last_ok_at: null,
      last_error: String(failure instanceof Error ? failure.message : failure).slice(0, 200) });
  });

  it.each(["not-a-date", "invalid 'quoted' \"timestamp\" " + "x".repeat(210)])(
    "preserves prior state and records the specified error for an unparseable lastSyncTime: %s", async (value) => {
      await storeRefreshToken();
      await seedWatch();
      await handleScheduled("*/5 * * * *", appEnv(), deps(google([], value).fetch));
      await rollupsCompleted();
      expect(await state()).toEqual({ ...previous, last_error: `invalid lastSyncTime: ${value}`.slice(0, 200) });
    },
  );

  it.each([false, true])("logs a watch upsert failure and still completes daily rollups (lookup rejects: %s)", async (reject) => {
    await storeRefreshToken();
    await seedWatch();
    await env.DB.prepare(`CREATE TRIGGER fail_watch_write BEFORE INSERT ON sync_state
      WHEN NEW.data_type = 'watch' BEGIN SELECT RAISE(ABORT, 'watch write unavailable'); END`).run();
    const g = google();
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = new Request(input, init).url;
      calls.push(url);
      return reject && url.endsWith("/pairedDevices") ? Promise.reject(new Error("watch lookup failed")) : g.fetch(input, init);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleScheduled("*/5 * * * *", appEnv(), deps(fetch));
      await rollupsCompleted();
      expect(await state()).toEqual(previous);
      expect(log).toHaveBeenCalledExactlyOnceWith("watch persistence", expect.stringContaining("watch write unavailable"));
      expect(calls.filter((url) => url.endsWith("/pairedDevices"))).toHaveLength(1);
    } finally {
      log.mockRestore();
      await env.DB.prepare("DROP TRIGGER fail_watch_write").run();
    }
  });
});

describe("AC2 daily cron", () => {
  it.each(["2026-10-21T04:30:27Z", "2026-10-20T22:30:00Z"])(
    "repairs exactly the last eight local dates at %s, removing stale and deleted totals", async (iso) => {
      const dates = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 13)}`);
      await env.DB.batch(dates.flatMap((date) => [
        env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at, deleted_at)
          VALUES (?, 'caffeine', ?, 120, ?, 80, 'mcp', ?, ?)`)
          .bind(date, NOW, date, NOW, date === "2026-10-17" ? NOW : null),
        env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, 'caffeine', 1, 1, 0)").bind(date),
      ]));
      const g = google();
      await handleScheduled("30 4 * * *", appEnv(), { ...deps(g.fetch), now: () => at(iso) });
      expect((await env.DB.prepare("SELECT local_date, total, n FROM tracker_daily ORDER BY local_date").all()).results)
        .toEqual(dates.filter((date) => date !== "2026-10-17").map((local_date) => ({
          local_date, total: ["2026-10-13", "2026-10-22"].includes(local_date) ? 1 : 80, n: 1,
        })));
      expect(g.calls).toEqual([]);
    },
  );

  it("T30 AC1 prunes audit rows older than 90 days, keeping the cutoff and newer rows", async () => {
    await env.DB.prepare("INSERT INTO audit_log (ts, kind) VALUES (?, 'auth'), (?, 'tool'), (?, 'tool')")
      .bind(NOW - 91 * 86400, NOW - 90 * 86400, NOW - 89 * 86400).run();
    await handleScheduled("30 4 * * *", appEnv(), deps(google().fetch));
    expect((await env.DB.prepare("SELECT ts FROM audit_log ORDER BY ts").all()).results)
      .toEqual([{ ts: NOW - 90 * 86400 }, { ts: NOW - 89 * 86400 }]);
  });

  it("daily cron deletes analysis_log rows older than 90 days in milliseconds", async () => {
    const cutoff = (NOW - 90 * 86400) * 1000;
    await env.DB.prepare("INSERT INTO analysis_log (ts, tool, tests) VALUES (?, 'health_scan', 1), (?, 'health_scan', 2), (?, 'health_scan', 3)")
      .bind(cutoff - 1, cutoff, cutoff + 1).run();
    await handleScheduled("30 4 * * *", appEnv(), deps(google().fetch));
    expect((await env.DB.prepare("SELECT ts FROM analysis_log ORDER BY ts").all()).results)
      .toEqual([{ ts: cutoff }, { ts: cutoff + 1 }]);
  });

  it("enqueues the 48-hour reconcile, purges expired OAuth states and does not call Google", async () => {
    await env.DB.prepare("INSERT INTO oauth_state (state, verifier, expires_at) VALUES ('old', 'v', ?), ('edge', 'v', ?), ('live', 'v', ?)")
      .bind(NOW - 1, NOW, NOW + 600).run();
    const g = google();
    await handleScheduled("30 4 * * *", appEnv(), deps(g.fetch));
    expect(g.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first()).toEqual({ n: 10 });
    expect((await env.DB.prepare("SELECT state FROM oauth_state ORDER BY state").all()).results).toEqual([{ state: "edge" }, { state: "live" }]);
  });

  it("rejects an unknown cron expression", async () => {
    await expect(handleScheduled("0 0 * * *", appEnv(), deps(google().fetch))).rejects.toThrow();
  });
});

describe("AC3 routes", () => {
  const req = (method: string, path: string, init: RequestInit = {}) => new Request(`https://health.example.com${path}`, { method, ...init });

  it("sends Google webhooks to the webhook handler (Authorization checked first)", async () => {
    const res = await route(req("POST", "/webhooks/google", { body: "[]" }), appEnv(), deps(google().fetch));
    expect(res.status).toBe(401);
    const ok = await route(req("POST", "/webhooks/google", { body: '{"type":"verification"}', headers: { authorization: "Bearer hook-secret-0123456789" } }),
      appEnv(), deps(google().fetch));
    expect(ok.status).toBe(200);
  });

  it("starts and finishes the Google connect flow", async () => {
    const start = await route(req("GET", "/google/connect"), appEnv(), deps(google().fetch));
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location") ?? "").searchParams.get("redirect_uri")).toBe("https://health.example.com/google/callback");
    const back = await route(req("GET", "/google/callback?state=nope&code=x"), appEnv(), deps(google().fetch));
    expect(back.status).toBe(400);
  });

  it("answers 405 for a wrong method on a known path and 404 elsewhere", async () => {
    for (const [method, path] of [["GET", "/webhooks/google"], ["POST", "/google/connect"], ["POST", "/google/callback"]] as const) {
      expect((await route(req(method, path), appEnv(), deps(google().fetch))).status).toBe(405);
    }
    for (const path of ["/privacy/", "/privacy/x", "/unknown", "/webhooks", "/google", "/webhooks/google/x", "/mcp"]) {
      expect((await route(req("GET", path), appEnv(), deps(google().fetch))).status).toBe(404);
    }
  });
});

describe("T20 public pages", () => {
  const getPage = (path: string, method = "GET") => route(
    new Request(`https://health.example.com${path}`, { method }), appEnv(), deps(google().fetch),
  );

  it("AC1 serves the Spanish private single-user homepage with a privacy link", async () => {
    const res = await getPage("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const text of ['lang="es"', "Health Tracker", "privado", "datos de salud personales", "único usuario", 'href="/privacy"', 'href="/terms"']) {
      expect(html).toContain(text);
    }
  });

  it("AC2 serves the complete privacy policy", async () => {
    const res = await getPage("/privacy");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const text of [
      "único usuario personal: su propio desarrollador", "Google Health", "solo lectura",
      "cuenta de Cloudflare del propio propietario", "eventos que registra el propietario: café, alcohol y tabaco",
      "solo salen hacia el asistente que conectes y autorices", "cuando tú, como propietario, lo solicites",
      "nunca se venden, se comparten ni se utilizan para publicidad", "revocar el acceso",
      'href="https://myaccount.google.com/permissions"', "owner@example.com",
    ]) expect(html).toContain(text);
  });

  it("serves the brand icon as a PNG favicon", async () => {
    const res = await getPage("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves the terms of service", async () => {
    const res = await getPage("/terms");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const text of [
      "Condiciones de servicio", "único usuario", "nadie más puede iniciar sesión", "No es un producto sanitario",
      "sin garantías", 'href="/privacy"', 'href="https://myaccount.google.com/permissions"', "owner@example.com",
    ]) expect(html).toContain(text);
  });

  it.each(["/", "/privacy", "/terms"])("AC3/AC4 serves GET and bodyless HEAD with matching cache and security headers at %s", async (path) => {
    const get = await getPage(path);
    const head = await getPage(path, "HEAD");
    expect(head.status).toBe(get.status);
    expect(await head.text()).toBe("");
    expect([...head.headers]).toEqual([...get.headers]);
    expect(get.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(get.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const html = await get.text();
    expect(html).not.toMatch(/<script\b|<(?:link|img|iframe)\b|\bsrc=/i);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("AC3 rejects %s on both pages", async (method) => {
    for (const path of ["/", "/privacy", "/terms"]) {
      expect((await getPage(path, method)).status).toBe(405);
    }
  });
});
