import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthCorrelate } from "../../src/mcp/tools/correlate";

interface Args { x: string; y: string; start: string; end: string; max_lag?: number }
interface Result { x: string; y: string; start: string; end: string; phi: number; lags: { lag: number; r: number | null; n: number }[]; caveats: string }
const correlate: (db: D1Database, args: Args) => Promise<Result> = healthCorrelate;
const behaviors = ["cigarettes", "alcohol_g", "caffeine_mg"];
const names = [...behaviors, "rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev", "sleep_min", "sleep_eff",
  "deep_min", "rem_min", "sleep_latency_min", "steps", "azm", "readiness_proxy"];
const base = { x: "rhr", y: "sleep_min", start: "2026-01-01", end: "2026-01-07" };
const date = (i: number) => new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10);
const caveats = (n: number) => `Asociacional, no causal. n=${String(n)}. Posibles confusores: alcohol, entrenamiento, hora de acostarse, enfermedad.`;
async function row(day: string, x: number | null, y: number | null) {
  await env.DB.prepare("INSERT INTO daily_summary (local_date, rhr, sleep_min, computed_at) VALUES (?, ?, ?, 1)").bind(day, x, y).run();
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

describe("T17 AC2/AC3 health_correlate", () => {
  it("returns the exact empty shape, default max_lag 3 and lag-0 caveats", async () => {
    expect(await correlate(env.DB, base)).toEqual({ ...base, phi: 0,
      lags: [0, 1, 2, 3].map((lag) => ({ lag, r: null, n: 0 })), caveats: caveats(0) });
  });

  it("estimates phi on anchors only, filters both with x's phi and pairs positive lags through the widened end", async () => {
    const x = [1, 4, 2, 8, 3, 7, 5, 1000, -500, 900];
    const y = [3, 1, 8, 5, 2, 14, 6, 9, 20, 4];
    for (let i = 0; i < x.length; i++) await row(date(i + 1), x[i], y[i]);
    await row("2025-12-31", 99999, -99999);
    // Anchor phi = -0.3398007341373886. The first filtered date is missing in both series.
    expect(await correlate(env.DB, base)).toEqual({ ...base, phi: -0.34,
      lags: [{ lag: 0, n: 6, r: 0.55 }, { lag: 1, n: 6, r: -0.14 }, { lag: 2, n: 6, r: 0.713 }, { lag: 3, n: 6, r: 0.353 }],
      caveats: caveats(6) });
  });

  it("keeps full phi precision while filtering and rounds only the returned numbers", async () => {
    const x = [1, 4, 2, 8, 3, 7, 5];
    const y = [7, 5, 18, 18, 7, 11, 18];
    for (let i = 0; i < x.length; i++) await row(date(i + 1), x[i], y[i]);
    // Unrounded r = .4293895736; rounding phi before filtering would return .430.
    expect(await correlate(env.DB, { ...base, max_lag: 0 })).toEqual({ ...base, phi: -0.34,
      lags: [{ lag: 0, n: 6, r: 0.429 }], caveats: caveats(6) });
  });

  it("uses one mean across gaps, leaves adjacent filtered values missing, and counts each lag's pairs", async () => {
    const x = [1, 2, 4, null, 10, 11, 13];
    const y = [3, 1, 8, 5, 2, 14, 6, 9, 20, 4];
    for (let i = 0; i < y.length; i++) await row(date(i + 1), x[i] ?? null, y[i]);
    expect(await correlate(env.DB, base)).toEqual({ ...base, phi: 0.953,
      lags: [0, 1, 2, 3].map((lag) => ({ lag, n: 4, r: null })), caveats: caveats(4) });
  });

  it("does not compact missing calendar dates into adjacent observations", async () => {
    for (const i of [1, 3, 5, 7]) await row(date(i), i, 2 * i);
    const out = await correlate(env.DB, base);
    expect(out.phi).toBe(0);
    expect(out.lags).toEqual([0, 1, 2, 3].map((lag) => ({ lag, n: 0, r: null })));
  });

  it.each([4, 5])("uses the Pearson threshold at %s filtered pairs", async (n) => {
    for (let i = 1; i <= n + 1; i++) await row(date(i), i, -2 * i);
    const out = await correlate(env.DB, { ...base, end: date(n + 1), max_lag: 0 });
    expect(out.lags).toEqual([{ lag: 0, n, r: n === 5 ? -1 : null }]);
    expect(out.caveats).toBe(caveats(n));
  });

  it.each(["x", "y"])("returns null r for constant %s while retaining the pair count", async (constant) => {
    for (let i = 1; i <= 7; i++) await row(date(i), constant === "x" ? 4 : i, constant === "y" ? 4 : i);
    expect((await correlate(env.DB, { ...base, max_lag: 0 })).lags).toEqual([{ lag: 0, n: 6, r: null }]);
  });

  it("fills absent behaviour rows with zero even in an entirely empty database", async () => {
    const out = await correlate(env.DB, { ...base, x: "cigarettes", y: "caffeine_mg" });
    expect(out.phi).toBe(0);
    expect(out.lags).toEqual([0, 1, 2, 3].map((lag) => ({ lag, n: 6, r: null })));
    expect(out.caveats).toBe(caveats(6));
  });

  it("uses stored negative and fractional behaviour values and clamps negative phi", async () => {
    for (let i = 1; i <= 8; i++) {
      await row(date(i), null, i % 2 ? -2 : 2);
      await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, 'cigarettes', ?, 1, 0)")
        .bind(date(i), i % 2 ? 0.5 : -0.5).run();
    }
    const out = await correlate(env.DB, { ...base, end: date(8), x: "cigarettes", max_lag: 0 });
    expect(out.phi).toBe(-0.99);
    expect(out.lags).toEqual([{ lag: 0, n: 7, r: -1 }]);
  });

  it("clamps positive phi in tool output", async () => {
    for (let i = 0; i <= 30; i++) await row(date(i + 1), Math.cos(i * Math.PI / 30), i);
    expect((await correlate(env.DB, { ...base, end: date(31), max_lag: 0 })).phi).toBe(0.99);
  });

  it("normalizes non-finite/null behaviours to zero and non-finite outcomes to missing before filtering", async () => {
    const x = [900001, 900002, null, 900003, 0, null, 0];
    const y = [1, 2, 900001, 4, 900002, 6, 7];
    for (let i = 0; i < x.length; i++) {
      await row(date(i + 1), y[i], null);
      if (x[i] !== null) await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, 'cigarettes', ?, 1, 0)")
        .bind(date(i + 1), x[i]).run();
    }
    const rewrite = (value: unknown): unknown => {
      if (typeof value === "number") return ({ 900001: Infinity, 900002: NaN, 900003: -Infinity } as Record<number, number>)[value] ?? value;
      if (Array.isArray(value)) return (value as unknown[]).map(rewrite);
      if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]: [string, unknown]) => [k, rewrite(v)]));
      return value;
    };
    expect(await correlate(observed(rewrite).db, { ...base, x: "cigarettes", y: "rhr", max_lag: 0 }))
      .toEqual({ ...base, x: "cigarettes", y: "rhr", phi: 0, lags: [{ lag: 0, n: 2, r: null }], caveats: caveats(2) });
  });

  it.each(names)("accepts %s in either variable position", async (name) => {
    const other = name === "rhr" ? "sleep_min" : "rhr";
    expect((await correlate(env.DB, { ...base, x: name, y: other })).x).toBe(name);
    expect((await correlate(env.DB, { ...base, x: other, y: name })).y).toBe(name);
  });
});

describe("T17 correlate validation and AC5 bounded SELECT", () => {
  const badDate = "date must be a real calendar date in YYYY-MM-DD format";
  const badNames = `x and y must be distinct names from: ${names.join(", ")}`;
  const invalid: [Partial<Args>, string][] = [
    ...["", "2026-1-01", "2026-02-30", "2026-02-29", "1999-12-31", "2100-01-01", "20260101", "2026-01-01T00:00:00Z"]
      .flatMap((day): [Partial<Args>, string][] => [[{ start: day }, badDate], [{ end: day }, badDate]]),
    [{ end: "2025-12-31" }, "range must contain 1 to 365 dates"], [{ end: "2027-01-01" }, "range must contain 1 to 365 dates"],
    [{ x: "rhr", y: "rhr" }, badNames],
    ...["bedtime_local", "waketime_local", "computed_at", "workout_min", "hr_wear_min", "z_ln_rmssd", "z_rhr", "z_sleep", "", "rhr; DROP TABLE event"]
      .flatMap((name): [Partial<Args>, string][] => [[{ x: name }, badNames], [{ y: name }, badNames]]),
    ...[-1, 8, 0.5, Infinity, -Infinity, NaN].map((max_lag): [Partial<Args>, string] => [{ max_lag }, "max_lag must be an integer from 0 to 7"]),
  ];
  it.each(invalid)("rejects %j before preparing SQL", async (overrides, message) => {
    const seen = observed();
    const pending = correlate(seen.db, { ...base, ...overrides });
    await expect(pending).rejects.toThrow(RangeError);
    await expect(pending).rejects.toThrow(message);
    expect(seen.reads).toEqual([]);
  });

  it.each([
    ["2026-01-01", "2026-12-31", 7, "2027-01-07"], ["2099-12-31", "2099-12-31", 7, "2100-01-07"],
    ["2000-01-01", "2000-01-01", 0, "2000-01-01"], ["2028-02-28", "2028-02-29", 1, "2028-03-01"],
    ["2026-10-24", "2026-10-25", 1, "2026-10-26"],
  ] as const)("binds one widened SELECT for %s..%s with max lag %s", async (start, end, max_lag, widened) => {
    if (end === "2026-12-31") for (let i = 1; i <= 365; i++) await row(date(i), i, i % 17);
    const seen = observed();
    const out = await correlate(seen.db, { ...base, start, end, max_lag });
    expect(seen.reads).toHaveLength(1);
    expect(seen.executions()).toBe(1);
    expect(seen.reads[0].sql).toMatch(/^\s*SELECT\b[\s\S]*\bFROM\s+v_daily\b[\s\S]*\bWHERE\s+local_date\s+BETWEEN\s+\?\s+AND\s+\?/i);
    expect(seen.reads[0].sql).not.toContain(start);
    expect(seen.reads[0].bindings).toEqual([start, widened]);
    expect(out.lags.map(({ lag }) => lag)).toEqual(Array.from({ length: max_lag + 1 }, (_, i) => i));
    if (end === "2026-12-31") expect(out.lags.map(({ n }) => n)).toEqual([364, 363, 362, 361, 360, 359, 358, 357]);
  });

  it("propagates D1 failure without returning empty lags", async () => {
    const failure = new Error("private D1 failure");
    const reject = () => Promise.reject(failure);
    const statement = { bind: () => statement, all: reject, first: reject, raw: reject, run: reject };
    const db = { prepare: () => statement, batch: reject, exec: reject } as unknown as D1Database;
    await expect(correlate(db, base)).rejects.toBe(failure);
  });
});
