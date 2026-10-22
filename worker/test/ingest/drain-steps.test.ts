import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainSyncPending } from "../../src/ingest/drain";
import { recomputeDailySummary } from "../../src/rollup/daily";

const at = (s: string) => Date.parse(s) / 1000;
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const start = at("2026-10-24T22:00:00Z");
const end = at("2026-10-25T23:00:00Z");
const drainEnv = (USER_TZ = "Europe/Madrid") => ({ DB: env.DB, USER_TZ });
function fake() {
  const calls: string[][] = [];
  return { calls, client: {
    rollUpHeartRate: () => Promise.resolve([]), listDaily: () => Promise.resolve([]), reconcile: () => Promise.resolve([]),
    dailyRollUp: (_type: string, first: string, last: string) => {
      calls.push([first, last]);
      return Promise.resolve([{ date: first, value: { countSum: "8123" } }]);
    },
    rollUpSteps: (a: string, b: string): Promise<{ ts: number; steps: number }[]> => {
      calls.push([a, b]);
      return Promise.resolve([{ ts: at(a), steps: 0 }, { ts: at(a) + 3600, steps: 72 }]);
    },
  } };
}
async function queue(a = start, b = end, operation = "UPSERT", type = "steps") {
  await env.DB.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at)
    VALUES (?, ?, ?, ?, 1)`).bind(type, a, b, operation).run();
}
async function seed(ts: number, source = "gh", metric = "steps_h") {
  await env.DB.prepare(`INSERT INTO metric_minute (metric, ts, tz_offset_min, value, vmin, vmax, source)
    VALUES (?, ?, 120, 99, 99, 99, ?)`).bind(metric, ts, source).run();
}
const hourly = async () => (await env.DB.prepare("SELECT * FROM metric_minute ORDER BY metric, source, ts").all()).results;
const pending = async () => (await env.DB.prepare("SELECT * FROM sync_pending ORDER BY data_type").all()).results;
async function snapshot() {
  return Promise.all([hourly(), ...["metric_daily", "rollup_dirty", "rollup_seq"].map(async (table) =>
    (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)]);
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["DROP TRIGGER IF EXISTS fail_hour", ...["metric_minute", "metric_daily", "daily_summary", "sync_pending", "rollup_dirty"]
    .map((t) => `DELETE FROM ${t}`)].map((sql) => env.DB.prepare(sql)));
});

describe("T36 AC2 hourly ingestion", () => {
  it("replaces stale hours on subset and empty replays, preserving neighbours and other sources/metrics", async () => {
    await seed(start - 3600); await seed(end); await seed(start); await seed(start + 7200);
    await seed(start, "manual"); await seed(start, "gh", "steps");
    const { client, calls } = fake();
    client.rollUpSteps = (a, b) => {
      calls.push([a, b]);
      return Promise.resolve([{ ts: start - 1, steps: 5 }, { ts: start, steps: 0 }, { ts: start + 3600, steps: 72 }, { ts: end, steps: 5 }]);
    };
    for (let i = 0; i < 2; i++) {
      await queue();
      expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 1, failed: 0 });
    }
    expect(calls).toEqual(Array.from({ length: 2 }, () => [["2026-10-25", "2026-10-26"], [iso(start), iso(end)]]).flat());
    const rows = await hourly();
    expect(rows.filter((r) => r.metric === "steps_h" && r.source === "gh")).toEqual([
      expect.objectContaining({ ts: start - 3600, value: 99 }),
      { metric: "steps_h", ts: start, tz_offset_min: 120, value: 0, vmin: 0, vmax: 0, n: null, source: "gh" },
      { metric: "steps_h", ts: start + 3600, tz_offset_min: 120, value: 72, vmin: 72, vmax: 72, n: null, source: "gh" },
      expect.objectContaining({ ts: end, value: 99 }),
    ]);
    expect(rows.filter((r) => r.metric === "steps" || r.source === "manual")).toHaveLength(2);
    client.rollUpSteps = () => Promise.resolve([]);
    await queue(start, end, "DELETE");
    await drainSyncPending(drainEnv(), client);
    expect((await hourly()).filter((r) => r.metric === "steps_h" && r.source === "gh").map((r) => r.ts)).toEqual([start - 3600, end]);
  });

  it("stores a full 31-date slice within 50 D1 queries, chunking at 13 dates over fall-back", async () => {
    await queue(at("2026-10-15T10:00:00Z"), at("2026-12-01T10:00:00Z"));
    const { client, calls } = fake();
    client.dailyRollUp = (_type, first, last) => {
      calls.push([first, last]);
      return Promise.resolve(Array.from({ length: 31 }, (_, i) => ({
        date: iso(at(`${first}T00:00:00Z`) + i * 86400).slice(0, 10), value: { countSum: "8123" },
      })));
    };
    client.rollUpSteps = (lo, hi) => {
      calls.push([lo, hi]);
      return Promise.resolve(Array.from({ length: (at(hi) - at(lo)) / 3600 }, (_, i) => ({ ts: at(lo) + i * 3600, steps: i })));
    };
    const batchSizes: number[] = [];
    const db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => {
        batchSizes.push(statements.length);
        return env.DB.batch(statements);
      },
    } as D1Database;
    expect(await drainSyncPending({ ...drainEnv(), DB: db }, client)).toEqual({ processed: 1, failed: 0 });
    expect(batchSizes).toHaveLength(1);
    // The head SELECT plus each statement in the atomic batch counts toward the invocation limit.
    expect(1 + batchSizes[0]).toBeLessThanOrEqual(50);
    expect(await hourly()).toHaveLength(31 * 24 + 1);
    expect((await env.DB.prepare("SELECT * FROM metric_daily WHERE metric = 'steps'").all()).results).toHaveLength(31);
    expect(calls).toEqual([
      ["2026-10-15", "2026-11-15"],
      ["2026-10-14T22:00:00.000Z", "2026-10-27T23:00:00.000Z"],
      ["2026-10-27T23:00:00.000Z", "2026-11-09T23:00:00.000Z"],
      ["2026-11-09T23:00:00.000Z", "2026-11-14T23:00:00.000Z"],
    ]);
    expect((await pending()).map((r) => [r.start_ts, r.end_ts, r.attempts])).toEqual([
      [at("2026-11-14T10:00:00Z"), at("2026-12-01T10:00:00Z"), 0],
    ]);
  });

  it.each([
    ["Europe/Madrid", "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z", 60, 120, "2026-03-29T01:00:00Z"],
    ["Europe/Madrid", "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z", 120, 60, "2026-10-25T01:00:00Z"],
    ["Asia/Kolkata", "2026-10-24T18:30:00Z", "2026-10-25T18:30:00Z", 330, 330, null],
    ["UTC", "2026-10-25T00:00:00Z", "2026-10-26T00:00:00Z", 0, 0, null],
  ] as const)("uses local midnights and per-window offsets in %s (%s)", async (zone, a, b, firstOffset, lastOffset, transitionTime) => {
    await queue(at(a), at(b));
    const { client, calls } = fake();
    client.rollUpSteps = (lo, hi) => {
      calls.push([lo, hi]);
      return Promise.resolve(Array.from({ length: (at(hi) - at(lo)) / 3600 }, (_, i) => ({ ts: at(lo) + i * 3600, steps: i })));
    };
    expect(await drainSyncPending(drainEnv(zone), client)).toEqual({ processed: 1, failed: 0 });
    expect(calls[1]).toEqual([iso(at(a)), iso(at(b))]);
    const rows = await hourly();
    expect(rows).toHaveLength((at(b) - at(a)) / 3600);
    expect(rows[0]?.tz_offset_min).toBe(firstOffset);
    expect(rows.at(-1)?.tz_offset_min).toBe(lastOffset);
    if (transitionTime) {
      const transition = at(transitionTime);
      expect(rows.filter((r) => r.ts === transition - 3600 || r.ts === transition)
        .map((r) => [r.ts, r.tz_offset_min])).toEqual([
        [transition - 3600, firstOffset], [transition, lastOffset],
      ]);
    }
  });

  it.each(["later call", "write"])("rolls the whole steps row back on %s failure and retries, retaining concurrent receipts", async (failure) => {
    const a = at("2026-10-15T10:00:00Z"), b = at("2026-11-15T10:00:00Z");
    await seed(start);
    await env.DB.prepare("INSERT INTO metric_daily (metric, local_date, value, updated_at) VALUES ('steps', '2026-10-15', 10, 1)").run();
    await queue(a, b);
    const before = await snapshot();
    const { client } = fake();
    let n = 0;
    const original = client.rollUpSteps;
    client.rollUpSteps = async (lo, hi) => {
      n++;
      if (n === 2) {
        await env.DB.prepare("UPDATE sync_pending SET received_at = 2").run();
        if (failure === "later call") throw new Error("hourly unavailable");
      }
      return original(lo, hi);
    };
    if (failure === "write") await env.DB.prepare(`CREATE TRIGGER fail_hour BEFORE INSERT ON metric_minute
      WHEN NEW.metric = 'steps_h' BEGIN SELECT RAISE(ABORT, 'hourly write failed'); END`).run();
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 0, failed: 1 });
    expect(await snapshot()).toEqual(before);
    expect(await pending()).toEqual([{ data_type: "steps", start_ts: a, end_ts: b, operation: "UPSERT", received_at: 2, attempts: 1 }]);
    await env.DB.prepare("DROP TRIGGER IF EXISTS fail_hour").run();
    client.rollUpSteps = async (lo, hi) => {
      await env.DB.prepare("UPDATE sync_pending SET received_at = 3").run();
      return original(lo, hi);
    };
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 1, failed: 0 });
    expect((await pending()).map((r) => [r.received_at, r.attempts])).toEqual([[3, 1]]);
    expect(await snapshot()).not.toEqual(before);
    client.rollUpSteps = original;
    await drainSyncPending(drainEnv(), client);
    expect((await pending()).map((r) => r.start_ts)).toEqual([at("2026-11-14T10:00:00Z")]);
  });

  it("isolates hourly call failures from other types", async () => {
    await queue(); await queue(start, end, "UPSERT", "daily-resting-heart-rate");
    const { client } = fake();
    client.rollUpSteps = () => Promise.reject(new Error("down"));
    expect(await drainSyncPending(drainEnv(), client)).toEqual({ processed: 1, failed: 1 });
    expect((await pending()).map((r) => [r.data_type, r.attempts])).toEqual([["steps", 1]]);
  });

  it("AC4 leaves daily totals and HR wear independent of hourly sums", async () => {
    await queue();
    await drainSyncPending(drainEnv(), fake().client);
    await recomputeDailySummary(env.DB, "2026-10-25", "2026-10-25", 1);
    expect(await env.DB.prepare("SELECT steps, hr_wear_min FROM daily_summary").first()).toEqual({ steps: 8123, hr_wear_min: null });
  });
});
