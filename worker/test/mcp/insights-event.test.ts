import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dateTimeFormat } from "../../src/lib/time";
import { ACUTE, acuteDays, loadAcuteInput } from "../../src/mcp/tools/insights/event";
import { candidateTimes } from "../fixtures/insights";
import type { AcuteInput, WindowAgg } from "../../src/mcp/tools/insights/event";
import type { AcuteTracker } from "../../src/mcp/tools/insights/types";

const at = (iso: string) => Date.parse(iso) / 1000;
const day = at("2026-10-20T00:00:00Z");
const range = { start: "2026-10-20", end: "2026-10-20" };
const tap = (ts = day + 12 * 3600, tracker: AcuteTracker = "cigarettes", tz_offset_min = 0) => ({ ts, tracker, tz_offset_min });
function agg(delta = 0, offset: number | null = 0): WindowAgg {
  return { tz_offset_min: offset, base_mean: 60, base_n: 15,
    resp: { cigarettes: { mean: 60 + delta, n: 15 }, caffeine: { mean: 60 + delta, n: 90 }, alcohol: { mean: 60 + delta, n: 60 } } };
}
function input(taps = [tap()]): AcuteInput {
  const windows = new Map(candidateTimes(taps).map((ts) => [ts, agg(taps.some((t) => t.ts === ts) ? 8 : 0, taps[0]?.tz_offset_min ?? 0)]));
  return { taps, windows, sleeps: [], workouts: [], nowSec: day + 3 * 86400 };
}
const cigarettes = (i: AcuteInput, r = range) => acuteDays(i, r)[0];

describe("acute daily selection", () => {
  it("cigarette bump of 8 bpm gives d near 8", () => {
    expect(cigarettes(input())).toMatchObject({ dates: [range.start], d: [8], eventDays: 1, events: 1, controls: 8 });
    expect(acuteDays(input([]), range).every((r) => r.d.length === 0)).toBe(true);
  });
  it("coffee 10 minutes after a cigarette marks both as overlap", () => {
    const rows = acuteDays(input([tap(), tap(day + 12 * 3600 + 600, "caffeine")]), range);
    expect(rows.slice(0, 2).map((r) => r.excluded.overlap)).toEqual([1, 1]);
    expect(rows.slice(0, 2).map((r) => r.events)).toEqual([0, 0]);
  });
  it.each(["workouts", "sleeps"] as const)("excludes a cigarette inside %s including naps", (kind) => {
    const i = input(); i[kind] = [[tap().ts - 60, tap().ts + 60]];
    expect(cigarettes(i).excluded[kind === "sleeps" ? "sleep" : "workout"]).toBe(1);
  });
  it("70 percent coverage excludes", () => {
    const i = input(); const w = agg(8); w.resp.cigarettes.n = 10; i.windows.set(tap().ts, w);
    expect(cigarettes(i).excluded.coverage).toBe(1);
  });
  it("controls stay at least 60 minutes from every tap and on the 30-minute grid", () => {
    const i = input([tap(), tap(day + 18 * 3600, "alcohol")]);
    const grid = candidateTimes(i.taps).filter((ts) => i.taps.every((t) => Math.abs(ts - t.ts) >= 3600));
    for (const ts of grid) expect(ts % 1800).toBe(0);
    for (const [ts, w] of i.windows) if (!grid.includes(ts) && !i.taps.some((t) => t.ts === ts)) w.resp.cigarettes.mean = 1000;
    expect(cigarettes(i).d).toEqual([8]);
  });
  it("more than 8 valid controls keeps 8 evenly spaced", () => {
    const i = input();
    const valid = candidateTimes(i.taps).filter((ts) => Math.abs(ts - tap().ts) >= 3600);
    valid.forEach((ts, n) => { i.windows.set(ts, agg(n)); });
    const expected = Array.from({ length: 8 }, (_, n) => Math.round(n * (valid.length - 1) / 7));
    expect(cigarettes(i).d[0]).toBeCloseTo(8 - expected.reduce((a, b) => a + b, 0) / 8);
    expect(cigarettes(i).controls).toBe(8);
  });
  it("a day without a valid control is null and counted no_control", () => {
    const i = input(); i.windows = new Map([[tap().ts, agg(8)]]);
    expect(cigarettes(i)).toMatchObject({ d: [null], eventDays: 0, excluded: { no_control: 1 } });
  });
  it("drops wrong-offset controls with non-zero deltas across DST", () => {
    const taps = [tap(at("2026-10-25T09:00:00Z"), "cigarettes", 60)];
    const i = input(taps); i.nowSec = at("2026-10-27T00:00:00Z");
    for (const [ts, w] of i.windows) {
      w.tz_offset_min = ts < at("2026-10-25T01:00:00Z") ? 120 : 60;
      if (ts !== taps[0].ts) w.resp.cigarettes.mean = 60 + (w.tz_offset_min === 120 ? 20 : 4);
    }
    const row = cigarettes(i, { start: "2026-10-25", end: "2026-10-25" });
    expect(row).toMatchObject({ d: [4], controls: 8, excluded: { dst: 4 } });
    // Admitting the early controls changes both the selected controls and the daily mean.
    for (const w of i.windows.values()) w.tz_offset_min = 60;
    expect(cigarettes(i, { start: "2026-10-25", end: "2026-10-25" }).d).not.toEqual(row.d);
  });
  it("subtracts the pooled control mean on mixed-offset days with unequal control counts", () => {
    const taps = [tap(at("2026-10-24T23:00:00Z"), "cigarettes", 120), tap(at("2026-10-25T09:00:00Z"), "cigarettes", 60)];
    const i = input(taps); i.nowSec = at("2026-10-27T00:00:00Z");
    i.windows = new Map(taps.map((t) => [t.ts, agg(8, t.tz_offset_min)]));
    i.windows.set(at("2026-10-24T22:00:00Z"), agg(0, 120));
    for (const hour of [3, 4, 5, 6, 7, 11, 12]) i.windows.set(at("2026-10-25T00:00:00Z") + hour * 3600, agg(10, 60));
    const r = { start: "2026-10-25", end: "2026-10-25" };
    expect(cigarettes(i, r)).toMatchObject({ d: [-0.75], events: 2, controls: 8, excluded: { dst: 0 } });
    i.windows.delete(at("2026-10-24T22:00:00Z"));
    expect(cigarettes(i, r)).toMatchObject({ d: [null], eventDays: 0, excluded: { no_control: 1 } });
  });
  it("counts each unusable grid offset once and missing windows as coverage", () => {
    const i = input();
    i.windows.delete(day);
    i.windows.set(day + 1800, agg(20, null));
    i.windows.set(day + 3600, agg(20, 60));
    expect(cigarettes(i)).toMatchObject({ d: [8], excluded: { coverage: 1, dst: 2 } });
  });
  it("uses the full acute range even when the displayed range is one day", () => {
    const i = input([tap(day - 28 * 86400 + 12 * 3600), tap(day - 27 * 86400 + 12 * 3600), tap(day - 86400 + 12 * 3600)]);
    expect(cigarettes(i)).toMatchObject({ dates: ["2026-09-23", "2026-10-19"], d: [8, 8], events: 2 });
  });
  it("accepts exactly 80 percent coverage for baseline and response", () => {
    const i = input(); const w = agg(8); w.base_n = 12; w.resp.cigarettes.n = 12;
    i.windows.set(tap().ts, w);
    expect(cigarettes(i).d).toEqual([8]);
    w.base_n = 11;
    expect(cigarettes(i).excluded.coverage).toBe(1);
  });
  it("uses the delayed caffeine response and excludes taps during its gap", () => {
    const i = input([tap(day + 12 * 3600, "caffeine")]);
    const w = agg(4); w.resp.caffeine.n = 72; i.windows.set(i.taps[0].ts, w);
    expect(acuteDays(i, range)[1].d).toEqual([4]);
    i.taps.push(tap(day + 12 * 3600 + 1200));
    expect(acuteDays(i, range)[1].excluded.overlap).toBe(1);
  });
  it("builds sorted unique candidates from each day's first tap, including off-grid taps", () => {
    const taps = [tap(day + 13 * 3600 + 7), tap(day + 12 * 3600), tap(day + 86400 + 3600)];
    const times = candidateTimes(taps);
    expect(times).toHaveLength(97);
    expect(times[0]).toBe(day); expect(times.at(-1)).toBe(day + 86400 + 23.5 * 3600);
    expect(times).toContain(day + 13 * 3600 + 7);
    expect(candidateTimes([...taps].reverse())).toEqual(times);
  });
  it("matches main's grid ordering for same-second taps with unsorted offsets", () => {
    const taps = [tap(tap().ts, "caffeine", 120), tap(tap().ts, "alcohol", 60), tap(day + 18 * 3600, "cigarettes", 60)];
    const i = input(taps);
    for (const w of i.windows.values()) w.tz_offset_min = 60;
    const sorted = [...taps].sort((a, b) => a.ts - b.ts || a.tz_offset_min - b.tz_offset_min);
    const expected = acuteDays({ ...i, taps: sorted }, range);
    expect(expected[0]).toMatchObject({ d: [8], events: 1, controls: 8, excluded: { coverage: 0 } });
    expect(acuteDays(i, range)).toEqual(expected);
  });
  it("ignores windows ending at or after now", () => {
    const i = input(); i.nowSec = tap().ts + 900;
    expect(cigarettes(i).excluded.future).toBe(1);
  });
  it("uses only the 40 most recent taps per tracker in the last 28 days", () => {
    const taps = Array.from({ length: 45 }, (_, n) => tap(day - n * 4 * 3600));
    const r = cigarettes(input(taps), { start: "2026-09-01", end: range.end });
    expect(r.events).toBe(40);
    expect(r.dates[0]).toBe("2026-10-13");
    const old = input([tap(day - 28 * 86400)]);
    expect(cigarettes(old, { start: "2026-09-01", end: range.end }).events).toBe(0);
  });
  it("bounds tap lookups on a busy 28-day range while preserving daily results", () => {
    const taps = Array.from({ length: 28 }, (_, d) => Array.from({ length: 16 }, (_, n) =>
      tap(day - d * 86400 + (8 + n) * 3600 + 7, (["cigarettes", "caffeine", "alcohol"] as const)[n % 3]))).flat();
    const i = input(taps);
    let lookups = 0;
    i.taps = taps.map((t) => ({ ...t, get ts() { lookups++; return t.ts; } }));
    const rows = acuteDays(i, range);
    expect(rows[0].events).toBe(40);
    expect(rows[2].events).toBe(40);
    for (const row of rows) for (const d of row.d) expect(d).toBe(8);
    // Count work rather than wall time so this CPU regression is stable across machines.
    expect(lookups).toBeLessThan(50_000);
  });
  it("alcohol session start ignores later drinks within 2 hours", () => {
    const i = input([tap(day + 12 * 3600, "alcohol"), tap(day + 12 * 3600 + 1800, "alcohol")]);
    const row = acuteDays(i, range)[2];
    expect(row.events).toBe(1); expect(row.excluded.overlap).toBe(0); expect(row.d).toEqual([8]);
  });
  it("uses half-open overlap boundaries and the workout recovery buffer", () => {
    const i = input([tap(), tap(tap().ts + 900, "caffeine")]);
    expect(cigarettes(i).events).toBe(1);
    i.workouts = [[tap().ts + 900, tap().ts + 960]];
    expect(cigarettes(i).excluded.workout).toBe(1);
  });
});

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  for (const table of ["event", "metric_minute", "sleep_stage", "sleep_session", "workout"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
});
async function seedTap(ts: number, offset = 0, deleted = false) {
  await env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at, deleted_at)
    VALUES (?, 'cigarettes', ?, ?, ?, 1, 'mcp', 0, ?)`).bind(String(ts), ts, offset,
    new Date((ts + offset * 60) * 1000).toISOString().slice(0, 10), deleted ? 1 : null).run();
}
async function seedMinutes(start: number, count: number, bumpAt: number, dst = false) {
  for (let n = 0; n < count; n += 100) {
    await env.DB.batch(Array.from({ length: Math.min(100, count - n) }, (_, j) => {
      const ts = start + (n + j) * 60;
      return env.DB.prepare("INSERT INTO metric_minute (metric, ts, tz_offset_min, value) VALUES ('hr', ?, ?, ?)")
        .bind(ts, dst && ts < at("2026-10-25T01:00:00Z") ? 120 : dst ? 60 : 0, ts >= bumpAt && ts < bumpAt + 900 ? 68 : 60);
    }));
  }
}
const params = { ...range, nowSec: day + 2 * 86400, tz: "UTC" };
describe("acute D1 loading", () => {
  it("reuses the cached zone formatter across loads", async () => {
    dateTimeFormat("en-US", { timeZone: params.tz, timeZoneName: "longOffset" });
    const constructor = vi.spyOn(Intl, "DateTimeFormat");
    try {
      await loadAcuteInput(env.DB, params);
      await loadAcuteInput(env.DB, params);
      expect(constructor).not.toHaveBeenCalled();
    } finally {
      constructor.mockRestore();
    }
  });
  it("returns aggregates for exactly candidateTimes and an end-to-end 8 bpm bump", async () => {
    await seedTap(tap().ts); await seedTap(tap().ts + 60, 0, true);
    await seedMinutes(day - 900, 1590, tap().ts);
    const i = await loadAcuteInput(env.DB, params);
    expect(i.taps).toEqual([tap()]);
    expect([...i.windows.keys()].sort((a, b) => a - b)).toEqual(candidateTimes(i.taps));
    expect(i.windows.get(tap().ts)).toMatchObject({ base_mean: 60, base_n: 15, resp: { cigarettes: { mean: 68, n: 15 } } });
    expect(cigarettes(i).d).toEqual([8]);
  });
  it("loads the full acute range independently of the displayed start", async () => {
    const oldDay = day - 27 * 86400;
    const ts = oldDay + 12 * 3600;
    await seedTap(ts);
    await seedMinutes(oldDay - 900, 1590, ts);
    const i = await loadAcuteInput(env.DB, params);
    expect(i.taps).toEqual([tap(ts)]);
    expect(cigarettes(i)).toMatchObject({ dates: ["2026-09-23"], d: [8], events: 1 });
  });
  it("does not calculate zone offsets for recorded taps, including off-grid taps", async () => {
    const ts = tap().ts + 7;
    await seedTap(ts, 120);
    const offsets = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      const i = await loadAcuteInput(env.DB, params);
      expect(i.windows.get(ts)?.tz_offset_min).toBe(120);
      expect(offsets.mock.calls.some(([value]) => value === ts * 1000)).toBe(false);
    } finally {
      offsets.mockRestore();
    }
  });
  it("matches candidateTimes over several days and loads naps and workouts", async () => {
    await seedTap(day + 12 * 3600 + 7);
    await seedTap(day + 12 * 3600);
    await seedTap(day + 86400 + 3600);
    await env.DB.prepare(`INSERT INTO sleep_session
      (source_id, start_ts, end_ts, tz_offset_min, local_date, is_nap, updated_at)
      VALUES ('nap', ?, ?, 0, '2026-10-20', 1, 0)`).bind(tap().ts - 60, tap().ts + 60).run();
    await env.DB.prepare(`INSERT INTO workout
      (source_id, type, start_ts, end_ts, tz_offset_min, local_date, updated_at)
      VALUES ('exercise', 'walk', ?, ?, 0, '2026-10-20', 0)`).bind(day + 3600, day + 7200).run();
    const i = await loadAcuteInput(env.DB, { ...params, end: "2026-10-21" });
    expect([...i.windows.keys()].sort((a, b) => a - b)).toEqual(candidateTimes(i.taps));
    expect(i.sleeps).toEqual([[tap().ts - 60, tap().ts + 60]]);
    expect(i.workouts).toEqual([[day + 3600, day + 7200]]);
    expect(i.windows.get(day)?.base_mean).toBeNull();
    expect(i.windows.get(day)?.base_n).toBe(0);
  });
  it("keeps a tap's stored offset independently of the configured zone", async () => {
    await seedTap(tap().ts, 120);
    const i = await loadAcuteInput(env.DB, params);
    expect(i.windows.get(tap().ts)?.tz_offset_min).toBe(120);
    expect(i.windows.get(tap().ts + 1800)?.tz_offset_min).toBe(0);
  });
  it("propagates a database failure", async () => {
    const db = { prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("D1 unavailable")) }) }) } as unknown as D1Database;
    await expect(loadAcuteInput(db, params)).rejects.toThrow("D1 unavailable");
  });
  it("carries the actual grid offset across DST even without HR data", async () => {
    await seedTap(at("2026-10-25T09:00:00Z"), 60);
    const p = { start: "2026-10-25", end: "2026-10-25", nowSec: at("2026-10-27T00:00:00Z"), tz: "Europe/Madrid" };
    let i = await loadAcuteInput(env.DB, p);
    expect(i.windows.get(at("2026-10-25T00:30:00Z"))?.tz_offset_min).toBe(120);
    expect(i.windows.get(at("2026-10-25T01:30:00Z"))?.tz_offset_min).toBe(60);
    await seedMinutes(at("2026-10-24T23:00:00Z"), 240, 0, true);
    i = await loadAcuteInput(env.DB, p);
    expect(i.windows.get(at("2026-10-25T00:30:00Z"))?.tz_offset_min).toBe(120);
    expect(i.windows.get(at("2026-10-25T01:30:00Z"))?.tz_offset_min).toBe(60);
  });
  it("executes one SELECT-only statement with at most 100 bindings", async () => {
    const sql: string[] = []; const bindings: unknown[][] = [];
    const db = { prepare(q: string) { sql.push(q); return { bind(...args: unknown[]) {
      bindings.push(args); return { all: () => env.DB.prepare(q).bind(...args).all() };
    } }; } } as unknown as D1Database;
    expect((await loadAcuteInput(db, params)).taps).toEqual([]);
    expect(sql).toHaveLength(1); expect(sql[0]).toMatch(/^\s*WITH\b/i);
    expect(sql[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP)\b/i);
    expect(bindings[0].length).toBeLessThanOrEqual(100);
    expect(ACUTE.coverage).toBe(0.8);
  });
});
