import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthTrend } from "../../src/mcp/tools/trend";

interface Args { metric: string; period: string; start: string; end: string }
interface Summary { mean: number | null; sd: number | null; n: number }
interface Bucket extends Summary { period_start: string; days: number; min: number | null; max: number | null; z: number | null }
interface Result extends Args { baseline: Summary; buckets: Bucket[]; caveats: string }
const trend = healthTrend as (db: D1Database, args: Args) => Promise<Result>;
const names = ["cigarettes", "alcohol_g", "caffeine_mg", "rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev",
  "sleep_min", "sleep_eff", "deep_min", "rem_min", "sleep_latency_min", "steps", "azm", "readiness_proxy"];
const base = { metric: "rhr", period: "week", start: "2026-12-28", end: "2027-01-10" };
const caveats = "Descriptivo. z compara cada periodo con la media del rango; los periodos parciales tienen menos días.";
const empty = { n: 0, mean: null, sd: null, min: null, max: null, z: null };
async function row(day: string, value: number | null) {
  await env.DB.prepare("INSERT INTO daily_summary (local_date, rhr, computed_at) VALUES (?, ?, 1)").bind(day, value).run();
}
function observed(rewrite: (value: unknown) => unknown = (value) => value) {
  const reads: { sql: string; bindings: unknown[] }[] = [];
  let executions = 0;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(t, p) {
    if (p === "bind") return (...bindings: unknown[]) => { reads[reads.length - 1].bindings = bindings; return wrap(t.bind(...bindings), sql); };
    if (["all", "first", "raw", "run"].includes(String(p))) return (...args: unknown[]) => {
      executions++;
      expect(sql).toMatch(/^\s*SELECT\b/i);
      return (Reflect.get(t, p) as (...args: unknown[]) => Promise<unknown>).apply(t, args).then(rewrite);
    };
    const value: unknown = Reflect.get(t, p);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  } });
  const db = new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (sql: string) => { reads.push({ sql, bindings: [] }); return wrap(t.prepare(sql), sql); };
    if (["batch", "exec", "dump"].includes(String(p))) return () => { throw new Error(`unexpected ${String(p)}`); };
    const value: unknown = Reflect.get(t, p);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  } });
  return { db, reads, executions: () => executions };
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { await env.DB.batch(["daily_summary", "tracker_daily"].map((table) => env.DB.prepare(`DELETE FROM ${table}`))); });

describe("T18 AC2–AC4 health_trend aggregates", () => {
  it("returns every empty ISO week across a year boundary, oldest first, with the exact output shape", async () => {
    expect(await trend(env.DB, base)).toEqual({ ...base, baseline: { mean: null, sd: null, n: 0 },
      buckets: [{ period_start: "2026-12-28", days: 7, ...empty }, { period_start: "2027-01-04", days: 7, ...empty }], caveats });
  });

  it("keeps Sundays in their Monday's ISO week and uses daily sample SD and the range baseline", async () => {
    for (const [day, value] of [["2026-12-28", 1], ["2027-01-03", 3], ["2027-01-04", 5], ["2027-01-10", 7]] as const) await row(day, value);
    await row("2026-12-27", -9999);
    await row("2027-01-11", 9999);
    expect(await trend(env.DB, base)).toEqual({ ...base, baseline: { mean: 4, sd: 2.582, n: 4 }, buckets: [
      { period_start: "2026-12-28", days: 7, n: 2, mean: 2, sd: 1.414, min: 1, max: 3, z: -0.775 },
      { period_start: "2027-01-04", days: 7, n: 2, mean: 6, sd: 1.414, min: 5, max: 7, z: 0.775 },
    ], caveats });
  });

  it("includes partial first/last months and empty months; baseline weights daily values rather than buckets", async () => {
    await row("2026-01-29", -9999);
    await row("2026-01-30", 1);
    await row("2026-01-31", 3);
    await row("2026-03-01", 9);
    await row("2026-03-02", null);
    await row("2026-03-03", 9999);
    const args = { ...base, period: "month", start: "2026-01-30", end: "2026-03-02" };
    expect(await trend(env.DB, args)).toEqual({ ...args, baseline: { mean: 4.333, sd: 4.163, n: 3 }, buckets: [
      { period_start: "2026-01-01", days: 2, n: 2, mean: 2, sd: 1.414, min: 1, max: 3, z: -0.56 },
      { period_start: "2026-02-01", days: 28, ...empty },
      { period_start: "2026-03-01", days: 2, n: 1, mean: 9, sd: null, min: 9, max: 9, z: 1.121 },
    ], caveats });
  });

  it.each(["cigarettes", "alcohol_g", "caffeine_mg"])("counts absent/null %s as zero and preserves negative/fractional totals", async (metric) => {
    for (const day of ["2026-12-28", "2026-12-29", "2026-12-30"]) await row(day, null);
    const tracker = { cigarettes: "cigarettes", alcohol_g: "alcohol", caffeine_mg: "caffeine" }[metric];
    for (const [day, total] of [["2026-12-28", -0.5], ["2026-12-29", 1.5]] as const) {
      await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, ?, ?, 1, 0)")
        .bind(day, tracker, total).run();
    }
    const args = { ...base, metric, end: "2026-12-31" };
    expect(await trend(env.DB, args)).toEqual({ ...args, baseline: { mean: 0.25, sd: 0.866, n: 4 },
      buckets: [{ period_start: "2026-12-28", days: 4, n: 4, mean: 0.25, sd: 0.866, min: -0.5, max: 1.5, z: 0 }], caveats });
  });

  it.each(["week", "month"])("returns all-zero behaviour buckets for an empty database (%s)", async (period) => {
    const args = { ...base, metric: "cigarettes", period, start: "2026-12-31", end: "2027-01-01" };
    expect(await trend(env.DB, args)).toEqual({ ...args, baseline: { n: 2, mean: 0, sd: 0 },
      buckets: (period === "week" ? [["2026-12-28", 2]] : [["2026-12-01", 1], ["2027-01-01", 1]])
        .map(([period_start, days]) => ({ period_start, days, n: days, mean: 0, sd: days === 1 ? null : 0, min: 0, max: 0, z: null })), caveats });
  });

  it.each([0, -1.2345])("keeps singleton value %s, excludes nulls and rounds negative ties with Math.round", async (value) => {
    await row("2026-12-28", null);
    await row("2027-01-04", value);
    const rounded = value === 0 ? 0 : -1.234;
    expect(await trend(env.DB, base)).toEqual({ ...base, baseline: { n: 1, mean: rounded, sd: null }, buckets: [
      { period_start: "2026-12-28", days: 7, ...empty },
      { period_start: "2027-01-04", days: 7, n: 1, mean: rounded, sd: null, min: rounded, max: rounded, z: null },
    ], caveats });
  });

  it("returns null z for a zero-variance baseline, even in populated singleton buckets", async () => {
    await row("2026-12-28", 3);
    await row("2027-01-04", 3);
    const out = await trend(env.DB, base);
    expect(out.baseline).toEqual({ n: 2, mean: 3, sd: 0 });
    expect(out.buckets).toEqual(["2026-12-28", "2027-01-04"].map((period_start) =>
      ({ period_start, days: 7, n: 1, mean: 3, sd: null, min: 3, max: 3, z: null })));
  });

  it("computes z from unrounded intermediates when the displayed baseline SD rounds to zero", async () => {
    await row("2026-12-28", 0);
    await row("2027-01-04", 0.0004);
    const out = await trend(env.DB, base);
    expect(out.baseline).toEqual({ n: 2, mean: 0, sd: 0 });
    expect(out.buckets).toEqual([
      { period_start: "2026-12-28", days: 7, n: 1, mean: 0, sd: null, min: 0, max: 0, z: -0.707 },
      { period_start: "2027-01-04", days: 7, n: 1, mean: 0, sd: null, min: 0, max: 0, z: 0.707 },
    ]);
  });

  it.each(["rhr", "cigarettes"])("normalizes non-finite %s at the D1 read boundary", async (metric) => {
    for (let i = 0; i < 4; i++) {
      const day = `2026-12-${String(28 + i)}`;
      await row(day, i === 3 ? 0 : 900001 + i);
      await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, 'cigarettes', ?, 1, 0)")
        .bind(day, i === 3 ? 0 : 900001 + i).run();
    }
    // D1 JSON cannot faithfully transport every non-finite number.
    const rewrite = (value: unknown): unknown => {
      if (typeof value === "number") return ({ 900001: Infinity, 900002: NaN, 900003: -Infinity } as Record<number, number>)[value] ?? value;
      if (Array.isArray(value)) return (value as unknown[]).map(rewrite);
      if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]: [string, unknown]) => [k, rewrite(v)]));
      return value;
    };
    const out = await trend(observed(rewrite).db, { ...base, metric, end: "2026-12-31" });
    const n = metric === "rhr" ? 1 : 4;
    const sd = n === 1 ? null : 0;
    expect(out.baseline).toEqual({ n, mean: 0, sd });
    expect(out.buckets).toEqual([{ period_start: "2026-12-28", days: 4, n, mean: 0, sd, min: 0, max: 0, z: null }]);
  });

  it.each(names)("accepts and reads metric %s", async (metric) => {
    const tracker = { cigarettes: "cigarettes", alcohol_g: "alcohol", caffeine_mg: "caffeine" }[metric];
    if (tracker) {
      await row(base.start, null);
      await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, ?, 7, 1, 0)").bind(base.start, tracker).run();
    } else {
      await env.DB.prepare(`INSERT INTO daily_summary (local_date, ${metric}, computed_at) VALUES (?, 7, 1)`).bind(base.start).run();
    }
    const out = await trend(env.DB, { ...base, metric, end: base.start });
    expect(out.metric).toBe(metric);
    expect(out.baseline).toEqual({ n: 1, mean: 7, sd: null });
  });
});

describe("T18 AC1 validation and AC6 single bound SELECT", () => {
  const badDate = "date must be a real calendar date in YYYY-MM-DD format";
  const invalid: [Partial<Args>, string][] = [
    ...["", "bedtime_local", "waketime_local", "computed_at", "workout_min", "hr_wear_min", "z_rhr", "z_ln_rmssd", "z_sleep", "alcohol", "rhr; DROP TABLE event"]
      .map((metric): [Partial<Args>, string] => [{ metric }, `metric must be one of: ${names.join(", ")}`]),
    ...["", "day", "year", "Week", "MONTH"].map((period): [Partial<Args>, string] => [{ period }, "period must be week or month"]),
    ...["", "2026-1-01", "2026-02-30", "2026-02-29", "1999-12-31", "2100-01-01", "20260101", "2026-01-01T00:00:00Z"]
      .flatMap((day): [Partial<Args>, string][] => [[{ start: day }, badDate], [{ end: day }, badDate]]),
    [{ end: "2026-12-27" }, "range must contain 1 to 365 dates"],
    [{ start: "2026-01-01", end: "2027-01-01" }, "range must contain 1 to 365 dates"],
  ];
  it.each(invalid)("rejects %j with the exact RangeError before preparing SQL", async (overrides, message) => {
    const seen = observed();
    const pending = trend(seen.db, { ...base, ...overrides });
    await expect(pending).rejects.toThrow(RangeError);
    await expect(pending).rejects.toMatchObject({ message });
    expect(seen.reads).toEqual([]);
  });

  it.each([
    ["week", "2026-01-01", "2026-12-31", "2025-12-29", 365],
    ["week", "2000-01-01", "2000-01-01", "1999-12-27", 1],
    ["month", "2099-12-31", "2099-12-31", "2099-12-01", 1],
    ["month", "2028-02-01", "2028-03-01", "2028-02-01", 30],
    ["week", "2026-10-24", "2026-10-26", "2026-10-19", 3],
  ] as const)("uses one non-widened SELECT for %s %s..%s", async (period, start, end, firstBucket, days) => {
    if (days === 365) {
      const statements = Array.from({ length: days }, (_, i) => env.DB.prepare("INSERT INTO daily_summary (local_date, rhr, computed_at) VALUES (?, ?, 1)")
        .bind(new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), i));
      await env.DB.batch(statements);
    }
    const seen = observed();
    const out = await trend(seen.db, { ...base, period, start, end });
    expect(seen.reads).toHaveLength(1);
    expect(seen.executions()).toBe(1);
    expect(seen.reads[0].sql).toMatch(/^\s*SELECT\b[\s\S]*\bFROM\s+v_daily\b[\s\S]*\bWHERE\s+local_date\s+BETWEEN\s+\?\s+AND\s+\?/i);
    expect(seen.reads[0].sql).not.toContain(start);
    expect(seen.reads[0].bindings).toEqual([start, end]);
    expect(out.buckets[0].period_start).toBe(firstBucket);
    expect(out.buckets.reduce((sum, bucket) => sum + bucket.days, 0)).toBe(days);
    if (days === 365) expect(out.baseline).toEqual({ n: 365, mean: 182, sd: 105.511 });
    if (start === "2028-02-01") expect(out.buckets.map(({ days }) => days)).toEqual([29, 1]);
    if (start === "2026-10-24") expect(out.buckets.map(({ period_start, days }) => ({ period_start, days })))
      .toEqual([{ period_start: "2026-10-19", days: 2 }, { period_start: "2026-10-26", days: 1 }]);
  });

  it("propagates a failed D1 read without returning an empty successful report", async () => {
    const failure = new Error("private D1 trend failure");
    const reject = () => Promise.reject(failure);
    const statement = { bind: () => statement, all: reject, first: reject, raw: reject, run: reject };
    const db = { prepare: () => statement, batch: reject, exec: reject } as unknown as D1Database;
    await expect(trend(db, base)).rejects.toBe(failure);
  });
});
