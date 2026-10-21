import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recomputeTrackerDaily } from "../../src/rollup/trackers";

const at = (iso: string) => Date.parse(iso) / 1000;
let seq = 0;

async function event(tracker: string, iso: string, value: number, localDate: string, tz = 120, deletedAt: number | null = null, origin = "mcp") {
  seq++;
  await env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).bind(`e${String(seq)}`, tracker, at(iso), tz, localDate, value, origin, deletedAt).run();
}
const rows = async () => (await env.DB.prepare("SELECT * FROM tracker_daily ORDER BY local_date, tracker_id").all()).results;
const snapshot = async () => [await rows(), (await env.DB.prepare("SELECT count(*) AS n FROM event").first())];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(`INSERT OR IGNORE INTO tracker (id, name, unit, value_type, created_at) VALUES
    ('cigarettes', 'Cigarettes', 'u', 'count', 1), ('alcohol', 'Alcohol', 'g', 'amount', 1), ('caffeine', 'Caffeine', 'mg', 'amount', 1)`).run();
  await env.DB.prepare("INSERT INTO tracker (id, name, unit, value_type, created_at, archived_at) VALUES ('mood', 'Mood', 'pt', 'scale', 1, 2)").run();
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DROP TRIGGER IF EXISTS fail_t"), env.DB.prepare("DELETE FROM tracker_daily"), env.DB.prepare("DELETE FROM event")]);
});

describe("AC1 tracker daily totals", () => {
  it("sums live events per local date and tracker, with count, evening total (from 18:00 local) and first/last ts", async () => {
    await event("cigarettes", "2026-10-07T06:00:00Z", 1, "2026-10-07");
    await event("cigarettes", "2026-10-07T15:59:59Z", 1, "2026-10-07");
    await event("cigarettes", "2026-10-07T16:00:00Z", 2, "2026-10-07");
    await event("cigarettes", "2026-10-07T20:10:00Z", 1, "2026-10-07");
    await event("cigarettes", "2026-10-07T12:00:00Z", 5, "2026-10-07", 120, 99);
    await event("alcohol", "2026-10-07T19:00:00Z", 12.5, "2026-10-07");
    await event("caffeine", "2026-10-07T07:00:00Z", 80, "2026-10-07");
    expect(await recomputeTrackerDaily(env.DB, "2026-10-07", "2026-10-07")).toBe(1);
    expect(await rows()).toEqual([
      { local_date: "2026-10-07", tracker_id: "alcohol", total: 12.5, n: 1, evening_total: 12.5, first_ts: at("2026-10-07T19:00:00Z"), last_ts: at("2026-10-07T19:00:00Z") },
      { local_date: "2026-10-07", tracker_id: "caffeine", total: 80, n: 1, evening_total: 0, first_ts: at("2026-10-07T07:00:00Z"), last_ts: at("2026-10-07T07:00:00Z") },
      { local_date: "2026-10-07", tracker_id: "cigarettes", total: 5, n: 4, evening_total: 3, first_ts: at("2026-10-07T06:00:00Z"), last_ts: at("2026-10-07T20:10:00Z") },
    ]);
  });

  it("uses each event's own offset for the evening and its stored local_date for the day", async () => {
    // 23:30Z at -05:00 is 18:30 local on the 7th; 17:30Z at +05:30 is 23:00 local; 12:59Z at -05:00 is 07:59.
    await event("cigarettes", "2026-10-07T23:30:00Z", 1, "2026-10-07", -300);
    await event("cigarettes", "2026-10-07T17:30:00Z", 1, "2026-10-07", 330);
    await event("cigarettes", "2026-10-07T12:59:00Z", 1, "2026-10-07", -300);
    await recomputeTrackerDaily(env.DB, "2026-10-07", "2026-10-07");
    expect(await rows()).toEqual([expect.objectContaining({ total: 3, n: 3, evening_total: 2 })]);
  });

  it("replaces the range: removed or deleted events disappear, dates outside are untouched, no row for empty days", async () => {
    await event("cigarettes", "2026-10-06T08:00:00Z", 1, "2026-10-06");
    await event("cigarettes", "2026-10-07T08:00:00Z", 1, "2026-10-07");
    await event("alcohol", "2026-10-08T08:00:00Z", 10, "2026-10-08");
    await recomputeTrackerDaily(env.DB, "2026-10-06", "2026-10-08");
    await env.DB.prepare("UPDATE event SET deleted_at = 5 WHERE local_date = '2026-10-07'").run();
    await env.DB.prepare("DELETE FROM event WHERE local_date = '2026-10-08'").run();
    await event("cigarettes", "2026-10-06T09:00:00Z", 2, "2026-10-06");
    expect(await recomputeTrackerDaily(env.DB, "2026-10-07", "2026-10-09")).toBe(3);
    expect((await rows()).map((r) => [r.local_date, r.tracker_id, r.total])).toEqual([["2026-10-06", "cigarettes", 1]]);
  });

  it("groups by the stored local_date even when it differs from the UTC or offset-derived date", async () => {
    // 23:30Z on the 6th at +02:00 is 01:30 on the 7th; stored as the 7th.
    await event("cigarettes", "2026-10-06T23:30:00Z", 1, "2026-10-07");
    // Deliberately inconsistent stored date: the stored value wins.
    await event("cigarettes", "2026-10-07T10:00:00Z", 1, "2026-10-09");
    await recomputeTrackerDaily(env.DB, "2026-10-06", "2026-10-07");
    expect((await rows()).map((r) => [r.local_date, r.total])).toEqual([["2026-10-07", 1]]);
  });

  it("keeps rows whose total is zero, counts every origin and archived trackers, and excludes deleted_at = 0", async () => {
    await event("alcohol", "2026-10-07T08:00:00Z", 0, "2026-10-07", 120, null, "artifact");
    await event("mood", "2026-10-07T17:00:00Z", 3, "2026-10-07", 120, null, "import");
    await event("mood", "2026-10-07T18:00:00Z", -3, "2026-10-07", 120, null, "mcp");
    await event("mood", "2026-10-07T19:00:00Z", 9, "2026-10-07", 120, 0);
    await recomputeTrackerDaily(env.DB, "2026-10-07", "2026-10-07");
    expect(await rows()).toEqual([
      { local_date: "2026-10-07", tracker_id: "alcohol", total: 0, n: 1, evening_total: 0, first_ts: at("2026-10-07T08:00:00Z"), last_ts: at("2026-10-07T08:00:00Z") },
      { local_date: "2026-10-07", tracker_id: "mood", total: 0, n: 2, evening_total: 0, first_ts: at("2026-10-07T17:00:00Z"), last_ts: at("2026-10-07T18:00:00Z") },
    ]);
  });

  it("uses a non-negative time of day before 1970", async () => {
    await event("caffeine", "1969-12-31T18:00:00Z", 5, "1969-12-31", 0);
    await recomputeTrackerDaily(env.DB, "1969-12-31", "1969-12-31");
    expect(await rows()).toEqual([expect.objectContaining({ evening_total: 5 })]);
  });

  it("is idempotent", async () => {
    await event("caffeine", "2026-10-07T07:00:00Z", 80, "2026-10-07");
    await recomputeTrackerDaily(env.DB, "2026-10-01", "2026-10-31");
    const first = await rows();
    await recomputeTrackerDaily(env.DB, "2026-10-01", "2026-10-31");
    expect(await rows()).toEqual(first);
  });

  it("does all the work in one batch, with no reads or writes outside it", async () => {
    const batches: number[] = [];
    const unwrap = new WeakMap<object, D1PreparedStatement>();
    const guard = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, { get(t, p) {
      if (p === "bind") return (...args: unknown[]) => {
        const raw = t.bind(...args);
        const wrapped = guard(raw);
        unwrap.set(wrapped, raw);
        return wrapped;
      };
      if (p === "run" || p === "first" || p === "all" || p === "raw") throw new Error(`unexpected ${p} outside the batch`);
      const v: unknown = Reflect.get(t, p);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    const spy = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") return (stmts: D1PreparedStatement[]) => { batches.push(stmts.length); return target.batch(stmts.map((x) => unwrap.get(x) ?? x)); };
        if (prop === "prepare") return (sql: string) => { const raw = target.prepare(sql); const w = guard(raw); unwrap.set(w, raw); return w; };
        const v: unknown = Reflect.get(target, prop);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await event("caffeine", "2026-10-07T07:00:00Z", 80, "2026-10-07");
    await recomputeTrackerDaily(spy, "2026-10-01", "2026-10-31");
    expect(batches).toHaveLength(1);
    expect((await rows()).map((r) => r.total)).toEqual([80]);
  });

  it("validates the range before any write and runs in one atomic batch", async () => {
    await event("caffeine", "2026-10-07T07:00:00Z", 80, "2026-10-07");
    await recomputeTrackerDaily(env.DB, "2026-10-07", "2026-10-07");
    const before = await snapshot();
    const bad: [string, string][] = [["2026-10-08", "2026-10-07"], ["2026-1-07", "2026-01-08"], ["2026-02-30", "2026-03-01"], ["2025-01-01", "2026-01-02"]];
    for (const [a, b] of bad) {
      await expect(recomputeTrackerDaily(env.DB, a, b)).rejects.toThrow(RangeError);
      expect(await snapshot()).toEqual(before);
    }
    await expect(recomputeTrackerDaily(env.DB, "2025-01-01", "2026-01-01")).resolves.toBe(366);
    await event("caffeine", "2026-10-07T08:00:00Z", 20, "2026-10-07");
    await env.DB.prepare("CREATE TRIGGER fail_t BEFORE INSERT ON tracker_daily BEGIN SELECT RAISE(ABORT, 'x'); END").run();
    await expect(recomputeTrackerDaily(env.DB, "2026-10-07", "2026-10-07")).rejects.toThrow();
    await env.DB.prepare("DROP TRIGGER fail_t").run();
    expect((await rows()).map((r) => r.total)).toEqual([80]);
  });
});
