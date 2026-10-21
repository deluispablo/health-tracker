import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGoogleClient } from "../../src/google/client";
import { drainSyncPending } from "../../src/ingest/drain";

const START = Date.parse("2026-10-06T10:00:00Z") / 1000;
const interval = { startTime: "2026-10-06T10:00:00Z", endTime: "2026-10-06T10:01:00Z", startUtcOffset: "7200s", endUtcOffset: "7200s" };
const types = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "exercise"] as const;
type Failure = "google" | "mapping" | "binding" | "batch";
const drainEnv = (DB = env.DB) => ({ DB, USER_TZ: "Europe/Madrid" });

function client(value: number, failingType = "", failure?: Failure): Parameters<typeof drainSyncPending>[1] {
  function answer<T extends object>(type: string, point: T): T {
    if (type === failingType && failure === "google") throw new Error("Google down");
    return type === failingType && failure === "mapping"
      ? new Proxy(point, { get() { throw new Error("mapping failed"); } }) : point;
  }
  return {
    rollUpHeartRate: () => Promise.resolve([answer("heart-rate", { ts: START, avg: value, min: value, max: value })]),
    dailyRollUp: () => Promise.resolve([answer("steps", { date: "2026-10-06", value: { countSum: value } })]),
    listDaily: () => Promise.resolve([answer("daily-resting-heart-rate", {
      dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 6 }, beatsPerMinute: value },
    })]),
    reconcile: (type) => Promise.resolve([answer(type, type === "sleep"
      ? { dataPointName: "sleep-id", sleep: { interval, summary: { minutesAsleep: value }, stages: [{ ...interval, type: "LIGHT" }] } }
      : { dataPointName: "exercise-id", exercise: { interval, exerciseType: "RUNNING", metricsSummary: { caloriesKcal: value } } })]),
  };
}

async function queue(queuedTypes: readonly string[] = types) {
  await env.DB.batch(queuedTypes.map((type) => env.DB.prepare(`INSERT INTO sync_pending
    (data_type, start_ts, end_ts, operation, received_at) VALUES (?, ?, ?, 'UPSERT', 1)`).bind(type, START, START + 60)));
}

const pending = async () => (await env.DB.prepare("SELECT data_type, attempts FROM sync_pending ORDER BY data_type").all()).results;
const targets: Record<string, { table: string; metric?: string }> = {
  "heart-rate": { table: "metric_minute", metric: "hr" }, steps: { table: "metric_daily", metric: "steps" },
  "daily-resting-heart-rate": { table: "metric_daily", metric: "rhr" }, sleep: { table: "sleep_session" }, exercise: { table: "workout" },
};
async function stored(type: string) {
  const { table, metric } = targets[type];
  const rows = (await env.DB.prepare(`SELECT * FROM ${table}${metric ? " WHERE metric = ?" : ""}`).bind(...(metric ? [metric] : [])).all()).results;
  return type === "sleep" ? [rows, (await env.DB.prepare("SELECT * FROM sleep_stage").all()).results] : rows;
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["DROP TRIGGER IF EXISTS fail_write", "DROP TRIGGER IF EXISTS fail_attempt",
    ...["sync_pending", "metric_minute", "metric_daily", "sleep_stage", "sleep_session", "workout"].map((table) => `DELETE FROM ${table}`)]
    .map((sql) => env.DB.prepare(sql)));
});

describe.each(types)("T23 AC1/AC3 isolation for %s", (type) => {
  it.each<Failure>(["google", "mapping", "binding", "batch"])("counts a %s failure, preserves stored data and drains other types", async (failure) => {
    await queue();
    expect(await drainSyncPending(drainEnv(), client(99), { now: () => 1 })).toEqual({ processed: 5, failed: 0 });
    const before = await stored(type);
    await queue();
    const { table, metric } = targets[type];
    let db = env.DB;
    if (failure === "batch") {
      await env.DB.prepare(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table}
        ${metric ? `WHEN NEW.metric = '${metric}'` : ""} BEGIN SELECT RAISE(ABORT, 'write failed'); END`).run();
    } else if (failure === "binding") {
      db = { prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (!sql.startsWith(`INSERT INTO ${table} `)) return statement;
        return { bind: (...values: unknown[]) => {
          if (!metric || values[0] === metric) throw new Error("bind failed");
          return statement.bind(...values);
        } };
      }, batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements) } as D1Database;
    }
    expect(await drainSyncPending(drainEnv(db), client(61, type, failure), { now: () => 2 })).toEqual({ processed: 4, failed: 1 });
    expect(await pending()).toEqual([{ data_type: type, attempts: 1 }]);
    expect(await stored(type)).toEqual(before);
  });
});

it("T23 AC1 rejects when the attempt update after a batch failure also fails", async () => {
  await queue();
  await env.DB.prepare("CREATE TRIGGER fail_write BEFORE INSERT ON metric_minute BEGIN SELECT RAISE(ABORT, 'write failed'); END").run();
  await env.DB.prepare("CREATE TRIGGER fail_attempt BEFORE UPDATE ON sync_pending BEGIN SELECT RAISE(ABORT, 'attempt failed'); END").run();
  await expect(drainSyncPending(drainEnv(), client(61))).rejects.toThrow("attempt failed");
  expect(await pending()).toHaveLength(5);
  expect((await pending()).every((row) => row.attempts === 0)).toBe(true);
  expect(await stored("heart-rate")).toEqual([]);
});

it("T23 AC2 stores only the valid minute when a rollup point lacks its average", async () => {
  await queue(["heart-rate"]);
  const googleClient = createGoogleClient({
    fetch: () => Promise.resolve(Response.json({ rollupDataPoints: [
      { startTime: interval.startTime, heartRate: { beatsPerMinuteMin: 60, beatsPerMinuteMax: 62 } },
      { startTime: interval.endTime, heartRate: { beatsPerMinuteAvg: 61, beatsPerMinuteMin: 60, beatsPerMinuteMax: 62 } },
    ] })),
    kv: { get: () => Promise.resolve("access") } as unknown as KVNamespace,
    clientId: "cid", clientSecret: "secret", refreshToken: "refresh", sleep: () => Promise.resolve(),
  });
  expect(await drainSyncPending(drainEnv(), googleClient)).toEqual({ processed: 1, failed: 0 });
  expect((await env.DB.prepare("SELECT ts, value, vmin, vmax FROM metric_minute").all()).results)
    .toEqual([{ ts: START + 60, value: 61, vmin: 60, vmax: 62 }]);
  expect(await pending()).toEqual([]);
});
