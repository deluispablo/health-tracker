import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { evaluateContrast, healthContrast, validateContrastArgs } from "../../src/mcp/tools/insights/contrast";
import { BANNED, METRICS } from "../../src/mcp/tools/insights/catalog";
import { benjaminiHochberg } from "../../src/mcp/tools/stats";
import { FIXTURE, seedInsightsFixture } from "../fixtures/insights";

let ctx: ExecutionContext;
beforeEach(() => { ctx = createExecutionContext(); });
afterEach(async () => { await waitOnExecutionContext(ctx); });
const deps = { nowSec: FIXTURE.now, tz: FIXTURE.tz };
const dates = { start: FIXTURE.start, end: FIXTURE.end };
const metricArgs = { ...dates, timing: "that_night", a: { where: [{ metric: "bedtime", scale: "z", op: ">=", value: 1 }] },
  b: { where: [{ metric: "bedtime", scale: "z", op: ">", value: -0.5 }, { metric: "bedtime", scale: "z", op: "<", value: 0.5 }] } };
const condition = (behavior: string) => ({ behavior, op: ">", value: 0 });
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["analysis_log", "sleep_stage", "sleep_session", "event", "daily_summary", "workout", "metric_minute"].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});
it.each([
  [{ ...metricArgs, b: { where: [condition("cigarettes")] } }, /mix|behavio/i],
  [{ ...metricArgs, b: { where: [{ metric: "hrv", op: ">", value: 0 }] } }, /single|one exposure/i],
  [{ ...metricArgs, timing: undefined }, /timing.*required/i],
  [{ ...metricArgs, a: { where: [{ metric: "hrv", op: ">", value: 0 }] }, b: {}, metrics: ["sleep_min"] }, /timing table/i],
  [{ ...metricArgs, metrics: ["sleep_min"] }, /arithmetic/i],
  [{ ...dates, a: { where: [condition("short_sleep")] }, b: {}, metrics: ["deep_min"] }, /exclu.*short_sleep.*deep_min/i],
  [{ ...dates, a: { where: [{ ...condition("cigarettes"), timing: "before_bed" }] }, b: {} }, /before_bed/i],
  [{ a: {}, b: {}, metrics: [] }, /metrics/i],
  [{ a: {}, b: {}, metrics: ["hr_delta"] }, /timing|acute/i],
  [{ a: { weekdays: [0] }, b: {} }, /weekdays/i],
  [{ a: { where: [{ ...condition("cigarettes"), scale: "z" }] }, b: {} }, /metric.*only/i],
  [{ a: { from: "2026-02-30" }, b: {} }, /date/i],
  [{ a: {}, b: {}, window_days: 30, ...dates }, /range|window_days/i],
])("refuses invalid contrast %#", (args, rule) => {
  expect(() => validateContrastArgs(args, FIXTURE.now, FIXTURE.tz)).toThrow(RangeError);
  expect(() => validateContrastArgs(args, FIXTURE.now, FIXTURE.tz)).toThrow(rule);
});
it("empty database returns sin_datos rows without numeric differences", async () => {
  const result = await evaluateContrast(env.DB, validateContrastArgs({ a: {}, b: {}, metrics: ["rhr"] }, FIXTURE.now, FIXTURE.tz), deps);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ label: "sin_datos", diff: null });
});
it("filters selecting the same days drop them from both groups", async () => {
  await seedInsightsFixture(env.DB);
  const result = await evaluateContrast(env.DB, validateContrastArgs({ ...dates, a: {}, b: {}, metrics: ["rhr"] }, FIXTURE.now, FIXTURE.tz), deps);
  expect(result.excluded.both_groups).toBe(180);
  expect(result.rows[0]).toMatchObject({ n_a: 0, n_b: 0, diff: null, label: "sin_datos" });
});
it("null condition value does not match", async () => {
  const result = await evaluateContrast(env.DB, validateContrastArgs({ a: { where: [{ behavior: "cigarettes", op: "=", value: 0 }] }, b: {}, metrics: ["rhr"] }, FIXTURE.now, FIXTURE.tz), deps);
  expect(result.excluded.both_groups).toBe(0);
  expect(result.excluded.exposure_unknown).toBe(120);
});
it("weekdays filter by exposure date", async () => {
  await seedInsightsFixture(env.DB);
  const args = { start: "2026-09-01", end: "2026-09-28", a: { weekdays: [1] }, b: { weekdays: [2] }, metrics: ["rhr"] };
  const result = await evaluateContrast(env.DB, validateContrastArgs(args, FIXTURE.now, FIXTURE.tz), deps);
  const { results } = await env.DB.prepare("SELECT rhr FROM daily_summary WHERE local_date IN ('2026-09-08','2026-09-15','2026-09-22','2026-09-29')").all<{ rhr: number }>();
  expect(result.rows[0].n_a).toBe(results.length);
  expect(result.rows[0].mean_a).toBeCloseTo(results.reduce((s, r) => s + r.rhr, 0) / results.length, 3);
});
it("bedtime bands return three model rows with BH and replay without writes", async () => {
  await seedInsightsFixture(env.DB);
  const origin = validateContrastArgs(metricArgs, FIXTURE.now, FIXTURE.tz);
  const family = await evaluateContrast(env.DB, origin, deps);
  expect(family.rows.map(r => r.metric).sort()).toEqual(["deep_pct", "hrv", "rhr"]);
  expect(family.tests).toBe(3);
  expect(family.rows.find(r => r.metric === "rhr")?.diff).toBeCloseTo(2, 0);
  const qs = benjaminiHochberg(family.rows.map(r => r.p));
  family.rows.forEach((r, i) => { if (r.q !== null) expect(r.q).toBeCloseTo(qs[i] ?? 0, 3); });
  expect(await evaluateContrast(env.DB, origin, deps)).toEqual(family);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_log").first("n")).toBe(0);
  const only = await evaluateContrast(env.DB, origin, { ...deps, only: family.rows[0].ref?.key });
  expect(only.tests).toBe(1);
  expect(only.rows[0].q).toBe(only.rows[0].p);
});
it("response stays within 20000 characters with long filters and records one log", async () => {
  await seedInsightsFixture(env.DB);
  const where = Array.from({ length: 4 }, () => ({ behavior: "caffeine", op: ">=", value: 0 }));
  let statements = 0;
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => { statements++; return target.prepare(sql); };
    return Reflect.get(target, key) as unknown;
  } });
  const result = await healthContrast(db, { ...dates, a: { where }, b: { where, weekdays: [1, 2, 3] } }, deps, ctx);
  expect((Date.parse(dates.end) - Date.parse(dates.start)) / 86400000 + 1).toBe(180);
  expect(result.rows).not.toHaveLength(0);
  await waitOnExecutionContext(ctx);
  expect(statements).toBe(2);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(20000);
  expect(BANNED.test(JSON.stringify(result))).toBe(false);
  expect(result).toMatchObject({ range: dates, tests_last_24h: result.tests });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_log").first("n")).toBe(1);
});
it("anomalies are included only when both filters opt in", async () => {
  await seedInsightsFixture(env.DB);
  const base = { ...dates, a: { weekdays: [1, 2, 3] }, b: { weekdays: [4, 5, 6, 7] }, metrics: ["rhr"] };
  const run = (a: boolean, b: boolean) => evaluateContrast(env.DB, validateContrastArgs({ ...base,
    a: { ...base.a, include_anomalies: a }, b: { ...base.b, include_anomalies: b } }, FIXTURE.now, FIXTURE.tz), deps);
  const excluded = await run(false, false), one = await run(true, false), both = await run(true, true);
  expect(excluded.excluded.anomaly).toBeGreaterThan(0);
  expect(one.rows).toEqual(excluded.rows.map(r => ({ ...r, ref: one.rows[0].ref })));
  expect(both.excluded.anomaly).toBe(0);
  expect(both.rows[0].n_a + both.rows[0].n_b).toBe(excluded.rows[0].n_a + excluded.rows[0].n_b + excluded.excluded.anomaly);
});
it("before-bed conditions use the following night's window and combine with day conditions", async () => {
  await seedInsightsFixture(env.DB);
  const origin = validateContrastArgs({ ...dates, timing: "before_bed", metrics: ["deep_min"],
    a: { where: [{ behavior: "cigarettes", timing: "before_bed", op: "=", value: 1 }, { behavior: "caffeine", op: ">=", value: 0 }] },
    b: { where: [{ behavior: "cigarettes", timing: "before_bed", op: "=", value: 0 }] } }, FIXTURE.now, FIXTURE.tz);
  const result = await evaluateContrast(env.DB, origin, deps);
  expect(result.rows[0].n_a).toBeGreaterThan(8);
  expect(result.rows[0].n_b).toBeGreaterThan(8);
  expect(result.rows[0].diff).toBeLessThan(-5);
});
it("single-row selection accepts reordered saved key fields", async () => {
  await seedInsightsFixture(env.DB);
  const origin = validateContrastArgs(metricArgs, FIXTURE.now, FIXTURE.tz);
  const result = await evaluateContrast(env.DB, origin, { ...deps, only: { metric: "rhr", timing: "that_night", exposure: { side: "filter", metric: "bedtime" }, kind: "metric" } });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].q).toBe(result.rows[0].p);
});
it("date filters outside the displayed range select no days", async () => {
  const origin = validateContrastArgs({ ...dates, metrics: ["rhr"], a: { from: "2020-01-01", to: "2020-12-31" }, b: {} }, FIXTURE.now, FIXTURE.tz);
  expect((await evaluateContrast(env.DB, origin, deps)).rows[0]).toMatchObject({ n_a: 0, diff: null, label: "sin_datos" });
});

it.each(["a", "b"] as const)("bounds %s to four conditions before evaluating filters", side => {
  const args = { ...dates, a: {}, b: {}, [side]: { where: Array.from({ length: 4 }, () => condition("caffeine")) } };
  expect(() => validateContrastArgs(args, FIXTURE.now, FIXTURE.tz)).not.toThrow();
  for (const length of [5, 10000]) {
    expect(() => validateContrastArgs({ ...args, [side]: { where: Array.from({ length }, () => condition("caffeine")) } }, FIXTURE.now, FIXTURE.tz))
      .toThrow(/where.*at most 4/);
    expect(() => validateContrastArgs({ ...args, [side]: { where: Array.from({ length }, () => condition("caffeine")) } }, FIXTURE.now, FIXTURE.tz))
      .toThrow(RangeError);
  }
});
it.each(["a", "b"] as const)("bounds %s weekdays before schema traversal and rejects duplicates", side => {
  const args = { a: {}, b: {} };
  const weekdays = [1, 2, 3, 4, 5, 6, 7];
  expect(validateContrastArgs({ ...args, [side]: { weekdays } }, FIXTURE.now, FIXTURE.tz).args[side].weekdays).toEqual(weekdays);
  expect(() => validateContrastArgs({ ...args, [side]: { weekdays: [1, 1] } }, FIXTURE.now, FIXTURE.tz))
    .toThrow(/weekdays.*duplicates/);
  for (const length of [8, 10000]) {
    const oversized = Array<number>(length).fill(1);
    Object.defineProperty(oversized, 0, { get() { throw new Error("Traversed oversized weekdays"); } });
    expect(() => validateContrastArgs({ ...args, [side]: { weekdays: oversized } }, FIXTURE.now, FIXTURE.tz))
      .toThrow(/weekdays.*at most 7/);
  }
});
it("bounds metrics to the catalogue size before schema traversal and rejects duplicates", () => {
  const args = { a: {}, b: {} };
  expect(validateContrastArgs({ ...args, metrics: ["rhr", "hrv"] }, FIXTURE.now, FIXTURE.tz).args.metrics).toEqual(["rhr", "hrv"]);
  expect(() => validateContrastArgs({ ...args, metrics: ["rhr", "rhr"] }, FIXTURE.now, FIXTURE.tz))
    .toThrow(/metrics.*duplicates/);
  const limit = Object.keys(METRICS).length;
  expect(() => validateContrastArgs({ ...args, metrics: Array<string>(limit).fill("rhr") }, FIXTURE.now, FIXTURE.tz))
    .toThrow(/metrics.*duplicates/);
  for (const length of [limit + 1, 10000]) {
    const oversized = Array<string>(length).fill("rhr");
    Object.defineProperty(oversized, 0, { get() { throw new Error("Traversed oversized metrics"); } });
    expect(() => validateContrastArgs({ ...args, metrics: oversized }, FIXTURE.now, FIXTURE.tz))
      .toThrow(`metrics allows at most ${String(limit)} distinct values.`);
  }
});
it("public metric rows serialize required nullable fields", async () => {
  await seedInsightsFixture(env.DB);
  const result = JSON.parse(JSON.stringify(await healthContrast(env.DB, metricArgs, deps, ctx))) as { rows: Record<string, unknown>[] };
  expect(result.rows).toHaveLength(3);
  for (const row of result.rows) expect(row).toMatchObject({ planned_id: null, expected: null });
});
it("null metric exposures count once across filters and outcomes", async () => {
  const result = await evaluateContrast(env.DB, validateContrastArgs({ ...metricArgs, metrics: ["rhr", "hrv"] }, FIXTURE.now, FIXTURE.tz), deps);
  expect(result.excluded).toMatchObject({ exposure_unknown: 180, incomplete_pair: 0, middle_band: 0 });
});
it("exposure_unknown is independent of condition order after a failed condition", async () => {
  await seedInsightsFixture(env.DB);
  await env.DB.prepare("UPDATE daily_summary SET steps = NULL").run();
  const where = [{ behavior: "caffeine", op: ">", value: 1000000 }, condition("steps")];
  const run = (conditions: typeof where) => evaluateContrast(env.DB, validateContrastArgs({ ...dates,
    a: { where: conditions }, b: { where: conditions }, metrics: ["rhr"] }, FIXTURE.now, FIXTURE.tz), deps);
  const forward = await run(where), reverse = await run([...where].reverse());
  expect(forward.excluded.exposure_unknown).toBe(180);
  expect(reverse.excluded).toEqual(forward.excluded);
});
it("explicit metric filters do not count date, weekday, value or overlap exclusions as middle band", async () => {
  await seedInsightsFixture(env.DB);
  const origin = validateContrastArgs({ ...metricArgs, a: { ...metricArgs.a, from: "2026-09-01", weekdays: [1] },
    b: { ...metricArgs.a, to: "2026-09-30", weekdays: [1] } }, FIXTURE.now, FIXTURE.tz);
  const result = await evaluateContrast(env.DB, origin, deps);
  expect(result.excluded.both_groups).toBeGreaterThan(0);
  expect(result.excluded.middle_band).toBe(0);
  expect(result.rows.some(r => r.n_a + r.n_b > 0)).toBe(true);
});
it("unselected days with missing metric exposures do not count as incomplete model pairs", async () => {
  const origin = validateContrastArgs({ ...metricArgs, metrics: ["rhr"],
    a: { ...metricArgs.a, to: "2020-12-31" }, b: { ...metricArgs.b, weekdays: [] } }, FIXTURE.now, FIXTURE.tz);
  const result = await evaluateContrast(env.DB, origin, deps);
  expect(result.excluded).toMatchObject({ exposure_unknown: 0, middle_band: 0, incomplete_pair: 0 });
  expect(result.rows[0]).toMatchObject({ n_a: 0, n_b: 0, diff: null, label: "sin_datos" });
});
