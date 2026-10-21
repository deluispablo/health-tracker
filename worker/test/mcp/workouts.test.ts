import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthWorkouts } from "../../src/mcp/tools/workouts";

interface Workout {
  local_date: string; type: string; start_local: string; end_local: string; tz_offset_min: number;
  duration_min: number | null; avg_hr: number | null; kcal: number | null; azm: number | null; distance_m: number | null;
}
// Keep the absent-module red confined to the import until T10f implements this API.
const query = healthWorkouts as (db: D1Database, args: { start: string; end: string }) => Promise<{ workouts: Workout[]; count: number }>;
const at = (iso: string) => Date.parse(iso) / 1000;
async function seed(id: string, date = "2026-10-02", start = "2026-10-02T12:19:23Z", end = "2026-10-02T13:14:34Z", offset = 120, source = "gh", type = "CARDIO_WORKOUT") {
  await env.DB.prepare(`INSERT INTO workout (source_id, source, type, start_ts, end_ts, tz_offset_min, local_date,
    duration_min, avg_hr, max_hr, kcal, azm, distance_m, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 999, ?, ?, ?, 1)`)
    .bind(id, source, type, at(start), at(end), offset, date, 55.183333, 119.25, 336.05, 40, 1234.567).run();
}
function guarded(fail = false) {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const db = { prepare(q: string) {
    sql.push(q);
    expect(q.trim()).toMatch(/^SELECT\b/i);
    return { bind(...args: unknown[]) {
      binds.push(args);
      return { all: () => fail ? Promise.reject(new Error("D1 down")) : env.DB.prepare(q).bind(...args).all() };
    } };
  } } as unknown as D1Database;
  return { db, sql, binds };
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { await env.DB.prepare("DELETE FROM workout").run(); });

describe("T10f AC5 healthWorkouts", () => {
  it("returns the exact public shape, offset-local minute timestamps, count and one-decimal rounding", async () => {
    await seed("probe");
    expect(await query(env.DB, { start: "2026-10-02", end: "2026-10-02" })).toEqual({ workouts: [{
      local_date: "2026-10-02", type: "CARDIO_WORKOUT", start_local: "2026-10-02T14:19", end_local: "2026-10-02T15:14", tz_offset_min: 120,
      duration_min: 55.2, avg_hr: 119.3, kcal: 336.1, azm: 40, distance_m: 1234.6,
    }], count: 1 });
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

  it("performs one bound read from workout in the required order and never writes", async () => {
    const { db, sql, binds } = guarded();
    expect(await query(db, { start: "2026-10-02", end: "2026-10-03" })).toEqual({ workouts: [], count: 0 });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/FROM\s+workout\s+WHERE\s+local_date\s+BETWEEN\s+\?\s+AND\s+\?\s+ORDER\s+BY\s+start_ts\s*,\s*source_id/i);
    expect(sql[0]).not.toContain("2026-10");
    expect(binds).toEqual([["2026-10-02", "2026-10-03"]]);
  });

  it("propagates a D1 read failure", async () => {
    await expect(query(guarded(true).db, { start: "2026-10-02", end: "2026-10-02" })).rejects.toThrow("D1 down");
  });
});
