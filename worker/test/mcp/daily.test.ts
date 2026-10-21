import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DAILY_COLUMNS, healthDaily } from "../../src/mcp/tools/daily";

async function summary(date: string, f: Record<string, number | string | null> = {}) {
  const cols = Object.keys(f);
  await env.DB.prepare(`INSERT INTO daily_summary (local_date${cols.map((c) => `, ${c}`).join("")}, computed_at) VALUES (?${cols.map(() => ", ?").join("")}, 1)`)
    .bind(date, ...Object.values(f)).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM daily_summary"), env.DB.prepare("DELETE FROM tracker_daily")]);
});

describe("AC1 health_daily", () => {
  it("returns v_daily rows in the range, oldest first, with every column, units and coverage", async () => {
    await summary("2026-10-05", { rhr: 61, steps: 8123, readiness_proxy: 0.4 });
    await summary("2026-10-07", { rhr: 63, sleep_min: 380, bedtime_local: "23:15" });
    await summary("2026-10-09", { rhr: 99 });
    await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES ('2026-10-07', 'cigarettes', 4, 4, 2)").run();
    const out = await healthDaily(env.DB, { start: "2026-10-04", end: "2026-10-08" });
    expect(out.columns).toEqual(["local_date", ...DAILY_COLUMNS]);
    expect(out.rows.map((r) => [r[0], r[out.columns.indexOf("rhr")], r[out.columns.indexOf("cigarettes")]])).toEqual([
      ["2026-10-05", 61, null], ["2026-10-07", 63, 4]]);
    expect(out.coverage).toEqual({ days_requested: 5, days_with_data: 2 });
    expect(out.units.rhr).toBe("bpm");
    expect(out.units.sleep_min).toBe("min");
    expect(out.units.cigarettes).toBe("count");
    expect(Object.keys(out.units).sort()).toEqual([...DAILY_COLUMNS].sort());
  });

  it("returns only the requested metrics, in the requested order", async () => {
    await summary("2026-10-05", { rhr: 61, steps: 8123, hrv_rmssd: 40 });
    const out = await healthDaily(env.DB, { start: "2026-10-05", end: "2026-10-05", metrics: ["steps", "rhr"] });
    expect(out).toEqual({ columns: ["local_date", "steps", "rhr"], rows: [["2026-10-05", 8123, 61]],
      units: { steps: "count", rhr: "bpm" }, coverage: { days_requested: 1, days_with_data: 1 } });
  });

  it("rejects bad dates, reversed or over-90-day ranges, unknown or duplicate metrics, before reading", async () => {
    const bad: Parameters<typeof healthDaily>[1][] = [
      { start: "2026-10-08", end: "2026-10-07" }, { start: "2026-1-01", end: "2026-01-02" }, { start: "2026-02-30", end: "2026-03-01" },
      { start: "2026-01-01", end: "2026-04-01" }, { start: "2026-10-01", end: "2026-10-02", metrics: ["rhr; DROP TABLE event"] },
      { start: "2026-10-01", end: "2026-10-02", metrics: ["computed_at"] }, { start: "2026-10-01", end: "2026-10-02", metrics: [] },
      { start: "2026-10-01", end: "2026-10-02", metrics: ["rhr", "rhr"] },
    ];
    for (const args of bad) await expect(healthDaily(env.DB, args)).rejects.toThrow(RangeError);
    await expect(healthDaily(env.DB, { start: "2026-01-01", end: "2026-03-31" })).resolves.toEqual(expect.objectContaining({ coverage: { days_requested: 90, days_with_data: 0 } }));
  });

  it("reads only through v_daily with bound parameters", async () => {
    const sql: string[] = [];
    const spy = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (q: string) => { sql.push(q); return t.prepare(q); };
      const v: unknown = Reflect.get(t, p);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    await healthDaily(spy, { start: "2026-10-01", end: "2026-10-02", metrics: ["rhr"] });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/\bFROM\s+v_daily\b/i);
    expect(sql[0]).not.toMatch(/2026-10-0/);
  });
});
