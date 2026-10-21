import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RollUpPoint } from "../../src/google/client";
import { drainSyncPending } from "../../src/ingest/drain";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T00:00:00Z");
const drainEnv = () => ({ DB: env.DB, USER_TZ: "Europe/Madrid" });

interface Call { start: string; end: string; windowSec: number }
function fakeClient(points: RollUpPoint[] | Error = []) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      rollUpHeartRate(start: string, end: string, windowSec: number): Promise<RollUpPoint[]> {
        calls.push({ start, end, windowSec });
        return points instanceof Error ? Promise.reject(points) : Promise.resolve(points);
      },
    },
  };
}

async function queue(type: string, start: number, end: number, operation = "UPSERT", receivedAt = NOW - 60, attempts = 0) {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(type, start, end, operation, receivedAt, attempts).run();
}
const pending = async () => (await env.DB.prepare(
  "SELECT data_type, start_ts, end_ts, operation, attempts FROM sync_pending ORDER BY data_type, start_ts").all()).results;
const minutes = async () => (await env.DB.prepare(
  "SELECT metric, ts, tz_offset_min, value, vmin, vmax, n, source FROM metric_minute ORDER BY ts").all()).results;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM sync_pending"), env.DB.prepare("DELETE FROM metric_minute")]);
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

describe("AC2 one 60-minute window per invocation", () => {
  it("fetches only the first hour of a long interval and keeps the rest queued", async () => {
    const start = at("2026-10-20T18:00:00Z");
    await queue("heart-rate", start, start + 3 * 3600 + 30);
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toEqual([{ start: "2026-10-20T18:00:00.000Z", end: "2026-10-20T19:00:00.000Z", windowSec: 60 }]);
    expect(await pending()).toEqual([{ data_type: "heart-rate", start_ts: start + 3600, end_ts: start + 3 * 3600 + 30, operation: "UPSERT", attempts: 0 }]);
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
    await queue("sleep", at("2026-10-20T00:00:00Z"), at("2026-10-20T08:00:00Z"));
    await queue("steps", at("2026-10-20T10:00:00Z"), at("2026-10-20T10:15:00Z"));
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(await pending()).toHaveLength(2);
  });
});

describe("AC3 heart-rate delete", () => {
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
  it("keeps the row and counts an attempt when Google fails, writing nothing", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 60);
    expect(await drainSyncPending(drainEnv(), fakeClient(new Error("503")).client)).toEqual({ processed: 0, failed: 1 });
    expect(await pending()).toEqual([{ data_type: "heart-rate", start_ts: t, end_ts: t + 60, operation: "UPSERT", attempts: 1 }]);
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

  it("rejects when D1 fails so the cron run is marked failed and the row stays", async () => {
    const t = at("2026-10-20T21:00:00Z");
    await queue("heart-rate", t, t + 60);
    const broken = { prepare: env.DB.prepare.bind(env.DB), batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
    await expect(drainSyncPending({ DB: broken, USER_TZ: "Europe/Madrid" }, fakeClient([{ ts: t, avg: 1, min: 1, max: 1 }]).client))
      .rejects.toThrow();
    expect(await pending()).toHaveLength(1);
  });
});
