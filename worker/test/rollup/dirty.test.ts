import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleScheduled } from "../../src/app";
import { drainSyncPending } from "../../src/ingest/drain";
import { encryptSecret } from "../../src/lib/crypto";
import { recomputeDailySummary } from "../../src/rollup/daily";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T08:05:00Z");
const day = (date: string, n: number) => new Date((at(`${date}T00:00:00Z`) + n * 86400) * 1000).toISOString().slice(0, 10);
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const appEnv = (DB = env.DB) => ({
  DB, OAUTH_KV: env.OAUTH_KV, USER_TZ: "Europe/Madrid", WEBHOOK_SECRET: "secret",
  GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", ALLOWED_EMAIL: "owner@example.com", TOKEN_ENC_KEY: KEY,
  WATCH_TOKEN: "watch-token-0123456789abcdef0123456789",
});
const deps = (now = NOW) => ({ now: () => now, sleep: () => Promise.resolve(),
  fetch: () => Promise.reject(new Error("unexpected Google call")) });
const tick = (DB = env.DB, now = NOW) => handleScheduled("*/5 * * * *", appEnv(DB), deps(now));
const emptyClient = (): Parameters<typeof drainSyncPending>[1] => ({
  rollUpSteps: () => Promise.resolve([]),
  rollUpHeartRate: () => Promise.resolve([]), dailyRollUp: () => Promise.resolve([]),
  listDaily: () => Promise.resolve([]), reconcile: () => Promise.resolve([]),
});
async function queue(type: string, start = "2026-10-06T10:00:00Z", end = "2026-10-06T10:01:00Z", operation = "UPSERT") {
  await env.DB.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at)
    VALUES (?, ?, ?, ?, ?)`).bind(type, at(start), at(end), operation, NOW).run();
}
async function mark(dates: string[]) {
  await env.DB.batch([
    env.DB.prepare("UPDATE rollup_seq SET n = n + 1 WHERE id = 1"),
    env.DB.prepare(`INSERT INTO rollup_dirty SELECT value, (SELECT n FROM rollup_seq WHERE id = 1)
      FROM json_each(?) WHERE true ON CONFLICT(local_date) DO UPDATE SET version = excluded.version`).bind(JSON.stringify(dates)),
  ]);
}
const dirty = async () => (await env.DB.prepare("SELECT local_date, version FROM rollup_dirty ORDER BY local_date")
  .all<{ local_date: string; version: number }>()).results;
const dirtyDates = async () => (await dirty()).map((r) => r.local_date);
const summaries = async () => (await env.DB.prepare("SELECT local_date, computed_at FROM daily_summary ORDER BY local_date").all()).results;
const today = () => env.DB.prepare("INSERT INTO daily_summary (local_date, computed_at) VALUES ('2026-10-21', 1)").run();

// Enforce D1's parameter bound and inject a second run after the dirty snapshot has been read.
function observedDb(beforeBatch: (sql: string[]) => Promise<void> = () => Promise.resolve()): D1Database {
  const entries = new WeakMap<object, { raw: D1PreparedStatement; sql: string }>();
  const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(raw, { get(t, p) {
      if (p === "bind") return (...args: unknown[]) => {
        expect(args.length).toBeLessThanOrEqual(100);
        if (/rollup_dirty|rollup_seq/.test(sql)) expect(args.length).toBeLessThanOrEqual(6);
        return wrap(t.bind(...args), sql);
      };
      const v: unknown = Reflect.get(t, p);
      return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(t) : v;
    } });
    entries.set(proxy, { raw, sql });
    return proxy;
  };
  return new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
    if (p === "batch") return async (statements: D1PreparedStatement[]) => {
      const batch = statements.map((s) => { const entry = entries.get(s); if (!entry) throw new Error("unobserved statement"); return entry; });
      await beforeBatch(batch.map((s) => s.sql));
      return t.batch(batch.map((s) => s.raw));
    };
    const v: unknown = Reflect.get(t, p);
    return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(t) : v;
  } });
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["rollup_dirty", "sync_pending", "sync_state", "secret_blob", "metric_minute", "metric_daily",
    "sleep_stage", "sleep_session", "workout", "daily_summary", "tracker_daily", "event"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("T24 AC1 migration", () => {
  it("creates the dirty primary key and persistent single-row version sequence", async () => {
    const columns = (await env.DB.prepare("PRAGMA table_info(rollup_dirty)").all()).results;
    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: "local_date", type: "TEXT", notnull: 0, pk: 1 }, { name: "version", type: "INTEGER", notnull: 1, pk: 0 },
    ]);
    expect(await env.DB.prepare("SELECT * FROM rollup_seq").first()).toEqual({ id: 1, n: 0 });
    await expect(env.DB.prepare("INSERT INTO rollup_seq VALUES (2, 0)").run()).rejects.toThrow();
  });
});

describe("T24 AC2 drain marks", () => {
  const civil = ["steps", "active-zone-minutes", "daily-resting-heart-rate", "daily-heart-rate-variability",
    "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations"];
  const types = [...civil, "heart-rate", "sleep", "exercise"];
  describe.each(["UPSERT", "DELETE"])("%s", (operation) => {
    it.each(types)("marks %s's actual window atomically, even for an empty answer", async (type) => {
      await queue(type, undefined, undefined, operation);
      const batches: string[][] = [];
      const db = observedDb((sql) => { batches.push(sql); return Promise.resolve(); });
      expect(await drainSyncPending(appEnv(db), emptyClient(), { now: () => NOW })).toEqual({ processed: 1, failed: 0 });
      expect(await dirtyDates()).toEqual(civil.includes(type) ? ["2026-10-06"] : ["2026-10-05", "2026-10-06", "2026-10-07"]);
      expect(batches).toHaveLength(1);
      expect(batches[0].some((s) => /INSERT INTO rollup_dirty/.test(s))).toBe(true);
      expect(batches[0].some((s) => /DELETE FROM sync_pending/.test(s))).toBe(true);
    });
  });

  it.each(["heart-rate", "sleep", "exercise", "steps"])("marks only the capped %s window", async (type) => {
    await queue(type, "2026-09-01T00:00:00Z", "2026-10-20T23:59:00Z");
    await drainSyncPending(appEnv(), emptyClient());
    const dates = await dirtyDates();
    expect(dates[0]).toBe(type === "steps" ? "2026-09-01" : "2026-08-31");
    expect(dates.at(-1)).toBe(type === "steps" ? "2026-10-01" : type === "heart-rate" ? "2026-09-02" : "2026-09-08");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first("n")).toBe(1);
  });

  it.each(["google", "batch"])("a %s failure leaves no marks or sequence advance, while the next type succeeds", async (failure) => {
    await queue("heart-rate");
    const client = emptyClient();
    if (failure === "google") client.rollUpHeartRate = () => Promise.reject(new Error("down"));
    else await env.DB.prepare("CREATE TRIGGER fail_dirty BEFORE DELETE ON sync_pending BEGIN SELECT RAISE(ABORT, 'queue failed'); END").run();
    const before = await env.DB.prepare("SELECT n FROM rollup_seq").first("n");
    try {
      expect(await drainSyncPending(appEnv(), client)).toEqual({ processed: 0, failed: 1 });
      expect(await dirty()).toEqual([]);
      expect(await env.DB.prepare("SELECT n FROM rollup_seq").first("n")).toBe(before);
    } finally { await env.DB.prepare("DROP TRIGGER IF EXISTS fail_dirty").run(); }
    await queue("steps");
    expect(await drainSyncPending(appEnv(), client)).toEqual({ processed: failure === "google" ? 1 : 2, failed: failure === "google" ? 1 : 0 });
    expect(await dirtyDates()).toContain("2026-10-06");
  });

  it.each(["sleep", "exercise"])("marks old deleted/replaced and new %s dates, filters invalid dates and handles >100 IDs", async (type) => {
    const table = type === "sleep" ? "sleep_session" : "workout";
    const start = at("2026-09-01T10:00:00Z");
    const oldDates = ["2026-07-01", "2026-07-02", "-0001-01-01", "2026-02-30", "1999-12-31", "2100-01-01"];
    await env.DB.batch(oldDates.map((date, i) => env.DB.prepare(`INSERT INTO ${table}
      (source_id, start_ts, end_ts, tz_offset_min, local_date, updated_at${type === "exercise" ? ", type" : ""})
      VALUES (?, ?, ?, 0, ?, 1${type === "exercise" ? ", 'RUN'" : ""})`)
      .bind(`old-${String(i)}`, i === 0 ? start : start - 864000, i === 0 ? start + 30 : start - 864000 + 30, date)));
    await env.DB.prepare(`UPDATE ${table} SET ${type === "sleep" ? "minutes_asleep = 60, minutes_in_bed = 90" : "duration_min = 60"}`).run();
    await recomputeDailySummary(env.DB, "2026-07-01", "2026-07-30", NOW - 300);
    const column = type === "sleep" ? "sleep_min" : "workout_min";
    expect(await env.DB.prepare(`SELECT ${column} AS value FROM daily_summary WHERE local_date = '2026-07-01'`).first("value")).toBe(60);
    await queue(type, "2026-09-01T10:00:00Z", "2026-09-01T10:01:00Z");
    const client = emptyClient();
    client.reconcile = () => Promise.resolve(Array.from({ length: 125 }, (_, i) => ({
      dataPointName: `old-${String(i + 1)}`,
      [type === "sleep" ? "sleep" : "exercise"]: {
        interval: { startTime: "2026-09-01T10:00:00Z", endTime: "2026-09-01T10:00:30Z",
          startUtcOffset: "172800s", endUtcOffset: "172800s" },
        metadata: { mainSleep: true }, summary: { minutesAsleep: 1 }, exerciseType: "RUN", activeDuration: "30s",
      },
    })));
    expect(await drainSyncPending(appEnv(observedDb()), client)).toEqual({ processed: 1, failed: 0 });
    expect(await dirtyDates()).toEqual(["2026-07-01", "2026-07-02", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n")).toBe(125);
    await today();
    await tick();
    expect((await env.DB.prepare(`SELECT ${column} AS value, computed_at FROM daily_summary
      WHERE local_date IN ('2026-07-01', '2026-07-02') ORDER BY local_date`).all()).results)
      .toEqual([{ value: null, computed_at: NOW }, { value: null, computed_at: NOW }]);
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-07-30'").first("computed_at")).toBe(NOW);
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-10-02'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-10-01'").first("computed_at")).toBe(NOW);
  });
});

describe("T24 AC3–AC5 scheduled dirty rollup", () => {
  it("uses one three-statement batch for idle rollup checks without rebuilding summaries or trackers", async () => {
    await today();
    await env.DB.batch([-3, -2, -1, 0].map((n) => env.DB.prepare(`INSERT INTO event
      (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at) VALUES (?, 'caffeine', ?, 120, ?, 80, 'mcp', ?)`)
      .bind(String(n), NOW, day("2026-10-21", n), NOW)));
    await env.DB.prepare("CREATE TRIGGER no_daily BEFORE INSERT ON daily_summary BEGIN SELECT RAISE(ABORT, 'idle write'); END").run();
    const batches: string[][] = [];
    const db = observedDb((sql) => { batches.push(sql); return Promise.resolve(); });
    try { await tick(db); } finally { await env.DB.prepare("DROP TRIGGER no_daily").run(); }
    expect(batches.map((batch) => batch.length)).toEqual([3]);
    expect(await summaries()).toEqual([{ local_date: "2026-10-21", computed_at: 1 }]);
    expect((await env.DB.prepare("SELECT local_date, total FROM tracker_daily ORDER BY local_date").all()).results)
      .toEqual([]);
  });

  it("bootstraps each new USER_TZ day without Google or data", async () => {
    await tick(env.DB, at("2026-10-20T22:01:00Z"));
    await tick(env.DB, at("2026-10-21T22:01:00Z"));
    expect((await summaries()).map((r) => r.local_date)).toEqual(["2026-10-21", "2026-10-22"]);
  });

  it("refreshes the inclusive 28-day score tail and retains future dates until eligible", async () => {
    await today();
    await mark(["2026-09-01", "2026-09-08", "2026-10-22"]);
    await tick();
    const rows = await summaries();
    expect(rows[0]?.local_date).toBe("2026-09-01");
    expect(rows.at(-2)?.local_date).toBe("2026-10-06");
    expect(rows.at(-1)?.computed_at).toBe(1);
    expect(await dirtyDates()).toEqual(["2026-10-22"]);
    await tick();
    expect(await summaries()).toEqual(rows);
    await tick(env.DB, NOW + 86400);
    expect(await dirty()).toEqual([]);
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-10-22'").first("computed_at")).toBe(NOW + 86400);
  });

  it("caps at 366 dates, retaining incomplete tails and today's bootstrap for subsequent ticks", async () => {
    await mark(["2025-01-01", "2025-12-31", "2026-10-20"]);
    await tick();
    const rows = await summaries();
    expect(rows).toHaveLength(366);
    expect(rows[0]?.local_date).toBe("2025-01-01");
    expect(rows.at(-1)?.local_date).toBe("2026-01-01");
    expect(await dirtyDates()).toEqual(["2025-12-31", "2026-10-20"]);
    await tick(env.DB, NOW + 300);
    expect(await dirty()).toEqual([]);
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-01-28'").first("computed_at")).toBe(NOW + 300);
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-10-21'").first("computed_at")).toBe(NOW + 300);
  });

  it("cleans a dense >100-date backlog with bounded statements", async () => {
    await today();
    await mark(Array.from({ length: 130 }, (_, i) => day("2026-05-01", i)));
    await tick(observedDb());
    expect(await dirty()).toEqual([]);
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-10-05'").first("computed_at")).toBe(NOW);
  });

  it("discards malformed, noncanonical and out-of-domain marks while processing valid dates", async () => {
    await today();
    await mark(["-0001-01-01", "2026-02-30", "2026-2-01", "garbage", "1999-12-31", "2100-01-01", "2026-10-01"]);
    await tick();
    expect(await dirty()).toEqual([]);
    expect((await summaries())[0]?.local_date).toBe("2026-10-01");
    expect((await summaries()).at(-1)?.computed_at).toBe(NOW);
  });

  it.each(["INSERT", "UPDATE"])("a failed recompute (%s) leaves the snapshot's marks and summaries unchanged", async (event) => {
    await today();
    await mark(["2026-10-01"]);
    const before = await dirty();
    await env.DB.prepare(`CREATE TRIGGER fail_summary BEFORE ${event} ON daily_summary BEGIN SELECT RAISE(ABORT, 'rollup failed'); END`).run();
    try { await expect(tick()).rejects.toThrow(); } finally { await env.DB.prepare("DROP TRIGGER fail_summary").run(); }
    expect(await dirty()).toEqual(before);
    expect(await summaries()).toEqual([{ local_date: "2026-10-21", computed_at: 1 }]);
    await tick();
    expect(await dirty()).toEqual([]);
  });

  it.each([false, true])("retains a mark made after the snapshot at the same timestamp (delete/reinsert: %s)", async (clearFirst) => {
    await today();
    await queue("steps");
    await drainSyncPending(appEnv(), emptyClient(), { now: () => NOW });
    const before = (await dirty())[0].version;
    let injected = false;
    const db = observedDb(async (sql) => {
      if (injected || !sql.some((s) => /INSERT INTO daily_summary/.test(s))) return;
      injected = true;
      if (clearFirst) { await tick(); expect(await dirty()).toEqual([]); }
      await queue("steps");
      await drainSyncPending(appEnv(), emptyClient(), { now: () => NOW });
    });
    await tick(db);
    expect(injected).toBe(true);
    expect(await dirtyDates()).toEqual(["2026-10-06"]);
    expect((await dirty())[0].version).toBeGreaterThan(before);
    await tick();
    expect(await dirty()).toEqual([]);
  });

  it("drains the seven-day September sleep backfill and refreshes actual scores through October 5 in one tick", async () => {
    await today();
    // Six later baseline values become eligible for a score when September 7 arrives.
    await env.DB.prepare(`INSERT INTO sleep_session
      (source_id, start_ts, end_ts, tz_offset_min, local_date, is_nap, minutes_asleep, minutes_in_bed, updated_at)
      VALUES ('baseline', 0, 1, 0, '2026-09-01', 0, 390, 450, 1),
      ('tail', 2, 3, 0, '2026-10-05', 0, 500, 550, 1)`).run();
    await env.DB.batch(Array.from({ length: 6 }, (_, i) => env.DB.prepare(`INSERT INTO sleep_session
      (source_id, start_ts, end_ts, tz_offset_min, local_date, is_nap, minutes_asleep, minutes_in_bed, updated_at)
      VALUES (?, 0, 1, 0, ?, 0, ?, 480, 1)`).bind(`history-${String(i)}`, day("2026-09-08", i), 400 + i * 10)));
    await recomputeDailySummary(env.DB, "2026-09-01", "2026-10-06", NOW - 300);
    expect(await env.DB.prepare("SELECT z_sleep FROM daily_summary WHERE local_date = '2026-10-05'").first("z_sleep")).toBeNull();
    const { iv, ciphertext } = await encryptSecret(KEY, "refresh");
    await env.DB.prepare("INSERT INTO secret_blob (name, iv, ciphertext, updated_at) VALUES ('google_refresh_token', ?, ?, 1)")
      .bind(new Uint8Array(iv), new Uint8Array(ciphertext)).run();
    await queue("sleep", "2026-09-01T00:00:00Z", "2026-09-07T23:59:00Z");
    const requested: string[][] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const req = new Request(input, init);
      if (req.url === "https://oauth2.googleapis.com/token") return Promise.resolve(Response.json({ access_token: "token", expires_in: 3599 }));
      const url = new URL(req.url);
      const start = url.searchParams.get("filter") ?? "";
      requested.push([url.pathname, start]);
      const sessions = Array.from({ length: 6 }, (_, i) => {
        const date = day("2026-09-02", i);
        return { dataPointName: `backfill-${String(i)}`, sleep: {
          interval: { startTime: `${day(date, -1)}T23:00:00Z`, endTime: `${date}T07:00:00Z`, endUtcOffset: "0s" },
          metadata: { mainSleep: true }, summary: { minutesAsleep: 400 + i * 10, minutesInSleepPeriod: 480 },
        } };
      });
      // Reconcile's requested interval must include each wake, rather than accepting an unrestricted fake.
      expect(start).toContain("2026-09-01T00:00:00.000Z");
      expect(start).toContain("2026-09-08T00:00:00.000Z");
      const bounds = [...start.matchAll(/"([^"\n]+)"/g)].map((m) => Date.parse(m[1]));
      return Promise.resolve(Response.json({ dataPoints: sessions.filter((s) => {
        const wake = Date.parse(s.sleep.interval.endTime);
        return wake >= bounds[0] && wake < bounds[1];
      }) }));
    };
    await handleScheduled("*/5 * * * *", appEnv(), { ...deps(), fetch });
    expect(requested).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first("n")).toBe(0);
    expect((await env.DB.prepare("SELECT sleep_min FROM daily_summary WHERE local_date BETWEEN '2026-09-02' AND '2026-09-07' ORDER BY local_date").all()).results)
      .toEqual([400, 410, 420, 430, 440, 450].map((sleep_min) => ({ sleep_min })));
    expect(await env.DB.prepare("SELECT computed_at FROM daily_summary WHERE local_date = '2026-10-06'").first("computed_at")).toBe(NOW);
    const history = [450, 400, 410, 420, 430, 440, 450];
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const sd = Math.sqrt(history.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (history.length - 1));
    expect(await env.DB.prepare("SELECT z_sleep, computed_at FROM daily_summary WHERE local_date = '2026-10-05'").first())
      .toEqual({ z_sleep: expect.closeTo((500 - mean) / sd, 9) as unknown, computed_at: NOW });
  });
});
