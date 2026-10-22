import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RollUpPoint } from "../../src/google/client";
import { createGoogleClient } from "../../src/google/client";
import { drainSyncPending } from "../../src/ingest/drain";
import { dateTimeFormat } from "../../src/lib/time";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T00:00:00Z");
const drainEnv = () => ({ DB: env.DB, USER_TZ: "Europe/Madrid" });

interface Call { start: string; end: string; windowSec: number }
function fakeClient(points: RollUpPoint[] | Error = []) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      rollUpSteps: () => Promise.resolve([]),
      rollUpHeartRate(start: string, end: string, windowSec: number): Promise<RollUpPoint[]> {
        calls.push({ start, end, windowSec });
        return points instanceof Error ? Promise.reject(points) : Promise.resolve(points);
      },
      dailyRollUp: () => Promise.reject(new Error("unexpected dailyRollUp")),
      listDaily: () => Promise.reject(new Error("unexpected listDaily")),
      reconcile: () => Promise.reject(new Error("unexpected reconcile")),
    },
  };
}

async function queue(type: string, start: number, end: number, operation = "UPSERT", receivedAt = NOW - 60, attempts = 0) {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(type, start, end, operation, receivedAt, attempts).run();
}
const pending = async () => (await env.DB.prepare(
  "SELECT data_type, start_ts, end_ts, operation, received_at, attempts FROM sync_pending ORDER BY data_type, start_ts, operation").all()).results;
async function withTrigger(event: "DELETE" | "UPDATE", run: () => Promise<unknown>) {
  await env.DB.prepare(`CREATE TRIGGER fail_queue BEFORE ${event} ON sync_pending BEGIN SELECT RAISE(ABORT, 'queue write failed'); END`).run();
  try { await run(); } finally { await env.DB.prepare("DROP TRIGGER fail_queue").run(); }
}
async function seedMinute(metric: string, source: string, ts: number) {
  await env.DB.prepare("INSERT INTO metric_minute (metric, ts, tz_offset_min, value, source) VALUES (?, ?, 120, 1, ?)").bind(metric, ts, source).run();
}
const minutes = async () => (await env.DB.prepare(
  "SELECT metric, ts, tz_offset_min, value, vmin, vmax, n, source FROM metric_minute ORDER BY ts").all()).results;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DROP TRIGGER IF EXISTS fail_queue"), env.DB.prepare("DELETE FROM sync_pending"), env.DB.prepare("DELETE FROM metric_minute")]);
});

// Record executed queue reads and the rows D1 actually returns, including bound statements.
function countingDb() {
  const reads: Record<string, unknown>[][] = [];
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(t, p) {
    if (p === "bind") return (...args: unknown[]) => wrap(t.bind(...args));
    const value: unknown = Reflect.get(t, p);
    if (p === "all" || p === "first") return async (...args: unknown[]) => {
      const result = await (value as (...args: unknown[]) => Promise<unknown>).apply(t, args);
      reads.push(p === "all" ? (result as D1Result<Record<string, unknown>>).results : result ? [result as Record<string, unknown>] : []);
      return result;
    };
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  } });
  const db = new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (sql: string) => {
      const statement = t.prepare(sql);
      return /\bSELECT\b/i.test(sql) && !/^\s*INSERT\b/i.test(sql) && /\bsync_pending\b/i.test(sql)
        ? wrap(statement) : statement;
    };
    const value: unknown = Reflect.get(t, p);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  } });
  return { db, reads };
}

describe("T31 heads snapshot", () => {
  const types = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability",
    "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "exercise"];

  it.each([false, true])("AC1/AC4 executes one queue SELECT on an idle drain (exhausted: %s)", async (exhausted) => {
    if (exhausted) await queue("heart-rate", NOW - 120, NOW - 60, "UPSERT", NOW - 60, 5);
    const { db, reads } = countingDb();
    expect(await drainSyncPending({ ...drainEnv(), DB: db }, fakeClient().client)).toEqual({ processed: 0, failed: 0 });
    expect(reads).toEqual([[]]);
  });

  it("AC1/AC4 returns only one eligible head per supported type from a backlog and drains in fixed order", async () => {
    const start = at("2026-10-20T10:00:00Z");
    // Reverse insertion order, with ties exercising every ORDER BY column.
    for (const type of [...types].reverse()) {
      await queue(type, start - 60, start + 60, "DELETE", NOW - 900, 5);
      await queue(type, start - 60, start, "DELETE", NOW - 30);
      await queue(type, start + 60, start + 120);
      await queue(type, start, start + 180);
      await queue(type, start, start + 120, "DELETE");
      await queue(type, start, start + 60, "DELETE");
    }
    await queue("weight", start, start + 60);
    const order: string[] = [];
    const answer = (type: string) => { order.push(type); return Promise.resolve([]); };
    const client = {
      rollUpSteps: () => Promise.resolve([]),
      rollUpHeartRate: () => answer("heart-rate"), dailyRollUp: answer, listDaily: answer, reconcile: answer,
    };
    const { db, reads } = countingDb();
    expect(await drainSyncPending({ ...drainEnv(), DB: db }, client)).toEqual({ processed: 10, failed: 0 });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toHaveLength(10);
    expect(reads[0].map((r) => r.data_type).sort()).toEqual([...types].sort());
    expect(reads[0].every((r) => r.start_ts === start && r.end_ts === start + 60 && r.operation === "DELETE"
      && r.received_at === NOW - 60 && r.attempts === 0)).toBe(true);
    // Heart-rate DELETE does not call Google; every other type still does.
    expect(order).toEqual(types.slice(1));
    expect(await pending()).toHaveLength(51);
  });

  it("AC1 preserves a later type re-received mid-drain and defers a newly arriving type to the next run", async () => {
    const start = at("2026-10-20T10:00:00Z");
    await queue("heart-rate", start, start + 60);
    await queue("steps", start, start + 60);
    const order: string[] = [];
    const client = {
      rollUpSteps: () => Promise.resolve([]),
      async rollUpHeartRate() {
        order.push("heart-rate");
        await env.DB.prepare("UPDATE sync_pending SET received_at = ? WHERE data_type = 'steps'").bind(NOW).run();
        await queue("exercise", start, start + 60, "UPSERT", NOW);
        return [];
      },
      dailyRollUp: (type: string) => { order.push(type); return Promise.resolve([]); },
      listDaily: () => Promise.resolve([]),
      reconcile: (type: string) => { order.push(type); return Promise.resolve([]); },
    };
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 2, failed: 0 });
    expect(order).toEqual(["heart-rate", "steps"]);
    expect((await pending()).map((r) => [r.data_type, r.received_at])).toEqual([["exercise", NOW], ["steps", NOW]]);
    order.length = 0;
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 2, failed: 0 });
    expect(order).toEqual(["steps", "exercise"]);
    expect(await pending()).toEqual([]);
  });

  it("AC3 reuses the memoised civil-date and offset formatters across drains", async () => {
    const options = { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" } as const;
    dateTimeFormat("en-US", options);
    dateTimeFormat("en-US", { timeZone: "Europe/Madrid", timeZoneName: "longOffset" });
    const constructor = vi.spyOn(Intl, "DateTimeFormat");
    try {
      for (let i = 0; i < 2; i++) {
        await queue("heart-rate", NOW - 120, NOW - 60);
        await drainSyncPending(drainEnv(), fakeClient([{ ts: NOW - 120, avg: 60, min: 60, max: 60 }]).client);
      }
      expect(constructor).not.toHaveBeenCalled();
    } finally { constructor.mockRestore(); }
  });
});

describe("AC1 heart-rate upsert", () => {
  it("fetches a 60 s rollUp of the minute-aligned interval and stores one metric_minute row per point", async () => {
    await queue("heart-rate", at("2026-10-20T21:00:30Z"), at("2026-10-20T21:02:10Z"));
    const { client, calls } = fakeClient([
      { ts: at("2026-10-20T21:00:00Z"), avg: 66.5, min: 64, max: 70 },
      { ts: at("2026-10-20T21:02:00Z"), avg: 71, min: 71, max: 71 },
    ]);
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toEqual([{ start: "2026-10-20T21:00:00.000Z", end: "2026-10-20T21:03:00.000Z", windowSec: 60 }]);
    expect(await minutes()).toEqual([
      { metric: "hr", ts: at("2026-10-20T21:00:00Z"), tz_offset_min: 120, value: 66.5, vmin: 64, vmax: 70, n: null, source: "gh" },
      { metric: "hr", ts: at("2026-10-20T21:02:00Z"), tz_offset_min: 120, value: 71, vmin: 71, vmax: 71, n: null, source: "gh" },
    ]);
    expect(await pending()).toEqual([]);
  });

  it("uses the configured zone's offset at each point (DST end in Madrid)", async () => {
    await queue("heart-rate", at("2026-10-25T00:30:00Z"), at("2026-10-25T01:30:00Z"));
    const { client } = fakeClient([
      { ts: at("2026-10-25T00:59:00Z"), avg: 60, min: 60, max: 60 },
      { ts: at("2026-10-25T01:00:00Z"), avg: 61, min: 61, max: 61 },
    ]);
    await drainSyncPending(drainEnv(), client);
    expect((await minutes()).map((r) => r.tz_offset_min)).toEqual([120, 60]);
  });

  it("replaces existing minutes on re-delivery instead of duplicating them", async () => {
    const start = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", start, start + 60);
    await drainSyncPending(drainEnv(), fakeClient([{ ts: start, avg: 60, min: 59, max: 61 }]).client);
    await queue("heart-rate", start, start + 60);
    await drainSyncPending(drainEnv(), fakeClient([{ ts: start, avg: 62, min: 60, max: 65 }]).client);
    expect(await minutes()).toEqual([{ metric: "hr", ts: start, tz_offset_min: 120, value: 62, vmin: 60, vmax: 65, n: null, source: "gh" }]);
  });
});

describe("AC2 one 24-hour window per invocation", () => {
  it("stores 1,440 minutes through the Google client and drains every other type with query headroom", async () => {
    const start = at("2026-07-01T22:00:00Z");
    const types = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability",
      "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "exercise"];
    for (const type of types) await queue(type, start, start + (type === "heart-rate" ? 1 : 31) * 86400);
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json({
      rollupDataPoints: Array.from({ length: 1440 }, (_, i) => ({
        startTime: new Date((start + i * 60) * 1000).toISOString(),
        heartRate: { beatsPerMinuteAvg: 61, beatsPerMinuteMin: 60, beatsPerMinuteMax: 62 },
      })),
    })));
    const google = createGoogleClient({
      fetch, kv: { get: () => Promise.resolve("access") } as unknown as KVNamespace,
      clientId: "cid", clientSecret: "secret", refreshToken: "refresh", sleep: () => Promise.resolve(),
    });
    const dates = Array.from({ length: 31 }, (_, i) => new Date((start + 7200 + i * 86400) * 1000).toISOString().slice(0, 10));
    const client: Parameters<typeof drainSyncPending>[1] = {
      rollUpHeartRate: (a, b, window) => google.rollUpHeartRate(a, b, window),
      rollUpSteps: (a, b) => Promise.resolve(Array.from({ length: (at(b) - at(a)) / 3600 }, (_, i) => ({ ts: at(a) + i * 3600, steps: 10 }))),
      dailyRollUp: (type) => Promise.resolve(dates.map((date) => ({ date, value: type === "steps" ? { countSum: 100 } : { sumInFatBurnHeartZone: 10 } }))),
      listDaily: (type) => Promise.resolve(dates.map((date) => {
        const [year, month, day] = date.split("-").map(Number);
        const payload = type.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        return { [payload]: { date: { year, month, day }, beatsPerMinute: 60, averageHeartRateVariabilityMilliseconds: 40,
          averagePercentage: 97, breathsPerMinute: 16, nightlyTemperatureCelsius: 34, baselineTemperatureCelsius: 34 } };
      })),
      reconcile: (type, a) => Promise.resolve(Array.from({ length: 7 }, (_, i) => {
        const begin = at(a) + i * 86400;
        const interval = { startTime: new Date(begin * 1000).toISOString(), endTime: new Date((begin + 3600) * 1000).toISOString(),
          startUtcOffset: "7200s", endUtcOffset: "7200s" };
        return type === "sleep" ? { dataPointName: `sleep-${String(i)}`, sleep: { interval, stages: [{ ...interval, type: "LIGHT" }] } }
          : { dataPointName: `exercise-${String(i)}`, exercise: { interval, exerciseType: "RUNNING" } };
      })),
    };
    const batchSizes: number[] = [];
    const db = { prepare: (sql: string) => env.DB.prepare(sql), batch: (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return env.DB.batch(statements);
    } } as D1Database;
    expect(await drainSyncPending({ ...drainEnv(), DB: db }, client, { now: () => NOW })).toEqual({ processed: 10, failed: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
      range: { startTime: "2026-07-01T22:00:00.000Z", endTime: "2026-07-02T22:00:00.000Z" }, windowSize: "60s",
    });
    const hr = (await minutes()).filter((row) => row.metric === "hr");
    expect(hr).toHaveLength(1440);
    expect(hr[0]).toMatchObject({ ts: start, value: 61, vmin: 60, vmax: 62 });
    expect(hr.at(-1)?.ts).toBe(start + 86340);
    expect(batchSizes).toHaveLength(10);
    expect(batchSizes[0]).toBe(123);
    // Count the head SELECT and every batched statement, leaving room for cron work.
    expect(1 + batchSizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(300);
    expect((await pending()).some((row) => row.data_type === "heart-rate")).toBe(false);
  });

  it("prioritizes recent rows by receipt time over a historical backlog, one row per tick", async () => {
    const old = at("2026-07-01T22:00:00Z");
    for (let i = 0; i < 110; i++) await queue("heart-rate", old + i * 86400, old + (i + 1) * 86400, "UPSERT", NOW - 300 + i);
    await queue("heart-rate", NOW - 120, NOW - 60, "UPSERT", NOW - 10);
    await queue("heart-rate", NOW - 300, NOW - 240, "UPSERT", NOW - 5);
    const { client, calls } = fakeClient();
    for (let i = 0; i < 3; i++) {
      expect(await drainSyncPending(drainEnv(), client, { now: () => NOW })).toEqual({ processed: 1, failed: 0 });
      expect(await pending()).toHaveLength(111 - i);
    }
    expect(calls.map((call) => call.start)).toEqual([NOW - 120, NOW - 300, old].map((ts) => new Date(ts * 1000).toISOString()));
  });

  it("fetches only the first day of a long interval and keeps the rest queued", async () => {
    const start = at("2026-10-20T18:00:00Z");
    await queue("heart-rate", start, start + 3 * 86400 + 30);
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toEqual([{ start: "2026-10-20T18:00:00.000Z", end: "2026-10-21T18:00:00.000Z", windowSec: 60 }]);
    expect(await pending()).toEqual([
      { data_type: "heart-rate", start_ts: start + 86400, end_ts: start + 3 * 86400 + 30, operation: "UPSERT", received_at: NOW - 60, attempts: 0 }]);
  });

  it("drains successive windows without gaps through the minute-rounded end, then removes the row", async () => {
    const start = at("2026-10-20T18:00:00Z");
    await queue("heart-rate", start, start + 2 * 86400 + 30, "UPSERT", NOW - 60, 2);
    const { client, calls } = fakeClient();
    for (let i = 0; i < 3; i++) {
      await drainSyncPending(drainEnv(), client);
      if (i < 2) expect(await pending()).toEqual([{
        data_type: "heart-rate", start_ts: start + (i + 1) * 86400, end_ts: start + 2 * 86400 + 30,
        operation: "UPSERT", received_at: NOW - 60, attempts: 2,
      }]);
    }
    expect(calls.map((c) => [c.start, c.end])).toEqual([
      ["2026-10-20T18:00:00.000Z", "2026-10-21T18:00:00.000Z"],
      ["2026-10-21T18:00:00.000Z", "2026-10-22T18:00:00.000Z"],
      ["2026-10-22T18:00:00.000Z", "2026-10-22T18:01:00.000Z"],
    ]);
    expect(await pending()).toEqual([]);
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 0, failed: 0 });
  });

  it("merges an advanced row into an already queued remainder (latest receipt, fewest attempts)", async () => {
    const start = at("2026-10-20T18:00:00Z");
    await queue("heart-rate", start, start + 2 * 86400, "UPSERT", NOW - 300, 3);
    await queue("heart-rate", start + 86400, start + 2 * 86400, "UPSERT", NOW - 30, 4);
    await drainSyncPending(drainEnv(), fakeClient().client);
    expect(await pending()).toEqual([
      { data_type: "heart-rate", start_ts: start + 86400, end_ts: start + 2 * 86400, operation: "UPSERT", received_at: NOW - 30, attempts: 3 }]);
  });

  it("applies a DELETE before an UPSERT of the same interval and receipt time", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 60, "UPSERT", NOW - 60);
    await queue("heart-rate", t, t + 60, "DELETE", NOW - 60);
    const { client, calls } = fakeClient([{ ts: t, avg: 70, min: 70, max: 70 }]);
    await drainSyncPending(drainEnv(), client);
    expect(calls).toHaveLength(0);
    expect((await pending()).map((r) => r.operation)).toEqual(["UPSERT"]);
    await drainSyncPending(drainEnv(), client);
    expect((await minutes()).map((r) => r.value)).toEqual([70]);
  });

  it("keeps a row whose notification was re-received during the fetch", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 60);
    const client = {
      rollUpSteps: () => Promise.resolve([]),
      async rollUpHeartRate(): Promise<RollUpPoint[]> {
        await env.DB.prepare("UPDATE sync_pending SET received_at = ?").bind(NOW).run();
        return [{ ts: t, avg: 61, min: 61, max: 61 }];
      },
      dailyRollUp: () => Promise.reject(new Error("unexpected dailyRollUp")),
      listDaily: () => Promise.reject(new Error("unexpected listDaily")),
      reconcile: () => Promise.reject(new Error("unexpected reconcile")),
    };
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 1, failed: 0 });
    expect(await pending()).toEqual([{ data_type: "heart-rate", start_ts: t, end_ts: t + 60, operation: "UPSERT", received_at: NOW, attempts: 0 }]);
    expect(await minutes()).toHaveLength(1);
  });

  it("drains the oldest received row first and only one heart-rate row per run", async () => {
    await queue("heart-rate", at("2026-10-20T10:00:00Z"), at("2026-10-20T10:05:00Z"), "UPSERT", NOW - 30);
    await queue("heart-rate", at("2026-10-20T12:00:00Z"), at("2026-10-20T12:05:00Z"), "UPSERT", NOW - 90);
    const { client, calls } = fakeClient();
    await drainSyncPending(drainEnv(), client);
    expect(calls.map((c) => c.start)).toEqual(["2026-10-20T12:00:00.000Z"]);
    expect((await pending()).map((r) => r.start_ts)).toEqual([at("2026-10-20T10:00:00Z")]);
  });

  it("returns zeros and calls nothing when the queue is empty", async () => {
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it("leaves rows of other data types untouched", async () => {
    await queue("weight", at("2026-10-20T00:00:00Z"), at("2026-10-20T08:00:00Z"));
    await queue("weight", at("2026-10-20T10:00:00Z"), at("2026-10-20T10:15:00Z"));
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(await pending()).toHaveLength(2);
  });
});

describe("AC3 heart-rate delete", () => {
  it("deletes only gh hr minutes in [start, end) for unaligned endpoints", async () => {
    const t = at("2026-10-20T21:00:00Z");
    for (const d of [0, 60, 120, 180]) await seedMinute("hr", "gh", t + d);
    await seedMinute("hr", "manual", t + 60);
    await seedMinute("steps", "gh", t + 60);
    await queue("heart-rate", t + 30, t + 180, "DELETE");
    await drainSyncPending(drainEnv(), fakeClient().client);
    const rows = (await env.DB.prepare("SELECT metric, source, ts FROM metric_minute ORDER BY metric, source, ts").all()).results;
    expect(rows).toEqual([
      { metric: "hr", source: "gh", ts: t }, { metric: "hr", source: "gh", ts: t + 180 },
      { metric: "hr", source: "manual", ts: t + 60 }, { metric: "steps", source: "gh", ts: t + 60 },
    ]);
  });

  it("deletes stored minutes inside the interval without calling Google", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 180);
    await drainSyncPending(drainEnv(), fakeClient([0, 60, 120, 180].map((d) => ({ ts: t + d, avg: 60, min: 60, max: 60 }))).client);
    await env.DB.prepare("DELETE FROM sync_pending").run();
    await queue("heart-rate", t + 60, t + 180, "DELETE");
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toHaveLength(0);
    expect((await minutes()).map((r) => r.ts)).toEqual([t, t + 180]);
    expect(await pending()).toEqual([]);
  });
});

describe("AC4 failures", () => {
  it("keeps the whole queued interval and writes no partial minutes when Google page 2 fails", async () => {
    const start = at("2026-10-20T00:00:00Z");
    await queue("heart-rate", start, start + 2 * 86400);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({
        rollupDataPoints: [{ startTime: new Date(start * 1000).toISOString(),
          heartRate: { beatsPerMinuteAvg: 61, beatsPerMinuteMin: 60, beatsPerMinuteMax: 62 } }],
        nextPageToken: "page-2",
      }))
      .mockImplementation(() => Promise.resolve(Response.json({}, { status: 503 })));
    const google = createGoogleClient({
      fetch, kv: { get: () => Promise.resolve("access") } as unknown as KVNamespace,
      clientId: "cid", clientSecret: "secret", refreshToken: "refresh", sleep: () => Promise.resolve(),
    });
    expect(await drainSyncPending(drainEnv(), google)).toEqual({ processed: 0, failed: 1 });
    expect(fetch).toHaveBeenCalledTimes(5);
    const body = { range: { startTime: "2026-10-20T00:00:00.000Z", endTime: "2026-10-21T00:00:00.000Z" }, windowSize: "60s" };
    expect(fetch.mock.calls.map((call): unknown => JSON.parse(call[1]?.body as string))).toEqual([
      body, ...Array.from({ length: 4 }, () => ({ ...body, pageToken: "page-2" })),
    ]);
    expect(await pending()).toEqual([{ data_type: "heart-rate", start_ts: start, end_ts: start + 2 * 86400,
      operation: "UPSERT", received_at: NOW - 60, attempts: 1 }]);
    expect(await minutes()).toEqual([]);
  });

  it("keeps the row and counts an attempt when Google fails, writing nothing", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 60);
    expect(await drainSyncPending(drainEnv(), fakeClient(new Error("503")).client)).toEqual({ processed: 0, failed: 1 });
    expect(await pending()).toEqual([{ data_type: "heart-rate", start_ts: t, end_ts: t + 60, operation: "UPSERT", received_at: NOW - 60, attempts: 1 }]);
    expect(await minutes()).toEqual([]);
  });

  it("skips rows that reached 5 attempts and drains the next one", async () => {
    await queue("heart-rate", at("2026-10-20T09:00:00Z"), at("2026-10-20T09:01:00Z"), "UPSERT", NOW - 900, 5);
    await queue("heart-rate", at("2026-10-20T10:00:00Z"), at("2026-10-20T10:01:00Z"), "UPSERT", NOW - 30);
    const { client, calls } = fakeClient();
    await drainSyncPending(drainEnv(), client);
    expect(calls.map((c) => c.start)).toEqual(["2026-10-20T10:00:00.000Z"]);
    expect((await pending()).map((r) => r.attempts)).toEqual([5]);
  });

  it("counts attempts up to 5 and then leaves an exhausted-only queue alone", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 60, "UPSERT", NOW - 60, 3);
    const failing = fakeClient(new Error("503"));
    await drainSyncPending(drainEnv(), failing.client);
    await drainSyncPending(drainEnv(), failing.client);
    expect((await pending()).map((r) => r.attempts)).toEqual([5]);
    expect(await drainSyncPending(drainEnv(), failing.client)).toEqual({ processed: 0, failed: 0 });
    expect(failing.calls).toHaveLength(2);
  });

  it("counts a failure and rolls back the metric writes when the queue mutation fails", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 7200);
    await withTrigger("DELETE", () => expect(drainSyncPending(drainEnv(), fakeClient([{ ts: t, avg: 1, min: 1, max: 1 }]).client)).resolves.toEqual({ processed: 0, failed: 1 }));
    expect(await minutes()).toEqual([]);
    expect(await pending()).toEqual([{ data_type: "heart-rate", start_ts: t, end_ts: t + 7200, operation: "UPSERT", received_at: NOW - 60, attempts: 1 }]);
  });

  it("rejects without changing the row when the attempt increment fails", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 60, "UPSERT", NOW - 60, 1);
    await withTrigger("UPDATE", () => expect(drainSyncPending(drainEnv(), fakeClient(new Error("503")).client)).rejects.toThrow());
    expect((await pending()).map((r) => r.attempts)).toEqual([1]);
  });
});
