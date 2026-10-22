import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthDaily } from "../../src/mcp/tools/daily";
import { healthWorkouts } from "../../src/mcp/tools/workouts";

interface Workout {
  local_date: string; type: string; start_local: string; end_local: string; tz_offset_min: number;
  duration_min: number | null; avg_hr: number | null; max_hr: number | null; kcal: number | null; azm: number | null; distance_m: number | null;
}
const query: (db: D1Database, args: { start: string; end: string }) => Promise<{ workouts: Workout[]; count: number }> = healthWorkouts;
const at = (iso: string) => Date.parse(iso) / 1000;
async function seed(id: string, date = "2026-10-02", start = "2026-10-02T12:19:23Z", end = "2026-10-02T13:14:34Z", offset = 120, source = "gh", type = "CARDIO_WORKOUT") {
  await env.DB.prepare(`INSERT INTO workout (source_id, source, type, start_ts, end_ts, tz_offset_min, local_date,
    duration_min, avg_hr, max_hr, kcal, azm, distance_m, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 999, ?, ?, ?, 1)`)
    .bind(id, source, type, at(start), at(end), offset, date, 55.183333, 119.25, 336.05, 40, 1234.567).run();
}
function guarded(failAt = 0) {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const db = { prepare(q: string) {
    sql.push(q);
    expect(q.trim()).toMatch(/^SELECT\b/i);
    return { bind(...args: unknown[]) {
      binds.push(args);
      expect(args.length).toBeLessThanOrEqual(100);
      return { all: () => sql.length === failAt ? Promise.reject(new Error("D1 down")) : env.DB.prepare(q).bind(...args).all() };
    } };
  } } as unknown as D1Database;
  return { db, sql, binds };
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { await env.DB.batch(["workout", "metric_minute"].map((table) => env.DB.prepare(`DELETE FROM ${table}`))); });

describe("T10f AC5 healthWorkouts", () => {
  it("returns the exact public shape, offset-local minute timestamps, count and one-decimal rounding", async () => {
    await seed("probe");
    expect(await query(env.DB, { start: "2026-10-02", end: "2026-10-02" })).toEqual({ workouts: [{
      local_date: "2026-10-02", type: "CARDIO_WORKOUT", start_local: "2026-10-02T14:19", end_local: "2026-10-02T15:14", tz_offset_min: 120,
      duration_min: 55.2, avg_hr: 119.3, max_hr: null, kcal: 336.1, azm: 40, distance_m: 1234.6,
    }], count: 1 });
  });

  it("rounds daily workout minutes to the same precision as workout duration", async () => {
    await seed("daily-rounding");
    await env.DB.prepare("INSERT INTO daily_summary (local_date, workout_min, computed_at) VALUES ('2026-10-02', 55.18333333333333, 1)").run();
    const args = { start: "2026-10-02", end: "2026-10-02" };
    const daily = await healthDaily(env.DB, { ...args, metrics: ["workout_min"] });
    const out = await query(env.DB, args);
    expect(daily.rows).toEqual([["2026-10-02", 55.2]]);
    expect(daily.rows[0][1]).toBe(out.workouts[0].duration_min);
  });

  it("selects stored local dates inclusively for every source and orders by start_ts then source_id", async () => {
    await seed("z'2", "2026-10-03", "2026-10-02T23:30:00Z", "2026-10-03T00:00:00Z", 330, "other", "Z");
    await seed('a"1', "2026-10-03", "2026-10-02T23:30:00Z", "2026-10-03T00:30:00Z", -300, "manual", "A");
    await seed("first", "2026-10-02", "2026-10-02T12:00:00Z", "2026-10-02T13:00:00Z", 0, "gh", "FIRST");
    await seed("before", "2026-10-01");
    await seed("after", "2026-10-04");
    const out = await query(env.DB, { start: "2026-10-02", end: "2026-10-03" });
    expect(out.count).toBe(3);
    expect(out.workouts.map((w) => [w.local_date, w.type, w.start_local, w.end_local, w.tz_offset_min])).toEqual([
      ["2026-10-02", "FIRST", "2026-10-02T12:00", "2026-10-02T13:00", 0],
      ["2026-10-03", "A", "2026-10-02T18:30", "2026-10-02T19:30", -300],
      ["2026-10-03", "Z", "2026-10-03T05:00", "2026-10-03T05:30", 330],
    ]);
  });

  it("preserves nulls, zero, negative numbers and unknown types, rounds Math.round ties and reads edits afresh", async () => {
    await seed("a", "2026-10-02", undefined, undefined, 120, "gh", "owner's UNKNOWN");
    await env.DB.prepare("UPDATE workout SET duration_min = NULL, avg_hr = 0, kcal = -1.25, azm = -2, distance_m = -12.25").run();
    const args = { start: "2026-10-02", end: "2026-10-02" };
    expect((await query(env.DB, args)).workouts[0]).toMatchObject({
      type: "owner's UNKNOWN", duration_min: null, avg_hr: 0, kcal: -1.2, azm: -2, distance_m: -12.2,
    });
    await env.DB.prepare("UPDATE workout SET duration_min = 0, avg_hr = NULL, kcal = NULL, azm = NULL, distance_m = NULL, type = 'EDITED'").run();
    expect((await query(env.DB, args)).workouts[0]).toMatchObject({ type: "EDITED", duration_min: 0, avg_hr: null, kcal: null, azm: null, distance_m: null });
  });

  it("T38 AC2 derives separate maxima from gh HR vmax in each [start, end) window", async () => {
    await seed("first", "2026-10-02", "2026-10-02T12:00:00Z", "2026-10-02T12:03:00Z");
    await seed("second", "2026-10-02", "2026-10-02T12:03:00Z", "2026-10-02T12:05:00Z");
    await seed("uncovered", "2026-10-02", "2026-10-02T13:00:00Z", "2026-10-02T13:01:00Z");
    const minute = (time: string, vmax: number | null, metric = "hr", source = "gh") => env.DB.prepare(
      "INSERT INTO metric_minute (metric, source, ts, tz_offset_min, value, vmin, vmax) VALUES (?, ?, ?, 0, 999, 999, ?)",
    ).bind(metric, source, at(`2026-10-02T${time}Z`), vmax);
    await env.DB.batch([
      minute("11:59:00", 250), minute("12:00:00", 150.25), minute("12:01:00", 140), minute("12:02:00", null),
      minute("12:03:00", 160.24), minute("12:04:00", 155), minute("12:05:00", 251),
      minute("12:01:00", 252, "hr", "manual"), minute("12:01:00", 253, "steps"),
    ]);
    const { db, sql } = guarded();
    const args = { start: "2026-10-02", end: "2026-10-02" };
    expect((await query(db, args)).workouts.map((w) => w.max_hr)).toEqual([150.3, 160.2, null]);
    expect(sql.length).toBe(1);
    await env.DB.prepare("UPDATE metric_minute SET vmax = 0 WHERE metric = 'hr' AND source = 'gh'").run();
    expect((await query(env.DB, args)).workouts.map((w) => w.max_hr)).toEqual([0, 0, null]);
  });

  it("T38 AC2 returns 101 workouts with correct HR maxima using one SELECT and 100 binds each", async () => {
    const start = at("2026-10-02T00:00:00Z");
    await env.DB.batch(Array.from({ length: 101 }, (_, i) => env.DB.prepare(`INSERT INTO workout
      (source_id, type, start_ts, end_ts, tz_offset_min, local_date, updated_at)
      VALUES (?, 'RUN', ?, ?, 0, '2026-10-02', 1)`).bind(String(i), start + i * 60, start + (i + 1) * 60)));
    await env.DB.batch(Array.from({ length: 101 }, (_, i) => env.DB.prepare(`INSERT INTO metric_minute
      (metric, ts, tz_offset_min, value, vmax) VALUES ('hr', ?, 0, 60, ?)`).bind(start + i * 60, 100 + i)));
    const { db, sql } = guarded();
    const out = await query(db, { start: "2026-10-02", end: "2026-10-02" });
    expect(out.count).toBe(101);
    expect(out.workouts.map((w) => w.max_hr)).toEqual(Array.from({ length: 101 }, (_, i) => 100 + i));
    expect(sql.length).toBe(1);
  });

  it("T38 AC2 rejects a failed combined workout and HR read", async () => {
    await seed("probe");
    const { db, sql } = guarded(1);
    await expect(query(db, { start: "2026-10-02", end: "2026-10-02" })).rejects.toThrow("D1 down");
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/metric_minute/i);
  });

  it.each([
    ["2026-10-03", "2026-10-02", "range must contain 1 to 31 dates"],
    ["2026-10-01", "2026-11-01", "range must contain 1 to 31 dates"],
    ["2026-1-01", "2026-01-02", "date must be a real calendar date in YYYY-MM-DD format"],
    ["2026-02-29", "2026-03-01", "date must be a real calendar date in YYYY-MM-DD format"],
    ["2026-02-30", "2026-03-01", "date must be a real calendar date in YYYY-MM-DD format"],
    ["2026-10-01", "2026-10-32", "date must be a real calendar date in YYYY-MM-DD format"],
    ["2026-10-01", "2026-10-2", "date must be a real calendar date in YYYY-MM-DD format"],
    ["2026-10-01", "20261002", "date must be a real calendar date in YYYY-MM-DD format"],
    ["2026-10-01", "2026-10-02' OR 1=1 --", "date must be a real calendar date in YYYY-MM-DD format"],
    ["", "2026-10-02", "date must be a real calendar date in YYYY-MM-DD format"],
  ])("rejects %s through %s before querying with RangeError: %s", async (start, end, message) => {
    const { db, sql } = guarded();
    await expect(query(db, { start, end })).rejects.toThrow(RangeError);
    await expect(query(db, { start, end })).rejects.toThrow(message);
    expect(sql).toEqual([]);
  });

  it.each([["2028-02-29", "2028-02-29"], ["2026-10-01", "2026-10-31"], ["2026-10-15", "2026-11-14"]])("accepts %s through %s including one and 31 dates", async (start, end) => {
    expect(await query(env.DB, { start, end })).toEqual({ workouts: [], count: 0 });
  });

  it("performs one bound read including an empty result from workout in the required order and never writes", async () => {
    const { db, sql, binds } = guarded();
    expect(await query(db, { start: "2026-10-02", end: "2026-10-03" })).toEqual({ workouts: [], count: 0 });
    expect(sql.length).toBe(1);
    expect(sql.length).toBeGreaterThan(0);
    expect(sql[0]).toMatch(/FROM\s+workout\s+w\s+WHERE\s+local_date\s+BETWEEN\s+\?\s+AND\s+\?\s+ORDER\s+BY\s+start_ts\s*,\s*source_id/i);
    expect(sql[0]).not.toContain("2026-10");
    expect(binds).toHaveLength(sql.length);
    for (const [i, query] of sql.entries()) {
      expect(query).not.toContain("2026-10");
      expect(binds[i]).toEqual(["2026-10-02", "2026-10-03"]);
    }
  });

  it("propagates a D1 read failure", async () => {
    await expect(query(guarded(1).db, { start: "2026-10-02", end: "2026-10-02" })).rejects.toThrow("D1 down");
  });
});
