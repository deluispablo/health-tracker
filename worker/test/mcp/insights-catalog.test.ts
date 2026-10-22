import type { ExposureMetric, MetricId, MetricTiming } from "../../src/mcp/tools/insights/types";
import { describe, expect, it } from "vitest";
import { BEFORE_BED_HOURS, BEHAVIOR_OUTCOMES, METRICS, MOODS, NIGHT_ANCHORED, NIGHT_METRICS, PHRASES, PLANNED, SCAN_PAIRS, behaviorExcluded, refusedMetricPair } from "../../src/mcp/tools/insights/catalog";

describe("insight catalogue", () => {
  it("has exactly 253 allowed scan pairs with the specified timing counts", () => {
    expect(SCAN_PAIRS).toHaveLength(253);
    expect(Object.keys(BEHAVIOR_OUTCOMES).map(t => SCAN_PAIRS.filter(p => p.timing === t).length)).toEqual([117, 80, 35, 21]);
    expect(SCAN_PAIRS.every(p => !behaviorExcluded(p.behavior, p.metric))).toBe(true);
    expect(new Set(SCAN_PAIRS.map(p => JSON.stringify(p))).size).toBe(253);
  });
  it("excludes every self comparison", () => {
    for (const m of NIGHT_METRICS) expect(behaviorExcluded("short_sleep", m)).toBe(true);
    expect(behaviorExcluded("steps", "steps")).toBe(true);
    expect(behaviorExcluded("workout", "workout_min")).toBe(true);
    for (const m of ["mood_negative", "mood_positive", ...MOODS.negative] as const) expect(behaviorExcluded("mood_negative", m)).toBe(true);
    for (const m of ["mood_tired", "mood_cansado"] as const) expect(behaviorExcluded("mood_tired", m)).toBe(true);
  });
  it("refuses coupled, persistent, backward and unsupported pairs", () => {
    const coupled: [ExposureMetric, MetricId[]][] = [
      ["hrv", ["rhr"]],
      ["bedtime", ["sleep_min", "deep_min", "rem_min", "light_min", "efficiency", "awake_min", "latency_min"]],
      ["steps", ["workout_min"]], ["workout_min", ["steps"]],
      ["sleep_min", ["deep_min", "rem_min", "light_min", "awake_min", "deep_pct", "rem_pct"]],
    ];
    for (const timing of ["after_waking", "next_night", "following_night", "that_night"] as const satisfies readonly MetricTiming[]) {
      for (const exposure of ["bedtime", "sleep_min", "hrv", "steps", "workout_min"] as const)
        expect(refusedMetricPair(exposure,timing,exposure)).toMatch(/persistence/);
      for (const [exposure,outcomes] of coupled)
        for (const outcome of outcomes)
          expect(refusedMetricPair(exposure,timing,outcome)).toMatch(/signal|arithmetic|coupled/);
    }
    expect(refusedMetricPair("hrv","that_night","sleep_min")).toMatch(/outside/);
    expect(refusedMetricPair("bedtime","after_waking","rhr")).toMatch(/outside/);
  });
  it("pins M1 through M8 and allows every planned pair", () => {
    expect(PLANNED.map(p => [p.id, p.exposure, p.side, p.timing, p.outcome, p.expected])).toEqual([
      ["M1", "bedtime", "high", "that_night", "rhr", "+"],
      ["M2", "bedtime", "high", "that_night", "deep_pct", "none"],
      ["M3", "sleep_min", "low", "after_waking", "steps", "+"],
      ["M4", "sleep_min", "low", "after_waking", "mood_tired", "+"],
      ["M5", "steps", "high", "following_night", "sleep_min", "0"],
      ["M6", "workout_min", "high", "following_night", "hrv", "none"],
      ["M7", "hrv", "low", "next_night", "sleep_min", "none"],
      ["M8", "sleep_min", "low", "next_night", "hrv", "-"],
    ]);
    for (const p of PLANNED) expect(refusedMetricPair(p.exposure, p.timing, p.outcome)).toBeNull();
    expect(NIGHT_ANCHORED).toContain("hrv");
    expect(NIGHT_ANCHORED).not.toContain("rhr");
  });
  it("pins every ROPE and before-bed window", () => {
    expect(Object.fromEntries(Object.entries(METRICS).map(([k,v]) => [k,v.rope]))).toEqual({
      sleep_min:15, deep_min:5, rem_min:5, light_min:5, awake_min:5, deep_pct:2, rem_pct:2,
      efficiency:2, latency_min:5, awakenings:1, bedtime:15, rhr:1, hrv:0.05, spo2_avg:0.5,
      skin_temp_dev:0.2, resp_rate:0.5, steps:1000, workout_min:10, mood_positive:0.15,
      mood_negative:0.15, mood_tired:0.15, ...Object.fromEntries(Object.values(MOODS).flat().map(m => [m,0.15])), hr_delta:2,
    });
    expect(BEFORE_BED_HOURS).toEqual({cigarettes:2,caffeine:6,alcohol:3,mood_negative:4,workout:3});
  });
  it("preserves the required phrases verbatim", () => {
    expect(PHRASES).toEqual({
      sólido:"va asociado a … y se ha confirmado con datos nuevos (n)",
      probable:"parece que … ; aún no comprobado con datos nuevos",
      indicio:"hay un indicio … ; puede ser casualidad; faltan …",
      sin_diferencia:"por ahora no se ve diferencia clara",
      sin_datos:"aún no hay datos: faltan …",
      cambio:"desde el … tu … ha cambiado …; es un candidato, falta comprobarlo",
    });
  });
});
