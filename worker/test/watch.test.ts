import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { route } from "../src/app";

const TOKEN = "watch-token-0123456789abcdef0123456789";
const NOW = Date.parse("2026-10-21T20:00:00Z") / 1000;
// Madrid is UTC+2 on 2026-10-21.
const local = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - 7200;
const appEnv = () => ({
  DB: env.DB, OAUTH_KV: env.OAUTH_KV, USER_TZ: "Europe/Madrid", WEBHOOK_SECRET: "Bearer hook-secret-0123456789",
  GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", ALLOWED_EMAIL: "owner@example.com", TOKEN_ENC_KEY: "key", WATCH_TOKEN: TOKEN,
});
const get = (authorization?: string, method = "GET") => route(
  new Request("https://example.com/watch/today", { method, headers: authorization === undefined ? {} : { authorization } }),
  appEnv(), { fetch, now: () => NOW, sleep: () => Promise.resolve() },
);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch(["sleep_stage", "sleep_session", "workout", "event", "metric_minute"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("GET /watch/today", () => {
  it("rejects missing token", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  it("rejects same-length wrong token", async () => {
    const res = await get(`Bearer ${TOKEN.slice(0, -1)}x`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  it("rejects a short configured token and non-GET", async () => {
    const short = await route(new Request("https://example.com/watch/today", { headers: { authorization: "Bearer short" } }),
      { ...appEnv(), WATCH_TOKEN: "short" }, { fetch, now: () => NOW, sleep: () => Promise.resolve() });
    expect(short.status).toBe(401);
    expect((await get(`Bearer ${TOKEN}`, "POST")).status).toBe(405);
  });

  it("returns today's dial data", async () => {
    const d = "2026-10-21";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sleep_session (source_id, start_ts, end_ts, tz_offset_min, local_date, is_nap, updated_at)
        VALUES ('night', ?, ?, 120, ?, 0, 1), ('nap', ?, ?, 120, ?, 1, 1)`)
        .bind(local("2026-10-20", "23:30"), local(d, "07:10"), d, local(d, "15:00"), local(d, "15:40"), d),
      env.DB.prepare(`INSERT INTO workout (source_id, type, start_ts, end_ts, tz_offset_min, local_date, updated_at)
        VALUES ('run', 'RUNNING', ?, ?, 120, ?, 1)`).bind(local(d, "18:00"), local(d, "19:00"), d),
      ...([["caffeine", "07:40"], ["cigarettes", "11:15"], ["alcohol", "19:30"]] as const).map(([tracker, at]) => env.DB.prepare(`
        INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at)
        VALUES (?, ?, ?, 120, ?, 1, 'mcp', 1)`).bind(tracker, tracker, local(d, at), d)),
      ...Array.from({ length: 15 }, (_, i) => env.DB.prepare(`INSERT INTO metric_minute (metric, ts, tz_offset_min, value)
        VALUES ('hr', ?, 120, 60), ('hr', ?, 120, 120)`).bind(local(d, "00:00") + i * 60, local(d, "18:00") + i * 60)),
    ]);
    const res = await get(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{ date: string; generatedAt: number; sleep: unknown; workouts: unknown; events: { t: number; k: string }[]; counts: Record<string, number>; totals: Record<string, number>; hr: (number | null)[] }>();
    expect(body.date).toBe(d);
    expect(body.generatedAt).toBe(NOW);
    expect(body.sleep).toEqual([{ start: -30, end: 430, nap: false }, { start: 900, end: 940, nap: true }]);
    expect(body.workouts).toEqual([{ start: 1080, end: 1140 }]);
    expect(body.events).toEqual([{ t: 460, k: "cafe" }, { t: 675, k: "cigarro" }, { t: 1170, k: "alcohol" }]);
    expect(body.counts).toEqual({ cafe: 1, cigarro: 1, alcohol: 1 });
    expect(body.totals).toEqual({ caffeine: 1, cigarettes: 1, alcohol: 1 });
    expect(body.hr.length).toBe(96);
    expect([body.hr[0], body.hr[72], body.hr[1]]).toEqual([60, 120, null]);
  });

  it("empty day", async () => {
    const body = await (await get(`Bearer ${TOKEN}`)).json();
    expect(body).toEqual({ date: "2026-10-21", generatedAt: NOW, sleep: [], workouts: [], events: [], totals: {}, counts: {}, hr: Array(96).fill(null) });
  });

  it("returns every log of a busy day", async () => {
    await env.DB.batch(Array.from({ length: 51 }, (_, i) => env.DB.prepare(`
      INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at)
      VALUES (?, 'caffeine', ?, 120, '2026-10-21', 1, 'mcp', 1)`).bind(`c${String(i)}`, local("2026-10-21", "08:00") + i * 60)));
    const body = await (await get(`Bearer ${TOKEN}`)).json<{ events: { t: number }[]; counts: Record<string, number> }>();
    expect(body.events.length).toBe(51);
    expect(body.events[50].t).toBe(530);
    expect(body.counts).toEqual({ cafe: 51 });
  });

  it("adds the units of a multi-cigarette log", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at)
        VALUES ('three', 'cigarettes', ?, 120, '2026-10-21', 3, 'mcp', 1), ('cup', 'caffeine', ?, 120, '2026-10-21', 160, 'mcp', 1)`)
        .bind(local("2026-10-21", "09:00"), local("2026-10-21", "09:30")),
    ]);
    const body = await (await get(`Bearer ${TOKEN}`)).json<{ events: unknown[]; counts: Record<string, number>; totals: Record<string, number> }>();
    expect(body.events.length).toBe(2);
    expect(body.counts).toEqual({ cigarro: 3, cafe: 1 });
    expect(body.totals).toEqual({ cigarettes: 3, caffeine: 1 });
  });

  it("keeps distinct mood trackers apart in totals", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tracker (id, name, unit, value_type, default_value, min_value, max_value, created_at)
        VALUES ('mood_bien', 'Bien', 'u', 'count', 1, 1, 1, 1), ('mood_triste', 'Triste', 'u', 'count', 1, 1, 1, 1)
        ON CONFLICT(id) DO NOTHING`),
      env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at)
        VALUES ('b', 'mood_bien', ?, 120, '2026-10-21', 1, 'mcp', 1), ('t', 'mood_triste', ?, 120, '2026-10-21', 1, 'mcp', 1)`)
        .bind(local("2026-10-21", "09:00"), local("2026-10-21", "12:00")),
    ]);
    const body = await (await get(`Bearer ${TOKEN}`)).json<{ events: { k: string }[]; totals: Record<string, number>; counts: Record<string, number> }>();
    expect(body.events.map((e) => e.k)).toEqual(["animo", "animo"]);
    expect(body.events.map((e) => (e as { m?: string }).m)).toEqual(["bien", "triste"]);
    expect(body.totals).toEqual({ mood_bien: 1, mood_triste: 1 });
    expect(body.counts).toEqual({ animo: 2 });
  });

  it("rejects an unset token and a token without the Bearer prefix, without touching the database", async () => {
    const noDb = new Proxy({}, { get: () => { throw new Error("database touched"); } }) as D1Database;
    const call = (authorization: string, token?: string) => route(
      new Request("https://example.com/watch/today", { headers: { authorization } }),
      { ...appEnv(), DB: noDb, WATCH_TOKEN: token as string }, { fetch, now: () => NOW, sleep: () => Promise.resolve() });
    for (const res of await Promise.all([call("Bearer undefined"), call("Bearer "), call(TOKEN, TOKEN), call(`bearer ${TOKEN}`, TOKEN)])) {
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    }
  });
});

const post = (body: unknown, authorization = `Bearer ${TOKEN}`) => route(
  new Request("https://example.com/watch/log", { method: "POST", headers: { authorization }, body: JSON.stringify(body) }),
  appEnv(), { fetch, now: () => NOW, sleep: () => Promise.resolve() },
);

describe("POST /watch/log", () => {
  const tap = { tracker_id: "caffeine", at: "2026-10-21T19:58:00Z", idempotency_key: "tap-0001-abcd" };

  it("logs a tap once and replays a retry", async () => {
    const first = await post(tap);
    expect(first.status).toBe(201);
    const again = await post(tap);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, day_total: 80, event: { local_date: "2026-10-21" } });
    const body = await (await get(`Bearer ${TOKEN}`)).json<{ events: { t: number; k: string }[] }>();
    expect(body.events).toEqual([{ t: 21 * 60 + 58, k: "cafe" }]);
  });

  it("logs a mood", async () => {
    const res = await post({ ...tap, tracker_id: "mood_cansado", idempotency_key: "tap-0002-abcd" });
    expect(res.status).toBe(201);
  });

  it("rejects a bad token, other trackers, missing fields and bad times", async () => {
    expect((await post(tap, `Bearer ${TOKEN.slice(0, -1)}x`)).status).toBe(401);
    expect((await post({ ...tap, tracker_id: "weight" })).status).toBe(400);
    expect((await post({ tracker_id: "caffeine" })).status).toBe(400);
    expect((await post({ ...tap, at: "2026-10-01T10:00:00Z" })).status).toBe(400);
    expect((await post({ ...tap, idempotency_key: "short" })).status).toBe(400);
    expect((await route(new Request("https://example.com/watch/log", { headers: { authorization: `Bearer ${TOKEN}` } }),
      appEnv(), { fetch, now: () => NOW, sleep: () => Promise.resolve() })).status).toBe(405);
    const bad = await route(new Request("https://example.com/watch/log",
      { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{" }),
      appEnv(), { fetch, now: () => NOW, sleep: () => Promise.resolve() });
    expect(bad.status).toBe(400);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM event").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("DELETE /watch/log", () => {
  const del = (body: unknown, authorization = `Bearer ${TOKEN}`) => route(
    new Request("https://example.com/watch/log", { method: "DELETE", headers: { authorization }, body: JSON.stringify(body) }),
    appEnv(), { fetch, now: () => NOW, sleep: () => Promise.resolve() },
  );

  it("undoes a watch log and is safe to retry", async () => {
    await post({ tracker_id: "cigarettes", at: "2026-10-21T19:50:00Z", idempotency_key: "undo-0001-abcd" });
    const res = await del({ idempotency_key: "undo-0001-abcd" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, day_total: 0 });
    expect(await (await del({ idempotency_key: "undo-0001-abcd" })).json()).toMatchObject({ deleted: false });
    const body = await (await get(`Bearer ${TOKEN}`)).json<{ events: unknown[] }>();
    expect(body.events).toEqual([]);
  });

  it("refuses unknown keys, other trackers, bad bodies and bad tokens", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tracker (id, name, unit, value_type, default_value, min_value, max_value, created_at)
        VALUES ('water', 'Agua', 'ml', 'amount', 250, 0, 2000, 1) ON CONFLICT(id) DO NOTHING`),
      env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at)
        VALUES ('k_water-key-0001', 'water', ?, 120, '2026-10-21', 250, 'mcp', 1)`).bind(NOW - 60),
    ]);
    expect((await del({ idempotency_key: "water-key-0001" })).status).toBe(404);
    expect((await env.DB.prepare("SELECT deleted_at FROM event WHERE id = 'k_water-key-0001'").first())?.deleted_at).toBeNull();
    expect((await del({ idempotency_key: "missing-key-0001" })).status).toBe(404);
    expect((await del({ idempotency_key: "short" })).status).toBe(400);
    expect((await del({ idempotency_key: "undo-0001-abcd" }, `Bearer ${TOKEN.slice(0, -1)}x`)).status).toBe(401);
  });
});
