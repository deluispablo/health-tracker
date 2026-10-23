import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthSleep } from "../../src/mcp/tools/sleep";

const at = (iso: string) => Date.parse(iso) / 1000;

async function session(id: string, start: string, end: string, localDate: string, f: Partial<Record<string, number>> = {}, tz = 120, src = "gh") {
  await env.DB.prepare(`INSERT INTO sleep_session (source_id, source, start_ts, end_ts, tz_offset_min, local_date, is_nap, minutes_asleep, minutes_in_bed,
    efficiency, deep_min, rem_min, light_min, awake_min, latency_min, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .bind(id, src, at(start), at(end), tz, localDate, f.is_nap ?? 0, f.asleep ?? null, f.in_bed ?? null, f.eff ?? null, f.deep ?? null,
      f.rem ?? null, f.light ?? null, f.awake ?? null, f.latency ?? null).run();
}
async function stage(id: string, start: string, end: string, kind: string) {
  await env.DB.prepare("INSERT INTO sleep_stage (session_id, start_ts, end_ts, stage) VALUES (?, ?, ?, ?)").bind(id, at(start), at(end), kind).run();
}
interface Seen { sql: string[]; binds: unknown[][]; writes: string[]; calls: number }
function guarded(): [D1Database, Seen] {
  const seen: Seen = { sql: [], binds: [], writes: [], calls: 0 };
  const wrap = <T extends object>(o: T, on: (p: string | symbol, v: unknown) => unknown): T => new Proxy(o, { get(t, p) {
    const v: unknown = Reflect.get(t, p);
    const r = on(p, v);
    if (r !== undefined) return r;
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  } });
  const db = wrap(env.DB, (p) => {
    if (p === "prepare") return (q: string) => { seen.sql.push(q); return wrap(env.DB.prepare(q), (sp) => sp === "bind"
      ? (...a: unknown[]) => { seen.binds.push(a); return env.DB.prepare(q).bind(...a); } : undefined); };
    if (p === "batch") return (statements: D1PreparedStatement[]) => { seen.calls++; return env.DB.batch(statements); };
    if (p === "exec" || p === "dump") return () => { seen.writes.push(p); throw new Error("unexpected"); };
    return undefined;
  });
  return [db, seen];
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM sleep_stage"), env.DB.prepare("DELETE FROM sleep_session")]);
});

describe("AC1 health_sleep", () => {
  it("returns the sessions woken up on the dates in range, with summary, local times and a compact hypnogram", async () => {
    await session("s1", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z", "2026-10-07",
      { asleep: 380, in_bed: 453, eff: 84, deep: 74, rem: 118, light: 188, awake: 73, latency: 7 });
    await stage("s1", "2026-10-06T21:15:00Z", "2026-10-06T22:28:00Z", "AWAKE");
    await stage("s1", "2026-10-06T22:28:00Z", "2026-10-06T22:48:00Z", "LIGHT");
    await stage("s1", "2026-10-06T22:48:00Z", "2026-10-07T04:48:00Z", "DEEP");
    await session("nap", "2026-10-07T12:00:00Z", "2026-10-07T12:40:00Z", "2026-10-07", { is_nap: 1, asleep: 35, in_bed: 40 });
    await session("other", "2026-10-07T21:00:00Z", "2026-10-08T05:00:00Z", "2026-10-08", { asleep: 400 });
    expect(await healthSleep(env.DB, { start: "2026-10-07", end: "2026-10-07" })).toEqual({
      sessions: [
        { local_date: "2026-10-07", is_nap: false, start_local: "2026-10-06T23:15", end_local: "2026-10-07T06:48", tz_offset_min: 120,
          minutes_asleep: 380, minutes_in_bed: 453, efficiency: 84, deep_min: 74, rem_min: 118, light_min: 188, awake_min: 73, latency_min: 7,
          stages: [[0, 73, "AWAKE"], [73, 93, "LIGHT"], [93, 453, "DEEP"]] },
        { local_date: "2026-10-07", is_nap: true, start_local: "2026-10-07T14:00", end_local: "2026-10-07T14:40", tz_offset_min: 120,
          minutes_asleep: 35, minutes_in_bed: 40, efficiency: null, deep_min: null, rem_min: null, light_min: null, awake_min: null, latency_min: null,
          stages: [] },
      ],
      coverage: { days_requested: 1, days_with_sleep: 1 },
    });
  });

  it("uses each session's own offset, rounds stage offsets down to whole minutes and orders by start", async () => {
    await session("b", "2026-10-08T04:00:00Z", "2026-10-08T11:00:00Z", "2026-10-08", {}, -300);
    await session("a", "2026-10-07T19:00:00Z", "2026-10-08T01:30:00Z", "2026-10-08", {}, 330);
    await stage("a", "2026-10-07T19:00:30Z", "2026-10-07T19:10:59Z", "REM");
    const out = await healthSleep(env.DB, { start: "2026-10-08", end: "2026-10-08" });
    expect(out.sessions.map((s) => [s.start_local, s.end_local, s.stages])).toEqual([
      ["2026-10-08T00:30", "2026-10-08T07:00", [[0, 10, "REM"]]],
      ["2026-10-07T23:00", "2026-10-08T06:00", []]]);
  });

  it("covers a multi-day range inclusively and counts dates with any session", async () => {
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05"]) {
      await session(`x${d}`, `${d}T00:00:00Z`, `${d}T06:00:00Z`, d);
    }
    const out = await healthSleep(env.DB, { start: "2026-10-02", end: "2026-10-04" });
    expect(out.sessions.map((s) => s.local_date)).toEqual(["2026-10-02", "2026-10-04"]);
    expect(out.coverage).toEqual({ days_requested: 3, days_with_sleep: 2 });
  });

  it("validates before any read and allows at most 31 dates", async () => {
    const [db, seen] = guarded();
    const bad = [{ start: "2026-10-08", end: "2026-10-07" }, { start: "2026-1-01", end: "2026-01-02" }, { start: "2026-02-29", end: "2026-03-01" },
      { start: "2026-10-01", end: "2026-11-01" }];
    for (const args of bad) await expect(healthSleep(db, args)).rejects.toThrow(RangeError);
    expect(seen.sql).toEqual([]);
    await expect(healthSleep(env.DB, { start: "2026-10-01", end: "2026-10-31" })).resolves.toEqual({ sessions: [], coverage: { days_requested: 31, days_with_sleep: 0 } });
  });

  it("rejects a start before 2000 like health_compare, before reading", async () => {
    const [db, seen] = guarded();
    await expect(healthSleep(db, { start: "1999-12-31", end: "2000-01-01" })).rejects.toThrow("date must be a real calendar date in YYYY-MM-DD format");
    expect(seen.sql).toEqual([]);
    expect(seen.calls).toBe(0);
  });

  it("reads with bound dates only, never writes, and rejects on D1 failure", async () => {
    const [db, seen] = guarded();
    await healthSleep(db, { start: "2026-10-01", end: "2026-10-02" });
    expect(seen.sql.join(" ")).not.toMatch(/2026-10-0/);
    expect(seen.binds.every((b) => b.length === 2 && b[0] === "2026-10-01" && b[1] === "2026-10-02")).toBe(true);
    expect(seen.sql.every((q) => /^\s*SELECT\b/i.test(q))).toBe(true);
    expect(seen.writes).toEqual([]);
    expect(seen.calls).toBe(1);
    expect(seen.sql).toHaveLength(2);
    const broken = new Proxy(env.DB, { get(t, p) {
      if (p === "batch") return () => Promise.reject(new Error("D1 down"));
      if (p === "prepare") return (q: string) => new Proxy(t.prepare(q), { get(st, sp) {
        if (sp === "bind") return (...a: unknown[]) => new Proxy(st.bind(...a), { get(b, bp) {
          if (bp === "all" || bp === "first" || bp === "raw") return () => Promise.reject(new Error("D1 down"));
          const v: unknown = Reflect.get(b, bp);
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(b) : v;
        } });
        const v: unknown = Reflect.get(st, sp);
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(st) : v;
      } });
      const v: unknown = Reflect.get(t, p);
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    } });
    await expect(healthSleep(broken, { start: "2026-10-01", end: "2026-10-02" })).rejects.toThrow("D1 down");
  });
  it("returns every source, breaks start ties by source_id and keeps each session's stages isolated and ordered", async () => {
    await session("z'2", "2026-10-07T22:00:00Z", "2026-10-08T05:00:00Z", "2026-10-08", { asleep: 2 }, 120, "other");
    await session("a\"1", "2026-10-07T22:00:00Z", "2026-10-08T06:00:00Z", "2026-10-08", { asleep: 1 });
    await session("out", "2026-10-08T22:00:00Z", "2026-10-09T05:00:00Z", "2026-10-09");
    await stage("z'2", "2026-10-07T23:00:00Z", "2026-10-07T23:30:00Z", "REM");
    await stage("z'2", "2026-10-07T22:00:00Z", "2026-10-07T23:00:00Z", "LIGHT");
    await stage("a\"1", "2026-10-07T22:30:00Z", "2026-10-07T23:00:00Z", "DEEP");
    await stage("out", "2026-10-08T22:00:00Z", "2026-10-08T23:00:00Z", "AWAKE");
    const [db, seen] = guarded();
    const out = await healthSleep(db, { start: "2026-10-08", end: "2026-10-08" });
    expect(out.sessions.map((s) => [s.minutes_asleep, s.stages])).toEqual([
      [1, [[30, 60, "DEEP"]]], [2, [[0, 60, "LIGHT"], [60, 90, "REM"]]]]);
    expect(out.sessions[0]).not.toHaveProperty("source_id");
    expect(out.sessions[0]).not.toHaveProperty("source");
    expect(seen.sql.join(" ")).not.toMatch(/2026-10-0|z'2|a"1/);
    expect(seen.binds.length).toBeGreaterThan(0);
    expect(seen.binds.every((b) => b.length === 2 && b[0] === "2026-10-08" && b[1] === "2026-10-08")).toBe(true);
  });

  it("floors negative and beyond-session stage offsets without clipping or merging", async () => {
    await session("s", "2026-10-07T22:00:00Z", "2026-10-08T05:00:00Z", "2026-10-08");
    await stage("s", "2026-10-07T21:59:30Z", "2026-10-07T22:10:00Z", "AWAKE");
    await stage("s", "2026-10-07T22:10:00Z", "2026-10-07T22:20:00Z", "LIGHT");
    await stage("s", "2026-10-07T22:20:00Z", "2026-10-07T22:30:00Z", "LIGHT");
    await stage("s", "2026-10-08T04:50:00Z", "2026-10-08T05:10:59Z", "AWAKE");
    const out = await healthSleep(env.DB, { start: "2026-10-08", end: "2026-10-08" });
    expect(out.sessions[0].stages).toEqual([[-1, 10, "AWAKE"], [10, 20, "LIGHT"], [20, 30, "LIGHT"], [410, 430, "AWAKE"]]);
  });

  it("returns several main sessions on one date and counts nap-only dates", async () => {
    await session("m1", "2026-10-06T21:00:00Z", "2026-10-07T01:00:00Z", "2026-10-07");
    await session("m2", "2026-10-07T02:00:00Z", "2026-10-07T05:00:00Z", "2026-10-07");
    await session("n", "2026-10-08T12:00:00Z", "2026-10-08T12:30:00Z", "2026-10-08", { is_nap: 1 });
    const out = await healthSleep(env.DB, { start: "2026-10-07", end: "2026-10-08" });
    expect(out.sessions.map((s) => [s.local_date, s.is_nap])).toEqual([["2026-10-07", false], ["2026-10-07", false], ["2026-10-08", true]]);
    expect(out.coverage).toEqual({ days_requested: 2, days_with_sleep: 2 });
  });

  it("returns stored summaries as stored, including zeros and inconsistent values, and never caches", async () => {
    await session("s", "2026-10-07T22:00:00Z", "2026-10-08T05:00:00Z", "2026-10-08",
      { asleep: 0, in_bed: 0, eff: 0, deep: 0, rem: 500, light: 0, awake: 0, latency: 0 });
    await stage("s", "2026-10-07T22:00:00Z", "2026-10-07T23:00:00Z", "DEEP");
    const args = { start: "2026-10-08", end: "2026-10-08" };
    const first = (await healthSleep(env.DB, args)).sessions[0];
    expect([first.minutes_asleep, first.minutes_in_bed, first.efficiency, first.deep_min, first.rem_min, first.latency_min]).toEqual([0, 0, 0, 0, 500, 0]);
    expect(first.stages).toEqual([[0, 60, "DEEP"]]);
    await env.DB.batch([env.DB.prepare("UPDATE sleep_session SET efficiency = 99"), env.DB.prepare("UPDATE sleep_stage SET stage = 'REM'")]);
    const again = (await healthSleep(env.DB, args)).sessions[0];
    expect([again.efficiency, again.stages]).toEqual([99, [[0, 60, "REM"]]]);
  });

  it("accepts a valid leap day and a month-crossing 31-date range, and rejects a malformed end", async () => {
    await expect(healthSleep(env.DB, { start: "2028-02-29", end: "2028-02-29" })).resolves.toMatchObject({ coverage: { days_requested: 1 } });
    await expect(healthSleep(env.DB, { start: "2026-10-15", end: "2026-11-14" })).resolves.toMatchObject({ coverage: { days_requested: 31 } });
    await expect(healthSleep(env.DB, { start: "2026-10-15", end: "2026-11-15" })).rejects.toThrow(RangeError);
    const [db, seen] = guarded();
    for (const end of ["2026-10-1", "2026-10-32", "20261020", ""]) {
      await expect(healthSleep(db, { start: "2026-10-01", end })).rejects.toThrow(RangeError);
    }
    expect(seen.sql).toEqual([]);
  });

  it("rejects when the session and stage batch fails", async () => {
    await session("s", "2026-10-07T22:00:00Z", "2026-10-08T05:00:00Z", "2026-10-08");
    await stage("s", "2026-10-07T22:00:00Z", "2026-10-07T23:00:00Z", "DEEP");
    const broken = new Proxy(env.DB, { get(t, p) {
      if (p === "batch") return (stmts: D1PreparedStatement[]) => t.batch(stmts).then(() => Promise.reject(new Error("stage read failed")));
      const v: unknown = Reflect.get(t, p);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    await expect(healthSleep(broken, { start: "2026-10-08", end: "2026-10-08" })).rejects.toThrow("stage read failed");
  });
});
