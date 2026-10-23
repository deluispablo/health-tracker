import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cusum, evaluatePeriods, healthPeriods, streaks, validatePeriodsArgs } from "../../src/mcp/tools/insights/periods";
import { benjaminiHochberg } from "../../src/mcp/tools/stats";
import { BANNED, METRICS, PHRASES } from "../../src/mcp/tools/insights/catalog";
import { loadDayTable, resolveRange } from "../../src/mcp/tools/insights/units";
import type { FamilyRow, Origin } from "../../src/mcp/tools/insights/types";
import { FIXTURE, seedInsightsFixture } from "../fixtures/insights";

let ctx: ExecutionContext;
beforeEach(() => { ctx = createExecutionContext(); });
afterEach(async () => { await waitOnExecutionContext(ctx); });
const deps = { nowSec: FIXTURE.now, tz: FIXTURE.tz };
const origin: Extract<Origin, { tool: "health_periods" }> = { tool: "health_periods", args: { start: FIXTURE.start, end: FIXTURE.end, behaviors: ["cigarettes"] } };
const dates = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10));
const detect = (z: (number | null)[], days = dates.slice(0, z.length)) => cusum(days, z, z.map(x => x === null ? null : 60 + x), z.map(() => 60));

it("cusum start is the first observed day after the alarming accumulator's last zero", () => {
  expect(detect([-1, -1, 2, 2, 2])).toEqual([{ start: dates[2], alarm: dates[4], direction: "up", shift: 2, observed_days: 3, calendar_days: 3 }]);
  expect(detect([-1, null, 2, 2, 2])[0]).toMatchObject({ start: dates[2], shift: 2 });
  expect(detect([1, 1, -2, -2, -2])[0]).toMatchObject({ start: dates[2], direction: "down", shift: -2 });
});
it("cusum resets after an alarm", () => {
  const changes = detect([3, 3, 3, 3]);
  expect(changes.map(c => [c.start, c.alarm])).toEqual([[dates[0], dates[1]], [dates[2], dates[3]]]);
});
it("eight missing days reset CUSUM, while seven preserve it", () => {
  expect(detect([3, 3], [dates[0], dates[9]])).toEqual([]);
  expect(detect([3, null, 3], [dates[0], dates[1], dates[8]])[0]).toMatchObject({ start: dates[0], alarm: dates[8], observed_days: 2, calendar_days: 9 });
});
it("S minus detects a downward shift", () => {
  expect(detect([-3, -3])[0]).toMatchObject({ direction: "down", shift: -3 });
  expect(detect([2.5, 2.5])).toEqual([]);
});

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch(["sleep_stage", "sleep_session", "event", "daily_summary", "workout", "metric_minute", "analysis_log"].map(t => env.DB.prepare(`DELETE FROM ${t}`)));
});

async function seedSmall(opposite = 3) {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < 8; i++) {
    const day = dates[i];
    const tracker = i < opposite + 1 ? "cigarettes" : "mood_cansado";
    statements.push(env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES (?,?,?,0,?,1,'import',1)")
      .bind(`tap-${String(i)}`, tracker, Date.parse(day + "T12:00:00Z") / 1000, day));
    statements.push(env.DB.prepare("INSERT INTO daily_summary (local_date,rhr,hr_wear_min,computed_at) VALUES (?,?,1440,1)").bind(day, 60 + i));
    statements.push(env.DB.prepare("INSERT INTO sleep_session (source_id,start_ts,end_ts,tz_offset_min,local_date,minutes_asleep,minutes_in_bed,updated_at) VALUES (?,?,?,0,?,?,450,1)")
      .bind(`sleep-${String(i)}`, Date.parse(day + "T00:00:00Z") / 1000, Date.parse(day + "T08:00:00Z") / 1000, day, i < 5 ? 400 : 500));
  }
  await env.DB.batch(statements);
}
const smallOrigin: typeof origin = { tool: "health_periods", args: { start: dates[1], end: dates[6], behaviors: ["cigarettes"], metrics: ["rhr", "sleep_min"] } };

it("streak before-window needs at least 3 opposite days", async () => {
  await seedSmall(2);
  const family = await evaluatePeriods(env.DB, smallOrigin, deps);
  expect(family.rows).toHaveLength(2);
  for (const row of family.rows) expect(row).toMatchObject({ n_b: 2, diff: null, label: "sin_datos" });
});
it("a current streak keeps its fetched start and comparison groups on a short displayed range", async () => {
  await seedSmall();
  const family = await evaluatePeriods(env.DB, { ...smallOrigin, args: { ...smallOrigin.args, start: dates[5] } }, deps);
  expect(family.resolved).toEqual({ start: dates[5], end: dates[6] });
  expect(family.extra.streaks).toEqual([
    { behavior: "cigarettes", state: "absent", start: dates[4], end: dates[6], days: 3, current: true },
  ]);
  expect(family.rows.find(r => r.metric === "rhr")).toMatchObject({ n_a: 3, n_b: 3, mean_a: 65, mean_b: 62, diff: 3 });
  expect(family.rows.find(r => r.metric === "sleep_min")).toMatchObject({ n_a: 3, n_b: 3, mean_a: 500, mean_b: 400, diff: 100 });
});
it("a null day ends a streak", async () => {
  await seedSmall();
  const t = await loadDayTable(env.DB, resolveRange({ start: dates[1], end: dates[6] }, FIXTURE.now, FIXTURE.tz), FIXTURE.now, FIXTURE.tz);
  t.behavior.cigarettes[t.idx(dates[5])] = null;
  expect(streaks(t, "cigarettes")).toEqual([
    { behavior: "cigarettes", state: "present", start: dates[1], end: dates[3], days: 3, current: false },
    { behavior: "cigarettes", state: "absent", start: dates[6], end: dates[6], days: 1, current: true },
  ]);
});
it("night-anchored streak metrics read the night after each bday", async () => {
  await seedSmall();
  const family = await evaluatePeriods(env.DB, smallOrigin, deps);
  expect(family.rows.find(r => r.metric === "sleep_min")).toMatchObject({ n_a: 3, n_b: 3, mean_a: 500, mean_b: 400, diff: 100 });
  expect(family.rows.find(r => r.metric === "rhr")).toMatchObject({ mean_a: 65, mean_b: 62, diff: 3 });
});
it("mood week with only tired taps has null positive share", async () => {
  await seedSmall();
  const family = await evaluatePeriods(env.DB, smallOrigin, deps);
  expect(family.extra.mood_weeks).toEqual([
    expect.objectContaining({ positive_share: null, tired_share: 1, week: "2026-W37", current: true }),
    expect.objectContaining({ positive_share: null, tired_share: 1, week: "2026-W36", current: false }),
  ]);
});
it("empty database returns empty lists", async () => {
  expect(await healthPeriods(env.DB, {}, deps, ctx)).toMatchObject({ rows: [], streaks: [], changes: [], mood_weeks: [], anomalies: [], tests: 0, tests_last_24h: 0, truncated: false });
});
it("evaluatePeriods writes nothing and the public call executes day table plus log", async () => {
  const prepare = vi.spyOn(env.DB, "prepare");
  await evaluatePeriods(env.DB, origin, deps);
  expect(prepare).toHaveBeenCalledTimes(1);
  prepare.mockClear();
  await healthPeriods(env.DB, {}, deps, ctx);
  expect(prepare).toHaveBeenCalledTimes(2);
  prepare.mockRestore();
  await waitOnExecutionContext(ctx);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_log").first("n")).toBe(1);
});
it("validates arguments and preserves relative origin ranges", () => {
  expect(validatePeriodsArgs({}, deps)).toEqual({ window_days: 120 });
  for (const args of [{ behaviors: ["steps"] }, { metrics: ["hr_delta"] }, { metrics: ["bogus"] }, { window_days: 3, start: dates[0] }, { limit: 10 }, null]) {
    expect(() => validatePeriodsArgs(args, deps)).toThrow(RangeError);
  }
});

it("current 9-day cigarette absence streak returns an rhr row within 25 percent of minus 4", async () => {
  await seedInsightsFixture(env.DB);
  const result = await healthPeriods(env.DB, origin.args, deps, ctx);
  expect(result.streaks).toEqual(expect.arrayContaining([expect.objectContaining({ behavior: "cigarettes", state: "absent", days: 9, current: true })]));
  const row = (result.rows as FamilyRow[]).find(r => r.metric === "rhr");
  expect(row?.diff).toBeGreaterThanOrEqual(-5);
  expect(row?.diff).toBeLessThanOrEqual(-3);
  expect(row?.ref).toMatchObject({ key: { kind: "period", behavior: "cigarettes", timing: "streak", metric: "rhr" } });
});
it("mood_enfadado during vs before", async () => {
  await seedInsightsFixture(env.DB);
  const family = await evaluatePeriods(env.DB, { ...origin, args: { ...origin.args, metrics: ["mood_enfadado"] } }, deps);
  expect(family.rows[0]).toMatchObject({ n_a: 9, mean_a: 0.333, mean_b: 0, diff: 0.333 });
});
it("anomaly listed and excluded from streak comparisons", async () => {
  await seedInsightsFixture(env.DB);
  const result = await healthPeriods(env.DB, origin.args, deps, ctx);
  expect(result.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({ date: FIXTURE.planted.illnessDays[0] })]));
  const family = await evaluatePeriods(env.DB, { ...origin, args: { start: "2026-08-05", end: "2026-08-12", behaviors: ["cigarettes"] } }, deps);
  expect(family.extra.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({ date: "2026-08-10" })]));
});
it("streak rows capped at 40 while the evaluator keeps the full families", async () => {
  await seedInsightsFixture(env.DB);
  await env.DB.prepare("UPDATE event SET deleted_at = 1 WHERE tracker_id IN ('cigarettes','caffeine','alcohol') AND ts >= ?").bind(Date.parse("2026-09-20T00:00:00Z") / 1000).run();
  const family = await evaluatePeriods(env.DB, { tool: "health_periods", args: { start: FIXTURE.start, end: FIXTURE.end } }, deps);
  expect(family.tests).toBeGreaterThan(40);
  expect(family.rows).toHaveLength(family.tests);
  const result = await healthPeriods(env.DB, { start: FIXTURE.start, end: FIXTURE.end }, deps, ctx);
  expect((result.rows as unknown[]).length).toBeLessThanOrEqual(40);
  for (const [key, max] of [["streaks", 10], ["changes", 10], ["mood_weeks", 8], ["anomalies", 10]] as const) expect((result[key] as unknown[]).length).toBeLessThanOrEqual(max);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(20000);
  expect(JSON.stringify(result)).not.toMatch(BANNED);
  expect((result.rows as Record<string, unknown>[]).every(r => !('kind' in r) && !('rope' in r) && !('binary' in r))).toBe(true);
});

it("compares the current ISO week with up to four earlier weeks having at least five taps", async () => {
  const mondays = ["2025-11-24", "2025-12-01", "2025-12-08", "2025-12-15", "2025-12-22", "2025-12-29", "2026-01-05"];
  for (const [i, day] of mondays.entries()) {
    const count = i === 5 ? 4 : 5;
    await env.DB.batch(Array.from({ length: count }, (_, j) => env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES (?,?,?,0,?,1,'import',1)")
      .bind(`week-${String(i)}-${String(j)}`, i === 0 || i === 6 ? "mood_bien" : "mood_estresado", Date.parse(day + "T12:00:00Z") / 1000 + j, day)));
  }
  const family = await evaluatePeriods(env.DB, { tool: "health_periods", args: { start: mondays[0], end: "2026-01-05", behaviors: [] } }, deps);
  expect(family.extra.mood_weeks).toEqual(expect.arrayContaining([
    expect.objectContaining({ week: "2026-W02", positive_share: 1, comparison: { weeks: 4, positive_share: 0, tired_share: 0, positive_diff: 1, tired_diff: 0 } }),
    expect.objectContaining({ week: "2026-W01", start: "2025-12-29" }),
  ]));
});
it("applies one BH family across every streak and supports a single saved key on an overridden range", async () => {
  await seedInsightsFixture(env.DB);
  const singleBehavior = await evaluatePeriods(env.DB, origin, deps);
  const all = await evaluatePeriods(env.DB, { tool: "health_periods", args: { start: FIXTURE.start, end: FIXTURE.end } }, deps);
  expect(new Set(all.rows.map(r => r.behavior)).size).toBeGreaterThan(1);
  // Rows carry p rounded to 4 decimals, so the joint q is recomputed to 2.
  const joint = benjaminiHochberg(all.rows.map(r => r.p));
  all.rows.forEach((r, i) => { const q = joint[i]; if (q === null) expect(r.q).toBeNull(); else expect(r.q).toBeCloseTo(q, 2); });
  for (const r of singleBehavior.rows) expect(r.q === null || (r.q >= 0 && r.q <= 1)).toBe(true);
  const row = singleBehavior.rows.find(r => r.metric === "rhr");
  expect(row?.ref).not.toBeNull();
  const only = await evaluatePeriods(env.DB, origin, { ...deps, range: singleBehavior.resolved, only: row?.ref?.key });
  expect(only.rows).toHaveLength(1);
  expect(only.rows[0].q).toBe(only.rows[0].p);
  const earlier = await evaluatePeriods(env.DB, origin, { ...deps, range: { start: dates[0], end: dates[3] } });
  expect(earlier.resolved).toEqual({ start: dates[0], end: dates[3] });
});
it("drops anomalous exposure and following-night outcome dates", async () => {
  await seedInsightsFixture(env.DB);
  await env.DB.prepare("UPDATE event SET deleted_at = 1 WHERE tracker_id = 'cigarettes' AND ts >= ?").bind(Date.parse("2026-08-08T00:00:00Z") / 1000).run();
  await env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES ('last-cigarette','cigarettes',?,0,'2026-08-09',1,'import',1)")
    .bind(Date.parse("2026-08-09T12:00:00Z") / 1000).run();
  const family = await evaluatePeriods(env.DB, { tool: "health_periods", args: { start: "2026-08-10", end: "2026-08-12", behaviors: ["cigarettes"], metrics: ["rhr", "sleep_min"] } }, deps);
  expect(family.rows).toHaveLength(2);
  expect(family.excluded.anomaly).toBeGreaterThan(0);
  for (const row of family.rows) expect(row).toMatchObject({ n_a: 0, diff: null, label: "sin_datos" });
});
it("records every attempted row once and includes prior tests in the 24-hour total", async () => {
  await seedSmall(2);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO analysis_log VALUES (?, 'health_scan', 7)").bind(FIXTURE.now * 1000 - 1),
    env.DB.prepare("INSERT INTO analysis_log VALUES (?, 'health_scan', 100)").bind(FIXTURE.now * 1000 - 86400001),
  ]);
  const result = await healthPeriods(env.DB, smallOrigin.args, deps, ctx);
  expect(result).toMatchObject({ tests: 2, tests_last_24h: 9 });
  await waitOnExecutionContext(ctx);
  expect(await env.DB.prepare("SELECT tests FROM analysis_log WHERE tool = 'health_periods'").first("tests")).toBe(2);
});

// DR0: 60 logged days from 2026-07-01 (day 0 is the unknown first day); from day 40 caffeine 100 → 300 mg and alcohol 30 → 0 g; water flat.
const behaviorDays = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10));
async function seedBehaviors() {
  await env.DB.batch(behaviorDays.flatMap((day, i) => {
    const ts = Date.parse(day + "T12:00:00Z") / 1000;
    const tap = (tracker: string, value: number) => env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES (?,?,?,0,?,?,'import',1)")
      .bind(`${tracker}-${String(i)}`, tracker, ts, day, value);
    return [tap("caffeine", i < 40 ? 100 : 300), tap("water", 1000), ...(i < 40 ? [tap("alcohol", 30)] : [])];
  }));
}
// Ends two days after the shift: CUSUM keeps re-alarming while the trailing baseline lags (R0.4), so the list stays small.
const behaviorRange = { start: behaviorDays[0], end: behaviorDays[42] };
const metricIds = Object.keys(METRICS).filter(m => m !== "hr_delta");

it("behavior_changes reports sustained behaviour shifts with direction and start, and not flat behaviours", async () => {
  await seedBehaviors();
  const result = await healthPeriods(env.DB, behaviorRange, deps, ctx);
  const change = (metric: string, start: number, alarm: number, direction: string, shift: number, days: number) =>
    ({ metric, start: behaviorDays[start], alarm: behaviorDays[alarm], direction, shift, observed_days: days, calendar_days: days, label: "cambio", phrase: PHRASES.cambio });
  expect(result.behavior_changes).toEqual([
    change("caffeine", 42, 42, "up", 200, 1),
    change("alcohol", 40, 41, "down", -30, 2),
    change("caffeine", 41, 41, "up", 200, 1),
    change("caffeine", 40, 40, "up", 200, 1),
  ]);
});
it("behavior_changes never changes the legacy size-cap decisions near 20,000 characters", async () => {
  await seedBehaviors();
  const strip = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "behavior_changes"));
  const full = await healthPeriods(env.DB, behaviorRange, deps, ctx);
  const legacy = strip(full), changes = full.behavior_changes as unknown[];
  expect(legacy.truncated).toBe(false);
  expect((legacy.streaks as unknown[]).length).toBeGreaterThan(0);
  const stringify = JSON.stringify.bind(JSON);
  // Pad only the size checks on the response object, so the legacy content sits exactly at a chosen length.
  const at = async (pad: number) => {
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: []) => {
      const s = stringify(value, ...rest);
      return value !== null && typeof value === "object" && "truncated" in value ? s + "x".repeat(pad) : s;
    }) as typeof JSON.stringify);
    try { return await healthPeriods(env.DB, behaviorRange, deps, ctx); } finally { spy.mockRestore(); }
  };
  const tight = await at(19990 - stringify(legacy).length);
  expect(tight).not.toHaveProperty("behavior_changes");
  expect(tight).toEqual(legacy);
  const one = await at(20000 - stringify({ ...legacy, behavior_changes: changes.slice(0, 1) }).length);
  expect(strip(one)).toEqual(legacy);
  expect(one.behavior_changes).toEqual(changes.slice(0, 1));
});
it("behavior_changes on a short displayed range uses the prior history for the baseline", async () => {
  await seedBehaviors();
  const family = await evaluatePeriods(env.DB, { tool: "health_periods", args: { start: behaviorDays[40], end: behaviorDays[42], metrics: ["caffeine"] } }, deps);
  // Three displayed days alone could never reach the 14-value baseline; the alarm needs the fetched history.
  expect((family.extra.behavior_changes as { alarm: string }[]).map(c => c.alarm)).toEqual([behaviorDays[42], behaviorDays[41], behaviorDays[40]]);
  expect((family.extra.behavior_changes as unknown[])[2]).toMatchObject({ metric: "caffeine", start: behaviorDays[40], direction: "up", shift: 200 });
});
it("metrics selects behaviour changes: omitted gives all four, a list gives only its behaviours, empty gives none", async () => {
  await seedBehaviors();
  const run = async (metrics?: string[]) => ((await evaluatePeriods(env.DB, { tool: "health_periods", args: validatePeriodsArgs({ ...behaviorRange, ...(metrics && { metrics }) }, deps) }, deps))
    .extra.behavior_changes as { metric: string }[]).map(c => c.metric).filter((m, i, all) => all.indexOf(m) === i).sort();
  expect(await run()).toEqual(["alcohol", "caffeine"]);
  expect(await run(["caffeine", "rhr"])).toEqual(["caffeine"]);
  expect(await run(["water", "cigarettes"])).toEqual([]);
  expect(await run([])).toEqual([]);
  expect(await run(metricIds)).toEqual([]);
  expect(() => validatePeriodsArgs({ metrics: ["melatonin"] }, deps)).toThrow(RangeError);
});
it("behaviour ids in metrics leave changes, streaks and streak rows unchanged on the insights fixture", async () => {
  await seedInsightsFixture(env.DB);
  const args = { start: FIXTURE.start, end: FIXTURE.end };
  const plain = await evaluatePeriods(env.DB, { tool: "health_periods", args }, deps);
  const listed = await evaluatePeriods(env.DB, { tool: "health_periods", args: validatePeriodsArgs({ ...args, metrics: [...metricIds, "cigarettes", "caffeine", "alcohol", "water"] }, deps) }, deps);
  for (const key of ["changes", "streaks", "mood_weeks", "anomalies", "behavior_changes"]) expect(listed.extra[key]).toEqual(plain.extra[key]);
  expect(listed.rows.map(r => ({ ...r, ref: null }))).toEqual(plain.rows.map(r => ({ ...r, ref: null })));
  expect((plain.extra.changes as { metric: string }[]).length).toBeGreaterThan(0);
  expect((plain.extra.changes as { metric: string }[]).every(c => metricIds.includes(c.metric))).toBe(true);
});
