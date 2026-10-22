import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_MAX_CHARS, CONTEXT_TEXT, healthContext } from "../../src/mcp/tools/insights/context";
import { createEvaluator } from "../../src/mcp/tools/insights/evaluator";
import { METRICS, PHRASES } from "../../src/mcp/tools/insights/catalog";
import { publicRow } from "../../src/mcp/tools/insights/compare";
import { healthFindings } from "../../src/mcp/tools/insights/findings";
import { healthScan } from "../../src/mcp/tools/insights/scan";
import { healthContrast } from "../../src/mcp/tools/insights/contrast";
import { healthPeriods } from "../../src/mcp/tools/insights/periods";
import type { FamilyRow, Origin, StoredRef } from "../../src/mcp/tools/insights/types";
import { FIXTURE, seedInsightsFixture } from "../fixtures/insights";

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value");
  return value;
}
let ctx: ExecutionContext;
beforeEach(() => { ctx = createExecutionContext(); });
afterEach(async () => { await waitOnExecutionContext(ctx); });
const deps = { nowSec: FIXTURE.now, tz: FIXTURE.tz };
const scan: Origin = { tool: "health_scan", args: { window_days: 120, behaviors: ["workout"], metrics: ["sleep_min"], timings: ["following_night"] } };
const evaluator = () => createEvaluator(env.DB, deps);
const findings = (args: Parameters<typeof healthFindings>[1], nowSec = deps.nowSec) => healthFindings(env.DB, args,
  { nowMs: nowSec * 1000, evaluator: createEvaluator(env.DB, { ...deps, nowSec }) });
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

it("keeps context within 9000 characters with every phrase, metric and prohibition", () => {
  expect(CONTEXT_MAX_CHARS).toBe(9000);
  expect(CONTEXT_TEXT.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  for (const phrase of Object.values(PHRASES)) expect(CONTEXT_TEXT).toContain(phrase);
  for (const metric of Object.keys(METRICS)) expect(CONTEXT_TEXT).toContain(metric);
  const prohibition = CONTEXT_TEXT.split("\n").find(line => line.startsWith("Never say"));
  for (const word of ["causa", "causes", "sin efecto", "no effect"]) {
    expect(CONTEXT_TEXT.match(new RegExp(`\\b${word}\\b`, "g"))).toHaveLength(1);
    expect(prohibition).toContain(word);
  }
  expect(CONTEXT_TEXT).toContain("computed from the night that ends on that date");
  expect(CONTEXT_TEXT).toContain("Filter health_scan by metrics/timings");
  expect(CONTEXT_TEXT).toContain("hr_delta covers only the last 28 days ending at end");
  expect(CONTEXT_TEXT).not.toContain("unspecified");
  expect(CONTEXT_TEXT).toContain("M7");
});
it("every tool response carries the shared envelope fields", async () => {
  const results = [healthContext(), await healthScan(env.DB, {}, deps, ctx), await healthPeriods(env.DB, {}, deps, ctx),
    await healthContrast(env.DB, { a: {}, b: {}, metrics: ["rhr"] }, deps, ctx)];
  for (const result of results) {
    expect(result).toHaveProperty("range");
    expect(result).toHaveProperty("tests_last_24h");
    expect(result).toMatchObject({ excluded: expect.any(Object) as unknown, truncated: expect.any(Boolean) as unknown, tests: expect.any(Number) as unknown });
  }
  expect(healthContext()).toEqual({ text: CONTEXT_TEXT, range: null, excluded: {}, truncated: false, tests: 0, tests_last_24h: null });
});
it.each([
  null, { tool: "health_sql", args: {} }, { tool: "health_scan", args: { window_days: 10, start: FIXTURE.start } },
  { tool: "health_scan", args: { window_days: 181 } }, { tool: "health_scan", args: { window_days: 10, limit: 2 } },
  { tool: "health_scan", args: {}, mode: "prospective" },
])("rejects an invalid origin %j", input => { expect(() => evaluator().validateOrigin(input)).toThrow(RangeError); });
it("newDataRange is clamped to 180 days and respects local 05:00 across DST", () => {
  expect(evaluator().newDataRange((deps.nowSec - 200 * 86400) * 1000)).toEqual({ start: FIXTURE.start, end: FIXTURE.end });
  expect(evaluator().newDataRange(deps.nowSec * 1000)).toBeNull();
  const e = createEvaluator(env.DB, { ...deps, nowSec: Date.parse("2026-10-27T08:00Z") / 1000 });
  expect(e.newDataRange(Date.parse("2026-10-25T03:30Z"))).toEqual({ start: "2026-10-25", end: "2026-10-26" });
});

describe("real findings evaluator", () => {
  beforeAll(async () => { await seedInsightsFixture(env.DB, { extendDays: 60 }); });
  it("family reproduces public rows without writing analysis_log", async () => {
    const e = evaluator();
    const origin = e.validateOrigin(scan);
    const count = () => env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_log").first("n");
    const before = await count();
    const family = await e.family(origin, {});
    expect(await count()).toBe(before);
    const result = await healthScan(env.DB, { behaviors: ["workout"], metrics: ["sleep_min"], timings: ["following_night"] }, deps, ctx);
    expect(result.rows).toEqual(family.rows.map(publicRow));
  });
  it("replays a relative origin three days later with the same length and key", async () => {
    const original = await evaluator().family(scan, {});
    const saved = await findings({ action: "save", statement: "Relative pattern", ref: original.rows[0].ref });
    const finding = saved.finding as { ref: StoredRef };
    const later = await createEvaluator(env.DB, { ...deps, nowSec: deps.nowSec + 3 * 86400 }).family(finding.ref.origin, {});
    expect(later.resolved).toEqual({ start: "2026-06-06", end: "2026-10-03" });
    expect(later.rows[0].ref?.key).toEqual(original.rows[0].ref?.key);
  });
  it("save then recheck uses prospective scan and historical dated contrast and periods", async () => {
    const origins: Origin[] = [scan,
      { tool: "health_contrast", args: { start: FIXTURE.start, end: FIXTURE.end, a: { weekdays: [1, 2, 3] }, b: { weekdays: [4, 5, 6, 7] }, timing: "following_night", metrics: ["rhr"] } },
      { tool: "health_periods", args: { window_days: 120, behaviors: ["cigarettes"], metrics: ["rhr"] } }];
    for (const origin of origins) {
      const row = (await evaluator().family(origin, {})).rows[0];
      expect(row.ref).not.toBeNull();
      const saved = await findings({ action: "save", statement: "Observed pattern", ref: row.ref });
      const finding = saved.finding as { id: number; ref: StoredRef };
      expect(finding.ref.mode).toBe(origin.tool === "health_scan" ? "prospective" : "historical");
      const recheck = await findings({ action: "recheck", id: finding.id }, deps.nowSec + 3 * 86400);
      expect(recheck.verdict).toBe(origin.tool === "health_scan" ? "not_enough_data" : "reproduced");
      for (const extra of [{ mode: "prospective" }, { resolved: { start: FIXTURE.start, end: FIXTURE.end } }]) {
        await expect(findings({ action: "save", statement: "Invalid", ref: { ...row.ref, ...extra } })).rejects.toThrow(RangeError);
      }
    }
  });
  it("prospective recheck evaluates only the saved row with q equal to p and confirms on new data", async () => {
    const family = await evaluator().family(scan, {}), row = family.rows[0];
    expect(row.label).toBe("probable");
    const saved = await findings({ action: "save", statement: "Workout and sleep", ref: row.ref });
    const finding = saved.finding as { id: number; ref: StoredRef };
    const nowSec = deps.nowSec + 60 * 86400, e = createEvaluator(env.DB, { ...deps, nowSec });
    const fresh = await e.single(finding.ref, present(e.newDataRange(deps.nowSec * 1000)));
    expect(fresh?.q).toBe(fresh?.p);
    expect(fresh?.ref?.key).toEqual(row.ref?.key);
    const result = await findings({ action: "recheck", id: finding.id }, nowSec);
    expect(result.verdict).toBe("confirmed");
    expect((saved.finding as { result: FamilyRow }).result.label).toBe("probable");
    expect((result.finding as { result: FamilyRow }).result.label).toBe("sólido");
  });
  it("recheck ignores events back-dated before saved_at", async () => {
    const origin: Origin = { tool: "health_scan", args: { window_days: 120, behaviors: ["cigarettes"], metrics: ["rhr"], timings: ["following_night"] } };
    const row = (await evaluator().family(origin, {})).rows[0];
    const saved = await findings({ action: "save", statement: "Pattern", ref: row.ref });
    const id = (saved.finding as { id: number }).id;
    const nowSec = deps.nowSec + 60 * 86400;
    const retained = async () => {
      const result = await env.DB.prepare("SELECT result FROM finding_check WHERE finding_id = ? ORDER BY checked_at DESC LIMIT 1").bind(id).first<string>("result");
      return JSON.parse(present(result)) as FamilyRow;
    };
    const before = await findings({ action: "recheck", id }, nowSec);
    const beforeRow = await retained();
    expect(beforeRow.n_a).toBeGreaterThanOrEqual(3);
    expect(beforeRow.n_b).toBeGreaterThanOrEqual(3);
    for (const statistic of [beforeRow.mean_a, beforeRow.mean_b, beforeRow.diff, beforeRow.p, beforeRow.q]) expect(statistic).toEqual(expect.any(Number));
    expect(beforeRow.ci95).toEqual([expect.any(Number), expect.any(Number)]);
    await env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES ('backdated','cigarettes',?,120,'2026-09-29',1,'import',?)")
      .bind(Date.parse("2026-09-29T10:00Z") / 1000, nowSec * 1000).run();
    const after = await findings({ action: "recheck", id }, nowSec + 1);
    expect(await retained()).toEqual(beforeRow);
    expect(after.diff_new).toEqual(before.diff_new);
    expect(after.verdict).toEqual(before.verdict);
    expect(evaluator().newDataRange(deps.nowSec * 1000)).toBeNull();
  });
  it("reuses frozen tertile cutpoints on recheck", async () => {
    const origin: Origin = { tool: "health_scan", args: { window_days: 120, behaviors: ["steps"], metrics: ["rhr"], timings: ["following_night"] } };
    const family = await evaluator().family(origin, {}), ref = present(family.rows[0].ref);
    const saved = await findings({ action: "save", statement: "Steps pattern", ref });
    const id = (saved.finding as { id: number }).id;
    await findings({ action: "recheck", id }, deps.nowSec + 60 * 86400);
    const result = await env.DB.prepare("SELECT result FROM finding_check WHERE finding_id = ? ORDER BY checked_at DESC LIMIT 1").bind(id).first<string>("result");
    const fresh = JSON.parse(present(result)) as FamilyRow;
    expect(fresh.ref?.cutpoints).toEqual(ref.cutpoints);
  });
});
