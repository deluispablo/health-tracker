import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createGoogleClient } from "../../src/google/client";
import { drainSyncPending } from "../../src/ingest/drain";

const NOW = Date.parse("2026-10-22T12:00:00Z") / 1000;
const opts = { now: () => NOW };
const types = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability",
  "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "exercise"];
const drainEnv = (DB = env.DB) => ({ DB, USER_TZ: "UTC" });
const client = (): Parameters<typeof drainSyncPending>[1] => ({
  rollUpHeartRate: vi.fn(() => Promise.resolve([])), rollUpSteps: vi.fn(() => Promise.resolve([])),
  dailyRollUp: vi.fn(() => Promise.resolve([])), listDaily: vi.fn(() => Promise.resolve([])),
  reconcile: vi.fn(() => Promise.resolve([])),
});
async function queue(type: string, start: number, end = start + 60, receipt = start, attempts = 0) {
  await env.DB.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts)
    VALUES (?, ?, ?, 'UPSERT', ?, ?)`).bind(type, start, end, receipt, attempts).run();
}
const pending = async () => (await env.DB.prepare("SELECT * FROM sync_pending ORDER BY data_type, received_at, start_ts").all()).results;
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["sync_pending", "metric_minute", "metric_daily", "rollup_dirty", "sleep_stage", "sleep_session", "workout"]
    .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});
afterEach(() => { vi.restoreAllMocks(); });

it("drains every type in receipt order, including four steps notifications", async () => {
  for (const type of types) {
    for (const i of [3, 1, 2, 0]) await queue(type, NOW - 3600 + i * 60, NOW - 3540 + i * 60, NOW - 100 + i);
  }
  const google = client();
  expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 40, failed: 0 });
  expect(await pending()).toEqual([]);
  expect(vi.mocked(google.rollUpHeartRate).mock.calls.map(([start]) => Date.parse(start) / 1000))
    .toEqual([0, 1, 2, 3].map((i) => NOW - 3600 + i * 60));
  expect(google.dailyRollUp).toHaveBeenCalledTimes(8);
  expect(google.listDaily).toHaveBeenCalledTimes(20);
  expect(google.reconcile).toHaveBeenCalledTimes(8);
});

it("stores four steps notifications in receipt order in one tick", async () => {
  for (const i of [3, 1, 2, 0]) await queue("steps", NOW - (i + 1) * 86400, NOW - (i + 1) * 86400 + 60, NOW - 100 + i);
  const google = client();
  google.dailyRollUp = vi.fn((_type: string, date: string) => Promise.resolve([{ date, value: { countSum: Number(date.slice(-2)) } }]));
  expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 4, failed: 0 });
  expect(vi.mocked(google.dailyRollUp).mock.calls.map(([, date]) => date))
    .toEqual(["2026-10-21", "2026-10-20", "2026-10-19", "2026-10-18"]);
  expect((await env.DB.prepare("SELECT local_date, value FROM metric_daily WHERE metric = 'steps' ORDER BY local_date").all()).results)
    .toEqual([18, 19, 20, 21].map((day) => ({ local_date: `2026-10-${String(day)}`, value: day })));
  expect(await pending()).toEqual([]);
});

it("drains all recent heart-rate rows and one backfill at a strict 24-hour boundary", async () => {
  for (const i of [0, 1, 2]) await queue("heart-rate", NOW - 3 * 86400 + i * 60);
  await queue("heart-rate", NOW - 86400 - 60, NOW - 86400);
  await queue("heart-rate", NOW - 120);
  const google = client();
  expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 3, failed: 0 });
  expect(vi.mocked(google.rollUpHeartRate).mock.calls.map(([start]) => Date.parse(start) / 1000))
    .toEqual([NOW - 3 * 86400, NOW - 86400 - 60, NOW - 120]);
  expect(await pending()).toHaveLength(2);
});

it("counts the queue read, all types' writes and failure updates against one statement budget", async () => {
  for (let i = 0; i < 199; i++) await queue("heart-rate", NOW - 20040 + i * 60);
  await queue("steps", NOW - 120);
  await queue("daily-resting-heart-rate", NOW - 120);
  const before = await pending();
  const google = client();
  google.rollUpHeartRate = (start) => {
    const ts = Date.parse(start) / 1000;
    if (ts === NOW - 20040) return Promise.reject(new Error("Google API 503"));
    return Promise.resolve([{ ts, avg: 60, min: 60, max: 60 }]);
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  let count = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
    if (key === "all" || key === "run") return () => { count++; return target[key](); };
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } });
  const db = { prepare: (sql: string) => wrap(env.DB.prepare(sql)), batch: (statements: D1PreparedStatement[]) => {
    count += statements.length;
    return env.DB.batch(statements);
  } } as D1Database;
  expect(await drainSyncPending(drainEnv(db), google, opts)).toEqual({ processed: 198, failed: 1 });
  expect(count).toBe(794);
  expect(google.listDaily).not.toHaveBeenCalled();
  expect(await pending()).toEqual([before[0], { ...before[1], attempts: 1 }, before.at(-1)]);
});

it.each([false, true])("processes an oversized row alone, deferring it after earlier work: %s", async (earlierWork) => {
  if (earlierWork) await queue("heart-rate", NOW - 7200);
  await queue("sleep", NOW - 3600);
  await queue("sleep", NOW - 120);
  const before = await pending();
  const google = client();
  google.reconcile = vi.fn((_type: string, start: string) => Promise.resolve(Array.from({ length: 800 }, (_, i) => ({
    dataPointName: `sleep-${String(i)}`, sleep: {
      interval: { startTime: start, endTime: new Date((NOW - 3540) * 1000).toISOString(), endUtcOffset: "0s" },
    },
  }))));
  expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 1, failed: 0 });
  expect(google.reconcile).toHaveBeenCalledTimes(1);
  expect(await pending()).toEqual(earlierWork ? before.slice(1) : [before[1]]);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM sleep_session").first())?.n).toBe(earlierWork ? 0 : 800);
  if (earlierWork) {
    expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 1, failed: 0 });
    expect(await pending()).toEqual([before[2]]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM sleep_session").first())?.n).toBe(800);
  }
});

it("makes progress for a later type across budget-limited ticks despite newer heart-rate rows", async () => {
  for (let i = 0; i < 200; i++) await queue("heart-rate", NOW - 20040 + i * 60, undefined, NOW - 1000 + i);
  await queue("exercise", NOW - 120, undefined, NOW - 800);
  const google = client();
  google.rollUpHeartRate = vi.fn((start: string) => Promise.resolve([{ ts: Date.parse(start) / 1000, avg: 60, min: 60, max: 60 }]));
  expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 199, failed: 0 });
  expect(google.reconcile).not.toHaveBeenCalled();
  for (let i = 0; i < 200; i++) await queue("heart-rate", NOW - 36000 + i * 60, undefined, NOW - 700 + i);
  expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 199, failed: 0 });
  expect(google.reconcile).toHaveBeenCalledExactlyOnceWith("exercise",
    new Date((NOW - 120) * 1000).toISOString(), new Date(NOW * 1000).toISOString());
  expect((await pending()).every((row) => row.data_type === "heart-rate")).toBe(true);
});

it("stops the tick after retrying Google 429 and only increments the failing steps row", async () => {
  await queue("steps", NOW - 2 * 86400);
  await queue("steps", NOW - 86400);
  const before = await pending();
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("", { status: 429 })));
  const sleep = vi.fn(() => Promise.resolve());
  const google = createGoogleClient({ fetch, sleep,
    kv: { get: () => Promise.resolve("access") } as unknown as KVNamespace,
    clientId: "cid", clientSecret: "secret", refreshToken: "refresh" });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 0, failed: 1 });
  expect(sleep).toHaveBeenCalledTimes(3);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(log).toHaveBeenCalledExactlyOnceWith("steps", "Error", 429);
  expect(await pending()).toEqual([{ ...before[0], attempts: 1 }, before[1]]);
});

it("starts rows before the wall-clock deadline and leaves later rows untouched at 60 seconds", async () => {
  for (let i = 0; i < 3; i++) await queue("heart-rate", NOW - 3600 + i * 60);
  const before = await pending();
  let wallTime = NOW * 1000;
  vi.spyOn(Date, "now").mockImplementation(() => wallTime);
  const google = client();
  google.rollUpHeartRate = vi.fn((start: string) => {
    wallTime += Date.parse(start) / 1000 === NOW - 3600 ? 59_999 : 1;
    return Promise.resolve([{ ts: Date.parse(start) / 1000, avg: 60, min: 60, max: 60 }]);
  });
  expect(await drainSyncPending(drainEnv(), google, opts)).toEqual({ processed: 2, failed: 0 });
  expect(google.rollUpHeartRate).toHaveBeenCalledTimes(2);
  expect(await pending()).toEqual([before[2]]);
  expect((await env.DB.prepare("SELECT ts FROM metric_minute ORDER BY ts").all()).results)
    .toEqual(before.slice(0, 2).map((row) => ({ ts: row.start_ts })));
});
