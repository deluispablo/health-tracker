import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { route } from "../src/app";
import { handleWatchToday } from "../src/watch";
import { healthSetProfile } from "../src/mcp/tools/profile";
import { logEvent } from "../src/mcp/tools/trackers";

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
  await env.DB.batch(["sleep_stage", "sleep_session", "workout", "event", "metric_minute", "profile"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
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

  it("returns valid JSON for the fall-back night and a nap inside the repeated hour", async () => {
    const now = Date.parse("2026-10-25T20:00:00Z") / 1000;
    const at = (iso: string) => Date.parse(iso) / 1000;
    await env.DB.prepare(`INSERT INTO sleep_session (source_id, start_ts, end_ts, tz_offset_min, start_tz_offset_min, local_date, is_nap, updated_at)
      VALUES ('night', ?, ?, 60, 120, '2026-10-25', 0, 1), ('repeated', ?, ?, 60, 120, '2026-10-25', 1, 1)`)
      .bind(at("2026-10-24T21:30:00Z"), at("2026-10-25T06:30:00Z"), at("2026-10-25T00:30:00Z"), at("2026-10-25T01:15:00Z")).run();
    const res = await route(new Request("https://example.com/watch/today", { headers: { authorization: `Bearer ${TOKEN}` } }),
      appEnv(), { fetch, now: () => now, sleep: () => Promise.resolve() });
    expect(res.status).toBe(200);
    const body = await res.json<{ date: string; sleep: unknown }>();
    expect(body.date).toBe("2026-10-25");
    // The repeated-hour nap reads 02:30 CEST to 02:15 CET; the dial omits a start after its end.
    expect(body.sleep).toEqual([{ start: -30, end: 450, nap: false }, { start: 150, end: 135, nap: true }]);
  });

  it("empty day", async () => {
    const body = await (await get(`Bearer ${TOKEN}`)).json();
    expect(body).toMatchObject({ water: { ml: 0, goal_ml: 2000 }, date: "2026-10-21", generatedAt: NOW, sleep: [], workouts: [], events: [], totals: {}, counts: {}, hr: Array(96).fill(null) });
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
    const body = await (await get(`Bearer ${TOKEN}`)).json<{ events: unknown[]; counts: Record<string, number>; totals: Record<string, number>; trackers: Today["trackers"] }>();
    expect(body.trackers.find((t) => t.id === "cigarettes")?.today).toBe(3);
    expect(body.trackers.find((t) => t.id === "caffeine")?.today).toBe(160);
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
    expect(body.events).toEqual([{ t: 21 * 60 + 58, k: "cafe", i: "tap-0001-abcd" }]);
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

  it("never replays an event of another tracker", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tracker (id, name, unit, value_type, default_value, min_value, max_value, created_at)
        VALUES ('water', 'Agua', 'ml', 'amount', 250, 0, 2000, 1) ON CONFLICT(id) DO NOTHING`),
      env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, note, origin, created_at)
        VALUES ('kw_other-0001', 'water', ?, 120, '2026-10-21', 250, 'private', 'mcp', 1)`).bind(NOW - 60),
    ]);
    const res = await post({ ...tap, idempotency_key: "other-0001" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("");
  });
});

describe("DELETE /watch/log", () => {
  const tap0 = { tracker_id: "caffeine", at: "2026-10-21T19:58:00Z" };
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
    expect((await del({ idempotency_key: "x".repeat(65) })).status).toBe(400);
    expect((await del({ idempotency_key: "short" })).status).toBe(400);
    expect((await del({ idempotency_key: "undo-0001-abcd" }, `Bearer ${TOKEN.slice(0, -1)}x`)).status).toBe(401);
  });

  it("can neither undo nor read back an MCP log, whatever its key", async () => {
    for (const key of ["mcp-cafe-0001", "w-mcp-cafe-0001"]) {
      await logEvent(env.DB, { tracker_id: "caffeine", at: "2026-10-21T19:00:00Z", note: "private", idempotency_key: key },
        { now: NOW, tz: "Europe/Madrid" });
    }
    expect((await del({ idempotency_key: "mcp-cafe-0001" })).status).toBe(404);
    const posted = await post({ ...tap0, idempotency_key: "mcp-cafe-0001" });
    expect(posted.status).toBe(201);
    expect(await posted.text()).not.toContain("private");
    const live = await env.DB.prepare("SELECT id FROM event WHERE note = 'private' AND deleted_at IS NULL ORDER BY id").all();
    expect(live.results).toEqual([{ id: "k_mcp-cafe-0001" }, { id: "k_w-mcp-cafe-0001" }]);
  });
});

type Today = {
  totals: Record<string, number>;
  counts: Record<string, number>;
  water: { ml: number; goal_ml: number };
  trackers: { id: string; name: string; unit: string; value: number; surface: string; today: number }[];
  events: { t: number; k: string; id?: string; i?: string }[];
};
const today = async () => (await get(`Bearer ${TOKEN}`)).json<Today>();
const tapTracker = (tracker_id: string, idempotency_key = `tap-${tracker_id}`) => post({
  tracker_id, idempotency_key, at: "2026-10-21T19:58:00Z",
});
const undo = (idempotency_key: string) => route(
  new Request("https://example.com/watch/log", { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ idempotency_key }) }),
  appEnv(), { fetch, now: () => NOW, sleep: () => Promise.resolve() },
);

describe("catalog watch trackers", () => {
  afterEach(async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE tracker SET surface = 'face', default_value = 250, archived_at = NULL WHERE id = 'water'"),
      env.DB.prepare("UPDATE tracker SET archived_at = NULL WHERE id = 'creatine'"),
      env.DB.prepare("DELETE FROM event WHERE tracker_id = 'future'"),
      env.DB.prepare("DELETE FROM tracker WHERE id = 'future'"),
    ]);
  });
  it("logs water and supplements with their default doses and exact dial marks", async () => {
    for (const id of ["water", "melatonin", "protein", "creatine"]) expect((await tapTracker(id)).status).toBe(201);
    const body = await today();
    expect(body.water).toEqual({ ml: 250, goal_ml: 2000 });
    for (const [id, value] of [["water", 250], ["melatonin", 1], ["protein", 30], ["creatine", 5]] as const) {
      expect(body.trackers.find((t) => t.id === id)).toMatchObject({ value, today: value });
    }
    expect(body.events).toEqual([
      ...["creatine", "melatonin", "protein"].map((id) => ({ t: 1318, k: "suplemento", id, i: `tap-${id}` })),
      { t: 1318, k: "agua", i: "tap-water" },
    ]);
    expect((await undo("tap-melatonin")).status).toBe(200);
    expect((await today()).trackers.find((t) => t.id === "melatonin")?.today).toBe(0);
  });

  it.each(["default_value = NULL", "surface = NULL", "archived_at = 1"])(
    "hides and refuses a tracker with %s while preserving its historical events", async (change) => {
      await tapTracker("water");
      await env.DB.prepare(`UPDATE tracker SET ${change} WHERE id = 'water'`).run();
      expect((await tapTracker("water")).status).toBe(400);
      expect((await tapTracker("water", "new-water-key")).status).toBe(400);
      expect((await undo("tap-water")).status).toBe(404);
      const body = await today();
      expect(body.trackers.some((t) => t.id === "water")).toBe(false);
      expect(body.events).toEqual([{ t: 1318, k: "agua", i: "tap-water" }]);
      expect(body.totals).toEqual({ water: 1 });
      expect(body.counts).toEqual({ agua: 1 });
      expect(body.water.ml).toBe(250);
      expect(await env.DB.prepare("SELECT deleted_at FROM event WHERE id = 'kw_tap-water'").first("deleted_at")).toBeNull();
    },
  );

  it.each(["NULL, 'tile', NULL", "1, NULL, NULL", "1, 'tile', 1"])(
    "keeps historical logs for a DB-only hidden tracker (%s)", async (config) => {
      await env.DB.prepare(`INSERT INTO tracker (id, name, unit, value_type, default_value, surface, archived_at, created_at)
        VALUES ('future', 'Hidden', 'g', 'amount', ${config}, 1)`).run();
      await env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at)
        VALUES ('kw_hidden-key', 'future', ?, 120, '2026-10-21', 7, 'mcp', 1)`).bind(NOW - 120).run();
      expect((await tapTracker("future")).status).toBe(400);
      expect((await undo("hidden-key")).status).toBe(404);
      const body = await today();
      expect(body.trackers.some((t) => t.id === "future")).toBe(false);
      expect(body.events).toEqual([{ t: 1318, k: config.includes("1, NULL") ? "other" : "suplemento",
        ...(config.includes("1, NULL") ? {} : { id: "future" }), i: "hidden-key" }]);
      expect(body.totals).toEqual({ future: 1 });
      expect(body.counts).toEqual({ [config.includes("1, NULL") ? "other" : "suplemento"]: 1 });
    },
  );

  it("uses the latest live scale value on the stored local date", async () => {
    await env.DB.prepare(`INSERT INTO tracker (id, name, unit, value_type, default_value, surface, sort, created_at)
      VALUES ('future', 'Scale', 'pt', 'scale', 1, 'tile', -1, 1)`).run();
    expect((await today()).trackers[0].today).toBe(0);
    await env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at, deleted_at) VALUES
      ('scale-old', 'future', ?, 120, '2026-10-21', 8, 'mcp', 1, NULL),
      ('scale-new', 'future', ?, 120, '2026-10-21', 3, 'mcp', 1, NULL),
      ('scale-deleted', 'future', ?, 120, '2026-10-21', 9, 'mcp', 1, 0),
      ('scale-other-day', 'future', ?, 120, '2026-10-20', 10, 'mcp', 1, NULL)`)
      .bind(NOW - 120, NOW - 60, NOW, NOW).run();
    expect((await today()).trackers[0].today).toBe(3);
  });

  it.each([['water', 100, 375, 250], ['melatonin', 0.5, 2, 1], ['protein', 12, 45, 30], ['creatine', 2, 7, 5]] as const)(
    "%s sums stored doses, excludes deleted/other dates, and survives undo and retries", async (id, first, second, dose) => {
      for (const [value, at] of [[first, "2026-10-21T08:00:00Z"], [second, "2026-10-21T10:00:00Z"],
        [dose, "2026-10-20T22:30:00Z"], [dose, "2026-10-20T19:00:00Z"]] as const) {
        await logEvent(env.DB, { tracker_id: id, value, at }, { now: NOW, tz: "Europe/Madrid" });
      }
      // 22:30Z belongs to today's Madrid date; mark it deleted (including deleted_at = 0).
      await env.DB.prepare("UPDATE event SET deleted_at = 0 WHERE tracker_id = ? AND ts = ?").bind(id, Date.parse('2026-10-20T22:30:00Z') / 1000).run();
      const total = async () => {
        const body = await today();
        if (id === "water") expect(body.water.ml).toBe(body.trackers.find((t) => t.id === id)?.today);
        return body.trackers.find((t) => t.id === id)?.today;
      };
      expect(await total()).toBe(first + second);
      expect((await tapTracker(id)).status).toBe(201);
      expect((await tapTracker(id)).status).toBe(200);
      expect(await total()).toBe(first + second + dose);
      for (let retry = 0; retry < 2; retry++) {
        expect((await undo(`tap-${id}`)).status).toBe(200);
        expect(await total()).toBe(first + second);
      }
      expect((await tapTracker(id)).status).toBe(200);
      expect(await total()).toBe(first + second);
    },
  );

  it("reads future supplements from the catalog in sort order and sums stored units for count trackers", async () => {
    await env.DB.prepare(`INSERT INTO tracker (id, name, unit, value_type, default_value, surface, sort, created_at)
      VALUES ('future', 'Otro suplemento', 'u', 'count', 3, 'tile', -1, 1)`).run();
    expect((await tapTracker("future")).status).toBe(201);
    await tapTracker("future", "future-again");
    await logEvent(env.DB, { tracker_id: "water", value: 500, at: "2026-10-20T19:00:00Z" }, { now: NOW, tz: "Europe/Madrid" });
    await tapTracker("water");
    await tapTracker("water", "water-again");
    await tapTracker("water", "water-deleted");
    await undo("water-deleted");
    const body = await today();
    expect(body.trackers[0]).toEqual({ id: "future", name: "Otro suplemento", unit: "u", value: 3, surface: "tile", today: 6 });
    expect(body.events[0]).toEqual({ t: 1318, k: "suplemento", id: "future", i: "future-again" });
    expect((await undo("tap-future")).status).toBe(200);
    expect((await today()).trackers[0].today).toBe(3);
    expect(body.water.ml).toBe(500);
    expect(body.trackers.find((t) => t.id === "water")?.today).toBe(500);
  });

  it("draws supplement logs from other clients without a watch key", async () => {
    await logEvent(env.DB, { tracker_id: "melatonin", at: "2026-10-21T19:58:00Z" }, { now: NOW, tz: "Europe/Madrid" });
    expect((await today()).events).toEqual([{ t: 1318, k: "suplemento", id: "melatonin" }]);
  });

  it("water goal defaults to 2000 and follows profile", async () => {
    expect((await today()).water.goal_ml).toBe(2000);
    await healthSetProfile(env.DB, { water_goal_ml: 2500 }, { now: NOW, tz: "Europe/Madrid" });
    expect((await today()).water.goal_ml).toBe(2500);
    for (const value of ["not-json", "null", '"2500"', "true", "{}", "499", "6001", "2500.5"]) {
      await env.DB.prepare("UPDATE profile SET value = ? WHERE key = 'water_goal_ml'").bind(value).run();
      expect((await today()).water.goal_ml).toBe(2000);
    }
  });
  it("propagates real D1 failures when reading the water goal", async () => {
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return target.batch.bind(target);
      if (property === "prepare") return (sql: string) => target.prepare(
        sql.includes("FROM profile") ? "SELECT value FROM missing_watch_profile" : sql,
      );
      throw new Error(`unexpected operation ${String(property)}`);
    } });
    await expect(handleWatchToday(new Request("https://example.com/watch/today", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }), { ...appEnv(), DB: db }, NOW)).rejects.toThrow(/no such table: missing_watch_profile/);
  });

});
