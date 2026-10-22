import { expect, it, vi } from "vitest";
import type { AcuteInput, WindowAgg } from "../../src/mcp/tools/insights/event";
import type { Origin } from "../../src/mcp/tools/insights/types";

it("scan JS path takes at most 20 ms cold and 8 ms warm in a fresh module", async () => {
  vi.resetModules();
  const { computeScan } = await import("../../src/mcp/tools/insights/scan");
  const { shapeDayTable } = await import("../../src/mcp/tools/insights/units");
  const { acuteDays } = await import("../../src/mcp/tools/insights/event");
  const { rankRows, publicRow, shapeResponse } = await import("../../src/mcp/tools/insights/compare");
  const { METRICS, MOODS, BEFORE_BED_HOURS } = await import("../../src/mcp/tools/insights/catalog");
  const first = Date.parse("2026-01-01T00:00:00Z") / 1000;
  const dates = Array.from({ length: 224 }, (_, i) => new Date((first + i * 86400) * 1000).toISOString().slice(0, 10));
  const range = { start: dates[43], end: dates[222], fetchStart: dates[0], fetchEnd: dates[223], window_days: 180 };
  const opts = { nowSec: first + 225 * 86400, tz: "UTC" };
  const origin: Extract<Origin, { tool: "health_scan" }> = { tool: "health_scan", args: { start: range.start, end: range.end } };
  const rows = dates.map((local_date, i) => {
    const row: Record<string, number | string | null> & { local_date: string } = { local_date, active: 1, previous_active: 1, hr_wear_min: 1440, window_mood_taps: 1, bed: first + i * 86400 + 23 * 3600 };
    Object.keys(METRICS).forEach((m, j) => { row[m] = METRICS[m as keyof typeof METRICS].binary ? i % 2 : 100.0123 + (i * 7919 + j * 139) % 101; });
    ["cigarettes", "caffeine", "alcohol", "mood", "water", "melatonin", "protein", "creatine"].forEach((id, j) => {
      row[`first_${id}_ts`] = first - 86400; row[`first_${id}_bday`] = "2025-12-31";
      row[id] = (i * 17 + j * 7) % 11 < 5 ? 1 : 0;
    });
    Object.values(MOODS).flat().forEach((id, j) => { row[id] = (i + j) % 3 === 0 ? 1 : 0; });
    Object.keys(BEFORE_BED_HOURS).forEach((id, j) => { row[`window_${id}`] = (i + j) % 2; });
    row.workout_late = i % 2; row.workout_early = 1 - i % 2;
    row.workout_min = i % 3 ? 0 : 30;
    row.sleep_min = 300 + (i * 7919 % 201); row.steps = 5000 + (i * 7919 % 7000);
    return row;
  });
  const taps: AcuteInput["taps"] = [];
  for (const [j, tracker] of (["cigarettes", "caffeine", "alcohol"] as const).entries()) {
    for (let i = 0; i < 40; i++) taps.push({ tracker, ts: first + (195 + i % 28) * 86400 + (3 + j * 6 + Math.floor(i / 28) * 3) * 3600 + 7, tz_offset_min: 0 });
  }
  const windows: AcuteInput["windows"] = new Map();
  const agg = (delta: number): WindowAgg => ({ tz_offset_min: 0, base_mean: 60, base_n: 15, resp: { cigarettes: { mean: 60 + delta, n: 15 }, caffeine: { mean: 60 + delta, n: 90 }, alcohol: { mean: 60 + delta, n: 60 } } });
  for (let d = 195; d <= 222; d++) for (let minute = 0; minute < 1440; minute += 30) windows.set(first + d * 86400 + minute * 60, agg(0));
  for (const tap of taps) windows.set(tap.ts, agg(8));
  const input: AcuteInput = { taps, windows, sleeps: [], workouts: [], nowSec: opts.nowSec };
  const times: number[] = [], phases: number[][] = [];
  for (let i = 0; i < 6; i++) {
    const a = performance.now();
    const t = shapeDayTable(rows, range);
    const b = performance.now();
    const acute = acuteDays(input, range);
    const c = performance.now();
    const family = computeScan(t, acute, origin, opts);
    const d = performance.now();
    const result = shapeResponse({ rows: rankRows(family.rows).slice(0, 10).map(publicRow), skipped: family.extra.skipped }, ["rows", "skipped"],
      { range: family.resolved, excluded: family.excluded, tests: family.tests, tests_last_24h: family.tests_last_24h + family.tests });
    result.truncated ||= family.rows.length > 10;
    const end = performance.now();
    times.push(end - a); phases.push([b - a, c - b, d - c, end - d]);
    expect(family.tests).toBe(376);
    expect(acute.map(a => a.events)).toEqual([40, 40, 40]);
    expect(acute.map(a => a.eventDays)).toEqual([28, 28, 28]);
    expect(result.rows).toHaveLength(10);
  }
  const warm = times.slice(1).sort((a, b) => a - b)[2];
  console.info(`scan JS ms: cold=${String(times[0])}, warm median=${String(warm)}; shaping/acute/scan/response=${JSON.stringify(phases)}`);
  expect(times[0]).toBeLessThanOrEqual(20);
  expect(warm).toBeLessThanOrEqual(8);
});
