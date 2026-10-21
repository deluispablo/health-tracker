import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthStatus } from "../../src/mcp/tools/status";

interface Status {
  now_local: string;
  streams: { stream: string; latest_local: string | null; age_hours: number | null }[];
  queue: { pending: number; stuck: number; oldest_received_local: string | null };
  google: { connected: boolean; token_updated_local: string | null };
  coverage: { date: string; hr_minutes: number }[];
  alerts: { code: string; message: string }[];
}
// Keep the missing-module red from cascading into unrelated unsafe-any lint errors.
const readStatus = healthStatus as (db: D1Database, options: { now: number; tz: string }) => Promise<Status>;
const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T08:00:00Z");
const options = { now: NOW, tz: "Europe/Madrid" };
const codes = (out: Status) => out.alerts.map((alert) => alert.code);
const coverage = (first: string, counts: Record<string, number> = {}) => Array.from({ length: 14 }, (_, i) => {
  const date = new Date(Date.parse(`${first}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
  return { date, hr_minutes: counts[date] ?? 0 };
});
async function minute(ts: number, offset = 120, metric = "hr", source = "gh") {
  await env.DB.prepare("INSERT INTO metric_minute (metric, ts, tz_offset_min, value, source) VALUES (?, ?, ?, 60, ?)")
    .bind(metric, ts, offset, source).run();
}
async function token(name = "google_refresh_token") {
  await env.DB.prepare("INSERT INTO secret_blob (name, iv, ciphertext, updated_at) VALUES (?, ?, ?, ?)")
    .bind(name, new Uint8Array([255, 0, 17]), new Uint8Array([0, 255, 128, 42]), NOW - 60).run();
}
async function daily(date: string, computed = NOW) {
  await env.DB.prepare("INSERT INTO daily_summary (local_date, computed_at) VALUES (?, ?)").bind(date, computed).run();
}

// Observe actual D1 reads, allowing both individual SELECTs and SELECT batches.
function selectOnlyDb(onRead: () => void): D1Database {
  const statements = new WeakMap<object, { raw: D1PreparedStatement; sql: string }>();
  const check = (sql: string) => { expect(sql).toMatch(/^\s*SELECT\b/i); onRead(); };
  const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(raw, { get(t, p) {
      if (p === "bind") return (...args: unknown[]) => wrap(t.bind(...args), sql);
      if (["first", "all", "raw", "run"].includes(String(p))) return (...args: unknown[]) => {
        check(sql);
        return (Reflect.get(t, p) as (...values: unknown[]) => unknown).apply(t, args);
      };
      const value: unknown = Reflect.get(t, p);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    } });
    statements.set(proxy, { raw, sql });
    return proxy;
  };
  return new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (sql: string) => { expect(sql).toMatch(/^\s*SELECT\b/i); return wrap(t.prepare(sql), sql); };
    if (p === "batch") return (batch: D1PreparedStatement[]) => t.batch(batch.map((statement) => {
      const entry = statements.get(statement);
      if (!entry) throw new Error("unobserved statement");
      check(entry.sql);
      return entry.raw;
    }));
    if (p === "exec") return (sql: string) => { check(sql); return t.exec(sql); };
    if (p === "dump") return () => { throw new Error("unexpected dump"); };
    const value: unknown = Reflect.get(t, p);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  } });
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["metric_minute", "sleep_stage", "sleep_session", "daily_summary", "sync_pending", "secret_blob"]
    .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

describe("T10d AC1 health_status", () => {
  it("returns exactly the empty-database shape with ordered Spanish alerts", async () => {
    const out = await readStatus(env.DB, options);
    expect(out).toEqual({
      now_local: "2026-10-21T10:00",
      streams: [{ stream: "sleep", latest_local: null, age_hours: null }, { stream: "daily", latest_local: null, age_hours: null }],
      queue: { pending: 0, stuck: 0, oldest_received_local: null },
      google: { connected: false, token_updated_local: null },
      coverage: coverage("2026-10-08"),
      alerts: [
        { code: "google_disconnected", message: expect.any(String) as unknown },
        { code: "no_data_48h", message: expect.any(String) as unknown },
        { code: "daily_stale", message: expect.any(String) as unknown },
      ],
    });
    for (const alert of out.alerts) expect(alert.message.trim().length).toBeGreaterThan(0);
  });

  it("reports a healthy pipeline, observed metrics only, and no secret fields or raw rows", async () => {
    await token();
    await minute(NOW - 120);
    await daily("2026-10-20", NOW - 3600);
    await env.DB.prepare(`INSERT INTO sleep_session
      (source_id, start_ts, end_ts, tz_offset_min, local_date, updated_at)
      VALUES ('night', ?, ?, 120, '2026-10-21', 1)`).bind(NOW - 36000, NOW - 7200).run();
    expect(await readStatus(env.DB, options)).toEqual({
      now_local: "2026-10-21T10:00",
      streams: [
        { stream: "metric:hr", latest_local: "2026-10-21T09:58", age_hours: 0 },
        { stream: "sleep", latest_local: "2026-10-21T08:00", age_hours: 2 },
        { stream: "daily", latest_local: "2026-10-21T09:00", age_hours: 1 },
      ],
      queue: { pending: 0, stuck: 0, oldest_received_local: null },
      google: { connected: true, token_updated_local: "2026-10-21T09:59" },
      coverage: coverage("2026-10-08", { "2026-10-21": 1 }), alerts: [],
    });
  });

  it("pairs each latest timestamp with its own offset, rounds ages, clamps future ages and prefixes metric names", async () => {
    await minute(NOW - 7200, 330);
    await minute(NOW - 4500, -300);
    await minute(NOW, 840, "hr", "other");
    await minute(NOW, 120, "other-only", "other");
    await minute(NOW + 3600, 0, "sleep");
    await minute(NOW - 3600, 60, "daily");
    await env.DB.prepare(`INSERT INTO sleep_session
      (source_id, source, start_ts, end_ts, tz_offset_min, local_date, is_nap, updated_at) VALUES
      ('later-start', 'gh', ?1, ?2, 330, '2026-10-21', 0, ?5),
      ('later-end-nap', 'gh', ?3, ?4, -300, '2026-10-21', 1, 1),
      ('other', 'other', ?1, ?5, 840, '2026-10-21', 0, ?5)`)
      .bind(NOW - 10000, NOW - 7200, NOW - 20000, NOW - 4500, NOW).run();
    await daily("2026-10-20", NOW + 3600);
    await daily("2026-10-21", NOW - 4500);
    expect((await readStatus(env.DB, options)).streams).toEqual([
      { stream: "metric:daily", latest_local: "2026-10-21T08:00", age_hours: 1 },
      { stream: "metric:hr", latest_local: "2026-10-21T01:45", age_hours: 1.3 },
      { stream: "metric:sleep", latest_local: "2026-10-21T09:00", age_hours: 0 },
      { stream: "sleep", latest_local: "2026-10-21T01:45", age_hours: 1.3 },
      { stream: "daily", latest_local: "2026-10-21T08:45", age_hours: 1.3 },
    ]);
  });

  it("counts all queue rows, distinguishes attempts 4 and 5, and orders all alerts", async () => {
    await token("unrelated-secret");
    await env.DB.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES
      ('hr', 0, 1, 'UPSERT', ?1, 4), ('sleep', 0, 1, 'DELETE', ?2, 5), ('steps', 0, 1, 'UPSERT', ?3, 9)`)
      .bind(NOW - 60, NOW - 7200, NOW).run();
    const out = await readStatus(env.DB, options);
    expect(out.queue).toEqual({ pending: 3, stuck: 2, oldest_received_local: "2026-10-21T08:00" });
    expect(out.google).toEqual({ connected: false, token_updated_local: null });
    expect(codes(out)).toEqual(["google_disconnected", "no_data_48h", "queue_stuck", "daily_stale"]);
    for (const alert of out.alerts) expect(alert).toEqual({ code: expect.any(String) as unknown, message: expect.any(String) as unknown });
    await env.DB.prepare("UPDATE sync_pending SET attempts = 4").run();
    expect((await readStatus(env.DB, options)).queue.stuck).toBe(0);
    expect(codes(await readStatus(env.DB, options))).not.toContain("queue_stuck");
  });

  it.each([
    ["exactly 48 hours", NOW - 172800, "gh", false],
    ["one second too old", NOW - 172801, "gh", true],
    ["exactly now", NOW, "gh", false],
    ["future only", NOW + 1, "gh", true],
    ["recent non-gh only", NOW - 60, "other", true],
  ] as const)("uses the inclusive gh HR freshness interval: %s", async (_label, ts, source, stale) => {
    await minute(ts, 120, "hr", source);
    await minute(NOW, 120, "steps");
    expect(codes(await readStatus(env.DB, options)).includes("no_data_48h")).toBe(stale);
  });

  it.each([["2026-10-20", false], ["2026-10-19", true]] as const)("judges daily staleness by local_date %s, not computed_at", async (date, stale) => {
    await daily(date, stale ? NOW : NOW - 10 * 86400);
    expect(codes(await readStatus(env.DB, options)).includes("daily_stale")).toBe(stale);
  });

  it.each([["2026-10-21", false], ["2026-10-20", true]] as const)("uses today's date in USER_TZ for now_local, coverage and yesterday: %s", async (date, stale) => {
    await daily(date);
    const out = await readStatus(env.DB, { ...options, now: at("2026-10-21T22:30:00Z") });
    expect(out.now_local).toBe("2026-10-22T00:30");
    expect(out.coverage).toEqual(coverage("2026-10-09"));
    expect(codes(out).includes("daily_stale")).toBe(stale);
  });

  it("counts distinct gh HR timestamps using stored offsets, window edges and repeated DST minutes", async () => {
    const now = at("2026-10-26T08:00:00Z");
    for (const [iso, offset, metric, source] of [
      ["2026-10-12T21:59:00Z", 120, "hr", "gh"],
      ["2026-10-12T22:00:00Z", 120, "hr", "gh"],
      ["2026-10-14T00:30:00Z", -300, "hr", "gh"],
      ["2026-10-25T00:30:00Z", 120, "hr", "gh"],
      ["2026-10-25T01:30:00Z", 60, "hr", "gh"],
      ["2026-10-25T00:30:00Z", 120, "hr", "other"],
      ["2026-10-25T02:30:00Z", 60, "hr", "other"],
      ["2026-10-25T03:30:00Z", 60, "steps", "gh"],
      ["2026-10-26T22:59:00Z", 60, "hr", "gh"],
      ["2026-10-26T23:00:00Z", 60, "hr", "gh"],
    ] as const) await minute(at(iso), offset, metric, source);
    expect((await readStatus(env.DB, { ...options, now })).coverage).toEqual(
      coverage("2026-10-13", { "2026-10-13": 2, "2026-10-25": 2, "2026-10-26": 1 }),
    );
  });
});

describe("T10d AC3 SELECT-only and all-or-nothing D1 reads", () => {
  it("uses only SELECTs and rejects a failure at any read without requiring a query count", async () => {
    await token();
    await minute(NOW - 60);
    await daily("2026-10-21");
    let reads = 0;
    const out = await readStatus(selectOnlyDb(() => { reads++; }), options);
    expect(out.alerts).toEqual([]);
    expect(reads).toBeGreaterThan(0);
    for (let failAt = 1; failAt <= reads; failAt++) {
      let current = 0;
      const failure = new Error(`D1 read ${String(failAt)} unavailable`);
      await expect(readStatus(selectOnlyDb(() => { if (++current === failAt) throw failure; }), options)).rejects.toBe(failure);
    }
  });

  it("rejects D1 failure through individual statements, batches or direct execution", async () => {
    const failure = new Error("D1 unavailable");
    const reject = () => Promise.reject(failure);
    const statement = { bind: () => statement, first: reject, all: reject, raw: reject, run: reject };
    const broken = { prepare: () => statement, batch: reject, exec: reject, dump: reject } as unknown as D1Database;
    await expect(readStatus(broken, options)).rejects.toBe(failure);
  });
});
