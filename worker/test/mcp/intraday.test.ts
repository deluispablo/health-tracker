import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthIntraday } from "../../src/mcp/tools/intraday";

const at = (iso: string) => Date.parse(iso) / 1000;

async function minute(iso: string, value: number, vmin: number | null = null, vmax: number | null = null, tz = 120, metric = "hr", src = "gh") {
  await env.DB.prepare(`INSERT INTO metric_minute (metric, ts, tz_offset_min, value, vmin, vmax, n, source)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`).bind(metric, at(iso), tz, value, vmin, vmax, src).run();
}
interface Seen { sql: string[]; binds: unknown[][]; writes: string[]; calls: string[] }
function guarded(): [D1Database, Seen] {
  const seen: Seen = { sql: [], binds: [], writes: [], calls: [] };
  const wrap = <T extends object>(o: T, on: (p: string | symbol) => unknown): T => new Proxy(o, { get(t, p) {
    const r = on(p);
    if (r !== undefined) return r;
    const v: unknown = Reflect.get(t, p);
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  } });
  const db = wrap(env.DB, (p) => {
    if (p === "prepare") return (q: string) => { seen.sql.push(q); return wrap(env.DB.prepare(q), (sp) => sp === "bind"
      ? (...a: unknown[]) => { seen.binds.push(a); return wrap(env.DB.prepare(q).bind(...a), (bp) => {
        if (typeof bp === "string" && ["all", "raw", "first", "run"].includes(bp)) seen.calls.push(bp);
        return undefined;
      }); } : undefined); };
    if (p === "exec" || p === "dump" || p === "batch") return () => { seen.writes.push(p); throw new Error("unexpected"); };
    return undefined;
  });
  return [db, seen];
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM metric_minute").run();
});

describe("AC3 health_intraday", () => {
  it("returns the local day's minutes as [local time, avg, min, max], oldest first, with unit and coverage", async () => {
    await minute("2026-10-06T21:59:00Z", 50);
    await minute("2026-10-06T22:00:00Z", 58, 55, 62);
    await minute("2026-10-06T22:01:00Z", 60);
    await minute("2026-10-07T21:59:00Z", 70, 69, 71);
    await minute("2026-10-07T22:00:00Z", 80);
    await minute("2026-10-06T22:02:00Z", 99, null, null, 120, "hr", "other");
    await minute("2026-10-06T22:03:00Z", 99, null, null, 120, "steps");
    expect(await healthIntraday(env.DB, { metric: "hr", date: "2026-10-07", resolution: "1m" })).toEqual({
      metric: "hr", unit: "bpm", date: "2026-10-07", resolution: "1m",
      points: [["2026-10-07T00:00", 58, 55, 62], ["2026-10-07T00:01", 60, 60, 60], ["2026-10-07T23:59", 70, 69, 71]],
      coverage: { minutes_with_data: 3 },
    });
  });

  it("aggregates into 5-minute and hourly buckets with a rounded mean and the extreme min and max", async () => {
    await minute("2026-10-07T06:00:00Z", 60, 58, 63);
    await minute("2026-10-07T06:02:00Z", 61);
    await minute("2026-10-07T06:04:00Z", 64, null, 70);
    await minute("2026-10-07T06:05:00Z", 90, 85, 95);
    await minute("2026-10-07T06:59:00Z", 100);
    const five = await healthIntraday(env.DB, { metric: "hr", date: "2026-10-07", resolution: "5m" });
    expect(five.points).toEqual([["2026-10-07T08:00", 61.7, 58, 70], ["2026-10-07T08:05", 90, 85, 95], ["2026-10-07T08:55", 100, 100, 100]]);
    expect(five.coverage).toEqual({ minutes_with_data: 5 });
    const hour = await healthIntraday(env.DB, { metric: "hr", date: "2026-10-07", resolution: "1h" });
    expect(hour.points).toEqual([["2026-10-07T08:00", 75, 58, 100]]);
  });

  it("uses each row's own offset, including half-hour zones, and keeps both DST fall-back hours apart", async () => {
    await minute("2026-10-07T00:10:00Z", 70, null, null, 330);
    await minute("2026-10-07T00:40:00Z", 72, null, null, 330);
    expect((await healthIntraday(env.DB, { metric: "hr", date: "2026-10-07", resolution: "1h" })).points)
      .toEqual([["2026-10-07T05:00", 70, 70, 70], ["2026-10-07T06:00", 72, 72, 72]]);
    await minute("2026-10-25T00:30:00Z", 60, null, null, 120);
    await minute("2026-10-25T01:30:00Z", 66, null, null, 60);
    expect((await healthIntraday(env.DB, { metric: "hr", date: "2026-10-25", resolution: "1h" })).points)
      .toEqual([["2026-10-25T02:00", 60, 60, 60], ["2026-10-25T02:00", 66, 66, 66]]);
  });

  it("bounds the local day across ±14 h offsets, including exact local midnights", async () => {
    await minute("2026-10-06T09:59:00Z", 1, null, null, 840);
    await minute("2026-10-06T10:00:00Z", 2, null, null, 840);
    await minute("2026-10-08T11:59:00Z", 3, null, null, -720);
    await minute("2026-10-08T12:00:00Z", 4, null, null, -720);
    expect((await healthIntraday(env.DB, { metric: "hr", date: "2026-10-07", resolution: "1m" })).points)
      .toEqual([["2026-10-07T00:00", 2, 2, 2], ["2026-10-07T23:59", 3, 3, 3]]);
  });

  it("orders buckets by their first UTC time when DST fall-back labels run backwards", async () => {
    await minute("2026-10-25T00:59:00Z", 61, null, null, 120);
    await minute("2026-10-25T01:00:00Z", 62, null, null, 60);
    expect((await healthIntraday(env.DB, { metric: "hr", date: "2026-10-25", resolution: "1m" })).points)
      .toEqual([["2026-10-25T02:59", 61, 61, 61], ["2026-10-25T02:00", 62, 62, 62]]);
  });

  it("averages stored values unweighted and takes each extreme independently, as stored", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO metric_minute VALUES ('hr', ?, 120, 60.25, 70, NULL, 1, 'gh')").bind(at("2026-10-07T06:00:00Z")),
      env.DB.prepare("INSERT INTO metric_minute VALUES ('hr', ?, 120, 0, NULL, 5, 50, 'gh')").bind(at("2026-10-07T06:01:00Z")),
      env.DB.prepare("INSERT INTO metric_minute VALUES ('hr', ?, 120, 80.5, 90, 79, 7, 'gh')").bind(at("2026-10-07T06:02:00Z")),
    ]);
    const args = { metric: "hr", date: "2026-10-07", resolution: "5m" } as const;
    expect((await healthIntraday(env.DB, args)).points).toEqual([["2026-10-07T08:00", 46.9, 0, 79]]);
    await env.DB.prepare("UPDATE metric_minute SET value = 100, vmin = NULL, vmax = NULL WHERE ts = ?").bind(at("2026-10-07T06:01:00Z")).run();
    expect((await healthIntraday(env.DB, args)).points).toEqual([["2026-10-07T08:00", 80.3, 70, 100]]);
    await env.DB.prepare("DELETE FROM metric_minute").run();
    expect((await healthIntraday(env.DB, args)).points).toEqual([]);
  });

  it("returns no points for a day without data", async () => {
    await minute("2026-10-07T06:00:00Z", 60);
    expect(await healthIntraday(env.DB, { metric: "hr", date: "2026-10-09", resolution: "5m" }))
      .toMatchObject({ points: [], coverage: { minutes_with_data: 0 } });
  });

  it("validates metric, date and resolution before any read", async () => {
    const [db, seen] = guarded();
    const bad = [{ metric: "steps", date: "2026-10-07", resolution: "1m" }, { metric: "HR", date: "2026-10-07", resolution: "1m" },
      { metric: "hr", date: "2026-02-30", resolution: "1m" }, { metric: "hr", date: "2026-10-7", resolution: "1m" },
      { metric: "hr", date: "", resolution: "5m" }, { metric: "hr", date: "2026-10-07", resolution: "2m" },
      { metric: "hr", date: "2026-10-07", resolution: "" }, { metric: "hr", date: "1969-12-31", resolution: "1m" },
      { metric: "hr", date: "1999-12-31", resolution: "1m" }, { metric: "hr", date: "2100-01-01", resolution: "1m" }];
    for (const args of bad) await expect(healthIntraday(db, args as Parameters<typeof healthIntraday>[1])).rejects.toThrow(RangeError);
    expect(seen.sql).toEqual([]);
    await expect(healthIntraday(env.DB, { metric: "hr", date: "2028-02-29", resolution: "1h" })).resolves.toMatchObject({ points: [] });
  });

  it("reads once with bound values only, never writes, and rejects on D1 failure", async () => {
    await minute("2026-10-07T06:00:00Z", 60);
    const [db, seen] = guarded();
    await healthIntraday(db, { metric: "hr", date: "2026-10-07", resolution: "1m" });
    expect(seen.sql).toHaveLength(1);
    expect(seen.sql[0]).toMatch(/^\s*SELECT\b/i);
    expect(seen.sql[0]).not.toMatch(/2026|'hr'|1791/);
    expect(seen.sql[0]).toMatch(/\bGROUP\s+BY\b/i);
    expect(seen.sql[0]).toMatch(/\bts\s*>=\s*\?/i);
    expect(seen.sql[0]).toMatch(/\bts\s*<\s*\?/i);
    expect(seen.calls).toEqual(["all"]);
    const lower = at("2026-10-07T00:00:00Z") - 14 * 3600;
    const upper = at("2026-10-07T00:00:00Z") + 38 * 3600;
    expect(seen.binds[0]).toEqual(expect.arrayContaining(["hr", lower, upper, "2026-10-07"]));
    expect(seen.writes).toEqual([]);
    const broken = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return () => ({ bind: () => ({ all: () => Promise.reject(new Error("D1 down")),
        raw: () => Promise.reject(new Error("D1 down")), first: () => Promise.reject(new Error("D1 down")) }) });
      const v: unknown = Reflect.get(t, p);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    await expect(healthIntraday(broken, { metric: "hr", date: "2026-10-07", resolution: "1m" })).rejects.toThrow("D1 down");
  });
});
