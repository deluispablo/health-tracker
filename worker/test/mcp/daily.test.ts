import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthSql } from "../../src/mcp/tools/sql";
import { DAILY_COLUMNS, healthDaily } from "../../src/mcp/tools/daily";

async function summary(date: string, f: Record<string, number | string | null> = {}) {
  const cols = Object.keys(f);
  await env.DB.prepare(`INSERT INTO daily_summary (local_date${cols.map((c) => `, ${c}`).join("")}, computed_at) VALUES (?${cols.map(() => ", ?").join("")}, 1)`)
    .bind(date, ...Object.values(f)).run();
}

const MOODS = ["mood_genial", "mood_bien", "mood_tranquilo", "mood_cansado", "mood_estresado", "mood_ansioso", "mood_triste", "mood_enfadado"];
const VIEW_COLUMNS = ["rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev", "sleep_min", "sleep_eff", "deep_min",
  "rem_min", "sleep_latency_min", "bedtime_local", "waketime_local", "steps", "azm", "workout_min", "hr_wear_min", "z_ln_rmssd", "z_rhr",
  "z_sleep", "readiness_proxy", "cigarettes", "alcohol_g", "caffeine_mg", ...MOODS];
const UNITS: Record<string, string> = {
  rhr: "bpm", hrv_rmssd: "ms", ln_rmssd: "ln(ms)", resp_rate: "brpm", spo2_avg: "%", skin_temp_dev: "°C", sleep_min: "min", sleep_eff: "%",
  deep_min: "min", rem_min: "min", sleep_latency_min: "min", bedtime_local: "HH:MM", waketime_local: "HH:MM", steps: "count", azm: "min",
  workout_min: "min", hr_wear_min: "min", z_ln_rmssd: "z", z_rhr: "z", z_sleep: "z", readiness_proxy: "score", cigarettes: "count",
  alcohol_g: "g", caffeine_mg: "mg", ...Object.fromEntries(MOODS.map((mood) => [mood, "count"])),
};
interface Seen { sql: string[]; binds: unknown[][]; other: string[] }
function guarded(): [D1Database, Seen] {
  const seen: Seen = { sql: [], binds: [], other: [] };
  const db = new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (q: string) => {
      seen.sql.push(q);
      const stmt = t.prepare(q);
      return new Proxy(stmt, { get(st, sp) {
        if (sp === "bind") return (...a: unknown[]) => { seen.binds.push(a); return st.bind(...a); };
        const v: unknown = Reflect.get(st, sp);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(st) : v;
      } });
    };
    if (p === "batch" || p === "exec" || p === "dump") return () => { seen.other.push(p); throw new Error(`unexpected ${p}`); };
    const v: unknown = Reflect.get(t, p);
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  } });
  return [db, seen];
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM daily_summary"), env.DB.prepare("DELETE FROM tracker_daily")]);
});

describe("AC1 health_daily", () => {
  it.each([
    [[], "metrics must not be empty"],
    [["rhr", "pasos", "rhr"], `unknown metric "pasos"; valid: ${VIEW_COLUMNS.join(", ")}`],
    [["nope", "other"], `unknown metric "nope"; valid: ${VIEW_COLUMNS.join(", ")}`],
    [["rhr", "rhr", "nope", "other"], `unknown metric "nope"; valid: ${VIEW_COLUMNS.join(", ")}`],
    [["rhr", "rhr"], `metric "rhr" is repeated; valid: ${VIEW_COLUMNS.join(", ")}`],
    [["steps", "rhr", "steps", "rhr"], `metric "steps" is repeated; valid: ${VIEW_COLUMNS.join(", ")}`],
  ] as const)("T28 AC1 rejects metrics %j with the first applicable exact message before reading", async (metrics, message) => {
    const [db, seen] = guarded();
    const pending = healthDaily(db, { start: "2026-10-01", end: "2026-10-02", metrics });
    await expect(pending).rejects.toBeInstanceOf(RangeError);
    await expect(pending).rejects.toHaveProperty("message", message);
    expect(seen.sql).toEqual([]);
  });

  it("returns v_daily rows in the range, oldest first, with every column, units and coverage", async () => {
    await summary("2026-10-05", { rhr: 61, steps: 8123, readiness_proxy: 0.4 });
    await summary("2026-10-07", { rhr: 63, sleep_min: 380, bedtime_local: "23:15" });
    await summary("2026-10-09", { rhr: 99 });
    await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES ('2026-10-07', 'cigarettes', 4, 4, 2)").run();
    const out = await healthDaily(env.DB, { start: "2026-10-04", end: "2026-10-08" });
    expect(out.columns).toEqual(["local_date", ...DAILY_COLUMNS]);
    expect(out.rows.map((r) => [r[0], r[out.columns.indexOf("rhr")], r[out.columns.indexOf("cigarettes")]])).toEqual([
      ["2026-10-05", 61, null], ["2026-10-07", 63, 4]]);
    expect(out.coverage).toEqual({ days_requested: 5, days_with_data: 2 });
    expect(DAILY_COLUMNS).toEqual(VIEW_COLUMNS);
    expect(out.units).toEqual(UNITS);
  });

  it("T38 AC1 reads every mood total by date with count units, nulls and SQL view access", async () => {
    await summary("2026-10-05");
    await summary("2026-10-06");
    await env.DB.batch(MOODS.map((mood, i) => env.DB.prepare(
      "INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES ('2026-10-05', ?, ?, 1, 0)",
    ).bind(mood, i)));
    const out = await healthDaily(env.DB, { start: "2026-10-05", end: "2026-10-06", metrics: MOODS });
    expect(out).toEqual({ columns: ["local_date", ...MOODS],
      rows: [["2026-10-05", 0, 1, 2, 3, 4, 5, 6, 7], ["2026-10-06", ...MOODS.map(() => null)]],
      units: Object.fromEntries(MOODS.map((mood) => [mood, "count"])),
      coverage: { days_requested: 2, days_with_data: 2 } });
    expect(await healthSql(env.DB, { query: `SELECT local_date, ${MOODS.join(", ")} FROM v_daily ORDER BY local_date` }))
      .toMatchObject({ columns: out.columns, rows: out.rows });
  });

  it("returns only the requested metrics, in the requested order", async () => {
    await summary("2026-10-05", { rhr: 61, steps: 8123, hrv_rmssd: 40 });
    const out = await healthDaily(env.DB, { start: "2026-10-05", end: "2026-10-05", metrics: ["steps", "rhr"] });
    expect(out).toEqual({ columns: ["local_date", "steps", "rhr"], rows: [["2026-10-05", 8123, 61]],
      units: { steps: "count", rhr: "bpm" }, coverage: { days_requested: 1, days_with_data: 1 } });
  });

  it("rejects bad dates, reversed or over-90-day ranges, unknown or duplicate metrics, before reading", async () => {
    const bad: Parameters<typeof healthDaily>[1][] = [
      { start: "2026-10-08", end: "2026-10-07" }, { start: "2026-1-01", end: "2026-01-02" }, { start: "2026-02-30", end: "2026-03-01" },
      { start: "2026-01-01", end: "2026-04-01" }, { start: "2026-10-01", end: "2026-10-02", metrics: ["rhr; DROP TABLE event"] },
      { start: "2026-10-01", end: "2026-10-02", metrics: ["computed_at"] }, { start: "2026-10-01", end: "2026-10-02", metrics: [] },
      { start: "2026-10-01", end: "2026-10-02", metrics: ["rhr", "rhr"] },
    ];
    bad.push({ start: "2026-10-01", end: "2026-10-32" }, { start: "2026-10-01", end: "20261002" }, { start: "2026-02-28", end: "2026-02-29" });
    const [db, seen] = guarded();
    for (const args of bad) await expect(healthDaily(db, args)).rejects.toThrow(RangeError);
    expect(seen.sql).toEqual([]);
    await expect(healthDaily(env.DB, { start: "2028-02-28", end: "2028-03-01" })).resolves.toEqual(expect.objectContaining({ coverage: { days_requested: 3, days_with_data: 0 } }));
    await expect(healthDaily(env.DB, { start: "2026-01-01", end: "2026-03-31" })).resolves.toEqual(expect.objectContaining({ coverage: { days_requested: 90, days_with_data: 0 } }));
  });

  it("rejects a start before 2000 like health_compare, before reading", async () => {
    const [db, seen] = guarded();
    await expect(healthDaily(db, { start: "1999-12-31", end: "2000-01-01" })).rejects.toThrow("date must be a real calendar date in YYYY-MM-DD format");
    expect(seen.sql).toEqual([]);
    expect(seen.other).toEqual([]);
  });

  it("reads once through v_daily with bound, inclusive endpoints and no writes", async () => {
    for (const d of ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]) await summary(d, { rhr: 60 });
    const [db, seen] = guarded();
    const out = await healthDaily(db, { start: "2026-10-01", end: "2026-10-02", metrics: ["rhr"] });
    expect(out.rows.map((r) => r[0])).toEqual(["2026-10-01", "2026-10-02"]);
    expect(seen.sql).toHaveLength(1);
    expect(seen.sql[0]).toMatch(/\bFROM\s+v_daily\b/i);
    expect(seen.sql[0]).not.toMatch(/2026-10-0/);
    expect(seen.binds).toEqual([["2026-10-01", "2026-10-02"]]);
    expect(seen.other).toEqual([]);
  });

  it("rejects when the D1 read fails instead of reporting empty coverage", async () => {
    const broken = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (q: string) => {
        const stmt = t.prepare(q);
        return new Proxy(stmt, { get(st, sp) {
          if (sp === "bind") return (...a: unknown[]) => new Proxy(st.bind(...a), { get(b, bp) {
            if (bp === "all") return () => Promise.reject(new Error("D1 down"));
            const v: unknown = Reflect.get(b, bp);
            return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(b) : v;
          } });
          const v: unknown = Reflect.get(st, sp);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(st) : v;
        } });
      };
      const v: unknown = Reflect.get(t, p);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    await expect(healthDaily(broken, { start: "2026-10-01", end: "2026-10-02" })).rejects.toThrow("D1 down");
  });

  it("T28 AC2 rounds fractional values and counts days with a row even when its metrics are NULL or zero", async () => {
    await summary("2026-10-05", { skin_temp_dev: -0.25, z_rhr: 1.234567891, steps: 0, waketime_local: "06:48" });
    await summary("2026-10-06", {});
    const out = await healthDaily(env.DB, { start: "2026-10-05", end: "2026-10-07", metrics: ["skin_temp_dev", "z_rhr", "steps", "waketime_local", "rhr"] });
    expect(out.rows).toEqual([["2026-10-05", -0.25, 1.235, 0, "06:48", null], ["2026-10-06", null, null, null, null, null]]);
    expect(out.coverage).toEqual({ days_requested: 3, days_with_data: 2 });
    const empty = await healthDaily(env.DB, { start: "2026-11-01", end: "2026-11-02", metrics: ["rhr"] });
    expect(empty).toEqual({ columns: ["local_date", "rhr"], rows: [], units: { rhr: "bpm" }, coverage: { days_requested: 2, days_with_data: 0 } });
  });

  it("T28 AC2 rounds minutes to one decimal and other numeric metrics to three, preserving strings and integers", async () => {
    const numeric = VIEW_COLUMNS.filter((column) => !["bedtime_local", "waketime_local", "cigarettes", "alcohol_g", "caffeine_mg", ...MOODS].includes(column));
    await summary("2026-10-05", { ...Object.fromEntries(numeric.map((column) => [column, 1.234567891])),
      skin_temp_dev: -1.2345, workout_min: 55.18333333333333, steps: Number.MAX_SAFE_INTEGER,
      bedtime_local: "23:15", waketime_local: "06:48" });
    await env.DB.batch(["cigarettes", "alcohol", "caffeine", ...MOODS].map((tracker) => env.DB.prepare(
      "INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES ('2026-10-05', ?, 1.234567891, 1, 0)",
    ).bind(tracker)));
    const out = await healthDaily(env.DB, { start: "2026-10-05", end: "2026-10-05" });
    const expected: Record<string, number | string> = { skin_temp_dev: -1.234, workout_min: 55.2,
      steps: Number.MAX_SAFE_INTEGER, bedtime_local: "23:15", waketime_local: "06:48" };
    expect(out.rows).toEqual([["2026-10-05", ...VIEW_COLUMNS.map((column) => expected[column] ?? (UNITS[column] === "min" ? 1.2 : 1.235))]]);
    expect(await env.DB.prepare("SELECT workout_min FROM daily_summary").first("workout_min")).toBe(55.18333333333333);
  });

  it("T28 AC2 leaves non-finite numbers unchanged at the read boundary", async () => {
    const values = { local_date: "2026-10-05", rhr: Infinity, z_rhr: -Infinity, z_sleep: NaN };
    const db = { prepare: () => ({ bind: () => ({ all: () => Promise.resolve({ results: [values] }) }) }) } as unknown as D1Database;
    const out = await healthDaily(db, { start: "2026-10-05", end: "2026-10-05", metrics: ["rhr", "z_rhr", "z_sleep"] });
    expect(out.rows).toEqual([["2026-10-05", Infinity, -Infinity, NaN]]);
  });
});
