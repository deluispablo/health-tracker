import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { anomalyFlags, computeBaselines, type Baseline } from "../../src/mcp/tools/insights/baseline";
import { CALIBRATION_CAPS, refusedMetricPair } from "../../src/mcp/tools/insights/catalog";
import { evaluateMetricPair, finalizeMetricLabel } from "../../src/mcp/tools/insights/metric";
import { loadDayTable, resolveRange, type DayTable } from "../../src/mcp/tools/insights/units";
import { FIXTURE, seedInsightsFixture } from "../fixtures/insights";
import type { MetricId, MetricPair, MetricStats } from "../../src/mcp/tools/insights/types";

const pair: MetricPair = { exposure: "bedtime", side: "high", timing: "that_night", outcome: "hrv" };
function fixture(n = 60) {
  const length = n + 44;
  const t = {
    dates: Array.from({ length }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10)),
    start: 43, end: 42 + n, weekend: Array.from({ length }, (_, i) => i % 7 >= 5),
    metric: { bedtime: [], sleep_min: [], hrv: [], mood_tired: [] },
    behavior: { alcohol: Array<number>(length).fill(0) },
  } as unknown as DayTable;
  const bl: Partial<Record<MetricId, Baseline>> = {};
  for (const m of ["bedtime", "sleep_min", "hrv"] as const) {
    t.metric[m] = Array.from({ length }, (_, i) => m === "bedtime" ? i % 2 ? 60 : -60 : m === "sleep_min" ? 400 : Math.log(45) + (i % 2 ? Math.log(0.88) : 0));
    bl[m] = { median: Array<number>(length).fill(m === "hrv" ? Math.log(45) : m === "sleep_min" ? 400 : 0), scale: Array<number>(length).fill(1), z: t.metric[m].map((_, i) => i % 2 ? 1 : -1) };
  }
  // Vary the baseline deviations independently of the exposure groups.
  for (let i = 0; i < length; i++) present(bl.hrv).median[i] = present(t.metric.hrv[i]) - (i % 3);
  t.metric.mood_tired = Array.from({ length }, (_, i) => i % 2);
  t.metric.rhr = [...t.metric.hrv];
  bl.rhr = bl.hrv;
  return { t, bl, anomalies: Array<boolean>(length).fill(false) };
}
function evaluate(f = fixture(), p = pair) {
  return evaluateMetricPair(f.t, f.bl, f.anomalies, p, { includeAnomalies: false });
}
function probable(): MetricStats {
  return { ...evaluate(), n_a: 20, n_b: 20, diff: 2, ci95: [1, 3], p: 0.001, reason: null,
    sensitivity: { alcohol: { status: "robust", diff: 2, n_a: 20, n_b: 20 } } };
}
it("hrv adjusted ln diff converts to minus 12 percent", () => {
  const f = fixture();
  present(f.bl.hrv).median = Array<number>(f.t.dates.length).fill(Math.log(45));
  present(f.bl.bedtime).z = f.t.dates.map((_, i) => Math.sin(i * 12.9898) > 0 ? 1 : -1);
  f.t.metric.hrv = present(f.bl.bedtime).z.map((z, i) => Math.log(45) + (present(z) > 0 ? Math.log(0.88) : 0) + Math.sin(i * 1.7) * 0.00001);
  const s = evaluate(f);
  expect(100 * Math.expm1(present(s.diff))).toBeCloseTo(-12, 1);
});
it("previous-day outcome on the first displayed day uses a full baseline (224 rows)", () => {
  const f = fixture(180);
  const bl = computeBaselines(f.t);
  const s = evaluateMetricPair(f.t, bl, f.anomalies, pair, { includeAnomalies: true });
  expect(f.t.dates).toHaveLength(224);
  expect(present(bl.hrv).median[42]).not.toBeNull();
  expect([...s.groupIdx.a, ...s.groupIdx.b]).toContain(43);
});
it("middle-band, incomplete pairs and anomalies are dropped and counted", () => {
  const f = fixture();
  present(f.bl.bedtime).z[43] = 0;
  f.t.metric.hrv[45] = null;
  f.anomalies[49] = true;
  const s = evaluate(f);
  expect(s.excluded).toEqual({ middle_band: 1, incomplete_pair: 2, anomaly: 1 });
  expect(s.n_a + s.n_b).toBe(56);
});
it("filter groups use raw exposure without requiring exposure z and drop overlaps", () => {
  const f = fixture();
  delete f.bl.bedtime;
  const s = evaluateMetricPair(f.t, f.bl, f.anomalies, { ...pair, side: "filter" }, {
    includeAnomalies: true, groups: { a: i => i % 2 === 1 || i === 44, b: i => i % 2 === 0 },
  });
  expect(s.n_a + s.n_b).toBe(59);
  expect(s.excluded.both_groups).toBe(1);
});
it("29 vs 30 retained pairs gates probable only", () => {
  expect(finalizeMetricLabel({ ...probable(), n_a: 14, n_b: 15 }, 0.001, 1, null)).toMatchObject({ label: "indicio", reason: "few_days", needed: "faltan 1 pares de días" });
  expect(finalizeMetricLabel({ ...probable(), n_a: 15, n_b: 15 }, 0.001, 1, null).label).toBe("probable");
});
it("alcohol leg drops unknown, partial first and inactive bdays using both anchors", () => {
  const f = fixture();
  for (const i of [43, 47, 51]) f.t.behavior.alcohol[i] = null;
  f.t.behavior.alcohol[55] = 20;
  const s = evaluate(f, { ...pair, outcome: "rhr" });
  expect(s.sensitivity.alcohol.n_a + s.sensitivity.alcohol.n_b).toBe(52);
});
it("alcohol leg unavailable before alcohol tracking", () => {
  const f = fixture(); f.t.behavior.alcohol.fill(null);
  expect(evaluate(f).sensitivity.alcohol).toMatchObject({ status: "unavailable", n_a: 0, n_b: 0 });
});
it("alcohol leg unavailable when rank-deficient", () => {
  const f = fixture(120);
  f.t.behavior.alcohol = f.t.weekend.map((_, i) => f.t.weekend[i + 1] === ((i + 1) % 2 === 1) ? 0 : 1);
  present(f.bl.bedtime).z = f.t.dates.map((_, i) => i % 2 ? -1 : 1);
  expect(evaluate(f).sensitivity.alcohol.status).toBe("unavailable");
});
it.each([-2, -0.01])("alcohol leg not_robust on opposite or small negative diff %s", effect => {
  const f = fixture(120);
  for (let i = 0; i < f.t.dates.length; i++) {
    const sober = i % 8 < 4;
    f.t.behavior.alcohol[i] = sober ? 0 : 20;
    f.t.metric.hrv[i + 1] = ((i % 2) * (sober ? effect : 10)) + Math.sin(i * 1.7) * 0.00001;
  }
  present(f.bl.hrv).median.fill(0);
  f.t.metric.steps = f.t.dates.map((_, i) => i % 2 ? 9000 : 3000);
  f.bl.steps = f.bl.bedtime;
  const s = evaluate(f, { exposure: "steps", side: "high", timing: "following_night", outcome: "hrv" });
  expect(s.sensitivity.alcohol.status).toBe("not_robust");
});
it("weekday leg on M4 uses presence without outcome baselines", () => {
  const f = fixture();
  const s = evaluate(f, { exposure: "sleep_min", side: "low", timing: "after_waking", outcome: "mood_tired" });
  expect(s.binary).toBe(true);
  expect(s.adjusted_for).toEqual([]);
  expect(present(s.sensitivity.weekdays).n_a + present(s.sensitivity.weekdays).n_b).toBe(f.t.weekend.slice(43, 103).filter(w => !w).length);
});
it("confounded reason survives finalization", () => {
  expect(finalizeMetricLabel({ ...probable(), diff: null, ci95: null, reason: "confounded" }, null, 1, "+")).toMatchObject({ label: "indicio", reason: "confounded", matches_expected: false });
});
it.each([ ["+", true], ["-", false], ["0", false], ["none", null] ] as const)("matches_expected for %s", (expected, matches) => {
  expect(finalizeMetricLabel(probable(), 0.001, 1, expected).matches_expected).toBe(matches);
});
it("zero expectation matches only sin_diferencia", () => {
  expect(finalizeMetricLabel({ ...probable(), diff: 0, ci95: [-0.1, 0.1] }, 1, 1, "0").matches_expected).toBe(true);
});
it.each(["metricContinuous", "binary", "metricBinary"] as const)("%s cap downgrades probable", cap => {
  const s = { ...probable(), binary: cap !== "metricContinuous" };
  expect(finalizeMetricLabel(s, 0.001, 1, null, { ...CALIBRATION_CAPS, [cap]: true })).toMatchObject({ label: "indicio", reason: "uncertain" });
});
it("not_robust legs cap probable while unavailable legs do not", () => {
  const s = probable(); s.sensitivity.alcohol.status = "not_robust";
  expect(finalizeMetricLabel(s, 0.001, 1, null).reason).toBe("not_robust");
  s.sensitivity.alcohol.status = "unavailable";
  expect(finalizeMetricLabel(s, 0.001, 1, null).label).toBe("probable");
});
it("missing previous binary value and missing that-night sleep baseline drop pairs", () => {
  const f = fixture(); f.t.metric.mood_tired[44] = null;
  expect(evaluate(f, { exposure: "sleep_min", side: "low", timing: "after_waking", outcome: "mood_tired" }).excluded.incomplete_pair).toBe(2);
  present(f.bl.sleep_min).median[50] = null;
  expect(evaluate(f).excluded.incomplete_pair).toBe(1);
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS analysis_log (ts INTEGER NOT NULL, tool TEXT NOT NULL, tests INTEGER NOT NULL)").run();
});
it.each(["main", "common_cause"] as const)("fixture %s preserves adjusted estimates and alcohol eligibility", async variant => {
  await env.DB.batch(["sleep_stage", "sleep_session", "event", "daily_summary", "workout", "metric_minute"].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  await seedInsightsFixture(env.DB, { variant });
  const t = await loadDayTable(env.DB, resolveRange({ start: FIXTURE.start, end: FIXTURE.end }, FIXTURE.now, FIXTURE.tz), FIXTURE.now, FIXTURE.tz);
  const bl = computeBaselines(t);
  const s = evaluateMetricPair(t, bl, anomalyFlags(bl, t.dates.length), { exposure: "bedtime", side: "high", timing: "that_night", outcome: "rhr" }, { includeAnomalies: false });
  if (variant === "main") {
    expect(Math.abs(present(s.diff) - FIXTURE.planted.bedtimeRhr)).toBeLessThanOrEqual(FIXTURE.planted.bedtimeRhr * 0.25);
    expect(finalizeMetricLabel(s, s.p, 1, "+").label).toBe("probable");
  } else {
    expect(s.sensitivity.alcohol.status).toBe("not_robust");
    expect(Math.min(s.sensitivity.alcohol.n_a, s.sensitivity.alcohol.n_b)).toBeGreaterThanOrEqual(8);
    expect(finalizeMetricLabel(s, s.p, 1, "+")).toMatchObject({ label: "indicio", reason: "not_robust" });
  }
});

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a populated value.");
  return value;
}
it("empty or fewer than three retained pairs have null statistics", () => {
  for (const n of [0, 4]) {
    const s = evaluate(fixture(n));
    expect(s).toMatchObject({ diff: null, ci95: null, p: null, mean_a: null, mean_b: null });
    expect(finalizeMetricLabel(s, null, 0.05, null).label).toBe("sin_datos");
  }
});
it("next-night pairs use the next calendar outcome and its own previous date", () => {
  const f = fixture();
  f.t.metric.hrv[43] = null;
  const s = evaluate(f, { exposure: "sleep_min", side: "high", timing: "next_night", outcome: "hrv" });
  expect(s.excluded.incomplete_pair).toBe(1);
  expect([...s.groupIdx.a, ...s.groupIdx.b]).not.toContain(43);
  expect([...s.groupIdx.a, ...s.groupIdx.b]).toContain(44);
  expect([...s.groupIdx.a, ...s.groupIdx.b]).toContain(f.t.end);
});
it("anomaly exclusion checks both anchors and can be disabled", () => {
  const f = fixture(); f.anomalies[44] = true;
  const p: MetricPair = { exposure: "sleep_min", side: "high", timing: "next_night", outcome: "hrv" };
  expect(evaluate(f, p).excluded.anomaly).toBe(2);
  expect(evaluateMetricPair(f.t, f.bl, f.anomalies, p, { includeAnomalies: true }).n_a
    + evaluateMetricPair(f.t, f.bl, f.anomalies, p, { includeAnomalies: true }).n_b).toBe(60);
});
it("sensitivity and calibration caps preserve sin_diferencia", () => {
  const s = { ...probable(), diff: 0, ci95: [-0.1, 0.1] as [number, number] };
  s.sensitivity.alcohol.status = "not_robust";
  expect(finalizeMetricLabel(s, 1, 1, "0", { ...CALIBRATION_CAPS, metricContinuous: true }).label).toBe("sin_diferencia");
});
it("effective-day guidance includes the missing effective count and unit", () => {
  const s = { ...probable(), ci95: null, p: null, n_eff_a: 1, n_eff_b: 1, adjusted_for: ["previous_value", "weekend"] };
  expect(finalizeMetricLabel(s, null, 1, null)).toMatchObject({
    reason: "few_effective_days", needed: "más días repartidos en el tiempo (faltan 4 días efectivos)",
  });
});
it.each<MetricPair>([
  { exposure: "bedtime", side: "high", timing: "next_night", outcome: "bedtime" },
  { exposure: "hrv", side: "low", timing: "next_night", outcome: "rhr" },
  { exposure: "bedtime", side: "high", timing: "next_night", outcome: "sleep_min" },
  { exposure: "steps", side: "high", timing: "after_waking", outcome: "workout_min" },
  { exposure: "sleep_min", side: "low", timing: "next_night", outcome: "deep_pct" },
  { exposure: "bedtime", side: "high", timing: "that_night", outcome: "steps" },
  { exposure: "bedtime", side: "high", timing: "that_night", outcome: "hr_delta" },
])("rejects unsupported metric pair $exposure/$timing/$outcome", p => {
  const message = present(refusedMetricPair(p.exposure, p.timing, p.outcome));
  expect(() => evaluate(fixture(), p)).toThrow(RangeError);
  expect(() => evaluate(fixture(), p)).toThrow(message);
});
