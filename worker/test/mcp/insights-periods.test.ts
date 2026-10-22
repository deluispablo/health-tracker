import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cusum, evaluatePeriods, healthPeriods, streaks, validatePeriodsArgs } from "../../src/mcp/tools/insights/periods";
import { BANNED } from "../../src/mcp/tools/insights/catalog";
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

it("cusum start is the last zero of the alarming accumulator", () => {
  expect(detect([-1, -1, 2, 2, 2])).toEqual([{ start: dates[1], alarm: dates[4], direction: "up", shift: 1.25, observed_days: 4, calendar_days: 4 }]);
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
  const t = await loadDayTable(env.DB, resolveRange({ start: dates[1], end: dates[6] }, FIXTURE.now, FIXTURE.tz), FIXTURE.now);
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
it("applies BH separately per streak and supports a single saved key on an overridden range", async () => {
  await seedInsightsFixture(env.DB);
  const singleBehavior = await evaluatePeriods(env.DB, origin, deps);
  const all = await evaluatePeriods(env.DB, { tool: "health_periods", args: { start: FIXTURE.start, end: FIXTURE.end } }, deps);
  expect(all.rows.filter(r => r.behavior === "cigarettes").map(r => ({ ...r, ref: null }))).toEqual(singleBehavior.rows.map(r => ({ ...r, ref: null })));
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
