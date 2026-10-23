import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisSeries, healthCompare } from "../../src/mcp/tools/compare";
import { healthCorrelate } from "../../src/mcp/tools/correlate";
import { healthTrend } from "../../src/mcp/tools/trend";
import { createEvaluator } from "../../src/mcp/tools/insights/evaluator";
import { evaluateContrast, validateContrastArgs } from "../../src/mcp/tools/insights/contrast";
import { evaluateScan, validateScanArgs } from "../../src/mcp/tools/insights/scan";
import { healthFindings } from "../../src/mcp/tools/insights/findings";
import { loadDayTable, resolveRange } from "../../src/mcp/tools/insights/units";
import type { FamilyRow } from "../../src/mcp/tools/insights/types";

// 2026-10-23 16:00 Europe/Madrid: the 2026-10-23 behaviour day is still open.
const tz = "Europe/Madrid";
const now = Date.parse("2026-10-23T14:00:00Z") / 1000;
const late = Date.parse("2026-10-23T21:00:00Z") / 1000;
const span = { start: "2026-10-13", end: "2026-10-22" };
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const caffeine = { a: { where: [{ behavior: "caffeine", op: ">", value: 0 }] }, b: { where: [{ behavior: "caffeine", op: "=", value: 0 }] } };

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["finding_check", "finding", "analysis_log", "event", "sleep_session", "daily_summary"].map(t => env.DB.prepare(`DELETE FROM ${t}`)));
  const s = [];
  // Tracking starts 2026-10-10, so moods and caffeine are known on every later day.
  for (let d = 10; d <= 23; d++) {
    const ts = Date.parse(day(d) + "T10:00:00Z") / 1000;
    const event = (id: string, tracker: string) => env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES (?,?,?,120,?,1,'import',1)").bind(id, tracker, ts, day(d));
    s.push(event(`mood-${String(d)}`, d % 2 === 0 || d === 23 ? "mood_bien" : "mood_triste"));
    if (d % 2 === 0) s.push(event(`caf-${String(d)}`, "caffeine"));
    s.push(env.DB.prepare("INSERT INTO daily_summary (local_date,steps,hr_wear_min,workout_min,rhr,ln_rmssd,computed_at) VALUES (?,?,900,?,?,4,1)")
      .bind(day(d), d === 23 ? 6200 : 5000 + d * 100, d === 23 ? 20 : 0, 60 + d % 3));
    s.push(env.DB.prepare("INSERT INTO sleep_session (source_id,start_ts,end_ts,tz_offset_min,local_date,minutes_asleep,minutes_in_bed,deep_min,updated_at) VALUES (?,?,?,120,?,420,480,60,1)")
      .bind(`sleep-${String(d)}`, ts - 12 * 3600, ts - 5 * 3600, day(d)));
  }
  await env.DB.batch(s);
});

it("nulls the open day's day-anchored values and keeps its night", async () => {
  const t = await loadDayTable(env.DB, resolveRange(span, now, tz), now, tz);
  const y = t.idx("2026-10-22"), today = t.idx("2026-10-23");
  expect([t.metric.steps[y], t.metric.workout_min[y], t.metric.mood_bien[y], t.metric.mood_positive[y], t.metric.mood_triste[y]]).toEqual([7200, 0, 1, 1, 0]);
  expect(t.metric.rhr[y]).not.toBeNull();
  for (const m of ["steps", "workout_min", "rhr", "mood_bien", "mood_triste", "mood_positive", "mood_negative", "mood_tired"] as const)
    expect(t.metric[m][today], m).toBeNull();
  expect([t.metric.sleep_min[today], t.metric.hrv[today], t.metric.deep_min[today]]).toEqual([420, 4, 60]);
});

it("contrast next_day drops the 2026-10-22 exposure and keeps 2026-10-21's", async () => {
  const opts = { nowSec: now, tz };
  for (const metric of ["steps", "mood_bien", "mood_positive"]) {
    const origin = validateContrastArgs({ ...span, ...caffeine, metrics: [metric], timing: "next_day" }, now, tz);
    const family = await evaluateContrast(env.DB, origin, opts);
    // a: even exposure days 14..22 minus 22; b: odd days 13..21, whose outcome includes 2026-10-22.
    expect(family.rows[0], metric).toMatchObject({ n_a: 4, n_b: 5 });
    expect(family.excluded.outcome_missing, metric).toBe(1);
  }
});

it("scan next_day drops the 2026-10-22 exposure for steps and mood_positive", async () => {
  const { origin } = validateScanArgs({ ...span, behaviors: ["caffeine"], metrics: ["steps", "mood_positive"], timings: ["next_day"] }, now, tz);
  const family = await evaluateScan(env.DB, origin, { nowSec: now, tz });
  expect(family.rows).toHaveLength(2);
  for (const row of family.rows) expect(row, row.metric).toMatchObject({ n_a: 4, n_b: 5 });
  expect(family.excluded.outcome_missing).toBe(2);
});

it("a recheck at 16:00 and 23:00 the same day stores the same result", async () => {
  const evaluator = createEvaluator(env.DB, { nowSec: now, tz });
  const origin = evaluator.validateOrigin({ tool: "health_contrast", args: { ...span, ...caffeine, metrics: ["steps"], timing: "next_day" } });
  const ref = (await evaluator.family(origin, {})).rows[0].ref;
  const saved = (await healthFindings(env.DB, { action: "save", statement: "caffeine steps", ref }, { nowMs: now * 1000, evaluator })).finding as { id: number };
  await healthFindings(env.DB, { action: "recheck", id: saved.id }, { nowMs: now * 1000 + 1, evaluator });
  await env.DB.batch([
    env.DB.prepare("UPDATE daily_summary SET steps = 15000 WHERE local_date = '2026-10-23'"),
    env.DB.prepare("UPDATE event SET tracker_id = 'mood_triste' WHERE id = 'mood-23'"),
  ]);
  await healthFindings(env.DB, { action: "recheck", id: saved.id }, { nowMs: late * 1000, evaluator: createEvaluator(env.DB, { nowSec: late, tz }) });
  const rows = (await env.DB.prepare("SELECT result FROM finding_check WHERE finding_id = ? ORDER BY checked_at").bind(saved.id).all<{ result: string }>()).results;
  expect(rows).toHaveLength(2);
  expect(rows[1].result).toBe(rows[0].result);
  // 2026-10-21's exposure (b group) still pairs with 2026-10-22's steps.
  expect(JSON.parse(rows[0].result) as FamilyRow).toMatchObject({ n_a: 4, n_b: 5 });
});

describe("analysisSeries skips the unfinished day (trend, compare, correlate)", () => {
  const trend = (metric: string, start: string, end: string, nowSec: number) =>
    healthTrend(env.DB, { metric, period: "month", start, end }, { nowSec, tz });
  const early = Date.parse("2026-10-24T01:00:00Z") / 1000; // 03:00 Madrid: 2026-10-23 is still open
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE daily_summary SET sleep_min = 420, steps = CASE local_date WHEN '2026-10-23' THEN 2000 ELSE steps END"),
      env.DB.prepare("INSERT INTO daily_summary (local_date,steps,rhr,ln_rmssd,sleep_min,computed_at) VALUES ('2026-10-24',3000,60,4,300,1)"),
    ]);
  });
  it.each([["16:00", now], ["03:00 next day", early]])("at %s steps for 2026-10-23 are excluded and its sleep is kept", async (_, at) => {
    const steps = await trend("steps", "2026-10-19", "2026-10-23", at);
    expect(steps.baseline.n).toBe(4);
    expect(steps.buckets[0].min).toBe(6900);
    expect((await trend("sleep_min", "2026-10-19", "2026-10-23", at)).baseline).toMatchObject({ n: 5, mean: 420 });
  });
  it("nulls every column on dates after today, even sleep", async () => {
    for (const metric of ["sleep_min", "steps", "rhr", "ln_rmssd"])
      expect((await trend(metric, "2026-10-24", "2026-10-24", now)).baseline.n, metric).toBe(0);
  });
  it.each([
    ...["hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev", "sleep_min", "sleep_eff", "deep_min", "rem_min", "sleep_latency_min",
      "z_ln_rmssd", "z_sleep", "bedtime_local", "waketime_local"].map(c => [c, true] as const),
    ...["steps", "azm", "rhr", "readiness_proxy", "cigarettes", "alcohol_g", "caffeine_mg"].map(c => [c, false] as const),
  ])("on today's date %s is kept: %s", async (column, kept) => {
    // 2026-10-22 completed, 2026-10-23 today, 2026-10-24 future
    const results = [["2026-10-22", 1], ["2026-10-23", 2], ["2026-10-24", 3]].map(([local_date, value]) =>
      ({ local_date, [column]: value, active_logging: 1, [`first_bday_${column}`]: "2026-10-01" }));
    const read = vi.spyOn(env.DB, "prepare").mockImplementation(() =>
      ({ bind: () => ({ all: () => Promise.resolve({ results }) }) }) as unknown as D1PreparedStatement);
    try {
      const { series: [s] } = await analysisSeries(env.DB, "2026-10-22", "2026-10-23", 1, [column], { nowSec: now, tz });
      expect(s).toEqual([1, kept ? 2 : null, null]);
    } finally { read.mockRestore(); }
  });
  it("correlate and compare count only completed days", async () => {
    const r = await healthCorrelate(env.DB, { x: "steps", y: "rhr", start: "2026-10-13", end: "2026-10-23", max_lag: 0 }, { nowSec: now, tz });
    expect(r.lags[0].n).toBe(9); // 10 completed days, minus the first one lost to prewhitening
    const c = await healthCompare(env.DB, { behavior: "caffeine_mg", outcome: "steps", start: "2026-10-13", end: "2026-10-23", lag_days: 0 }, { nowSec: now, tz });
    expect(c.n).toBe(10);
  });
});

it("a historical recheck the next morning keeps the save-time cutoff", async () => {
  const morning = Date.parse("2026-10-24T04:00:00Z") / 1000; // 06:00 Madrid: 2026-10-23 is now complete
  const evaluator = createEvaluator(env.DB, { nowSec: now, tz });
  const origin = evaluator.validateOrigin({ tool: "health_contrast", args: { ...span, ...caffeine, metrics: ["steps"], timing: "next_day" } });
  const ref = (await evaluator.family(origin, {})).rows[0].ref;
  const saved = (await healthFindings(env.DB, { action: "save", statement: "caffeine steps", ref }, { nowMs: now * 1000, evaluator })).finding as { id: number };
  await env.DB.prepare("UPDATE daily_summary SET steps = 12000 WHERE local_date = '2026-10-23'").run();
  const result = await healthFindings(env.DB, { action: "recheck", id: saved.id }, { nowMs: morning * 1000, evaluator: createEvaluator(env.DB, { nowSec: morning, tz }) });
  expect(result).toMatchObject({ verdict: "reproduced" });
  expect(result.diff_new).toBe(result.diff_saved);
  const row = await env.DB.prepare("SELECT result FROM finding_check WHERE finding_id = ?").bind(saved.id).first<{ result: string }>();
  expect(JSON.parse(row?.result ?? "null") as FamilyRow).toMatchObject({ n_a: 4, n_b: 5 });
});
