import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recomputeDailySummary } from "../../src/rollup/daily";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T06:00:00Z");
const day = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function daily(metric: string, date: string, value: number, source = "gh") {
  await env.DB.prepare("INSERT INTO metric_daily (metric, local_date, value, source, updated_at) VALUES (?, ?, ?, ?, 1)")
    .bind(metric, date, value, source).run();
}
async function sleep(id: string, start: string, end: string, localDate: string, f: Partial<Record<string, number>> = {}, source = "gh") {
  await env.DB.prepare(`INSERT INTO sleep_session (source_id, source, start_ts, end_ts, tz_offset_min, local_date, is_nap, minutes_asleep,
    minutes_in_bed, efficiency, deep_min, rem_min, light_min, awake_min, latency_min, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .bind(id, source, at(start), at(end), f.tz ?? 120, localDate, f.is_nap ?? 0, f.asleep ?? null, f.in_bed ?? null, f.eff ?? null, f.deep ?? null,
      f.rem ?? null, f.light ?? null, f.awake ?? null, f.latency ?? null).run();
}
async function minute(ts: number, tz = 120, metric = "hr", source = "gh") {
  await env.DB.prepare("INSERT INTO metric_minute (metric, ts, tz_offset_min, value, source) VALUES (?, ?, ?, 60, ?)").bind(metric, ts, tz, source).run();
}
const snapshot = async () => (await env.DB.prepare("SELECT * FROM daily_summary ORDER BY local_date").all()).results;
async function summary(date: string, f: Record<string, number | null>) {
  const cols = Object.keys(f);
  await env.DB.prepare(`INSERT INTO daily_summary (local_date, ${cols.join(", ")}, computed_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 1)`)
    .bind(date, ...Object.values(f)).run();
}
const row = async (date: string) => env.DB.prepare("SELECT * FROM daily_summary WHERE local_date = ?").bind(date).first();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch(["daily_summary", "metric_daily", "metric_minute", "sleep_stage", "sleep_session", "workout"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("AC1 base columns", () => {
  it("assembles a day from metric_daily, the main sleep, workouts and heart-rate wear minutes", async () => {
    const D = "2026-10-07";
    await daily("rhr", D, 61);
    await daily("rhr", D, 99, "manual");
    await daily("hrv_rmssd", D, 38.849);
    await daily("resp_rate", D, 14.2);
    await daily("spo2", D, 96.5);
    await daily("skin_temp_dev", D, -0.3);
    await daily("steps", D, 8123);
    await daily("azm", D, 40);
    await sleep("main", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z", D, { asleep: 380, in_bed: 453, eff: 84, deep: 74, rem: 118, light: 188, awake: 73, latency: 7 });
    await sleep("short", "2026-10-07T01:00:00Z", "2026-10-07T02:00:00Z", D, { asleep: 50, in_bed: 60 });
    await sleep("nap", "2026-10-07T12:00:00Z", "2026-10-07T15:00:00Z", D, { is_nap: 1, asleep: 170, in_bed: 180 });
    await env.DB.prepare("INSERT INTO workout (source_id, type, start_ts, end_ts, tz_offset_min, local_date, duration_min, updated_at) VALUES ('w1', 'RUN', 0, 1, 120, ?, 30.5, 1), ('w2', 'WALK', 2, 3, 120, ?, 12, 1)")
      .bind(D, D).run();
    // 2026-10-06T22:30Z is 00:30 on 7 Oct in +02:00; 2026-10-07T22:30Z is already 8 Oct.
    await minute(at("2026-10-06T22:30:00Z"));
    await minute(at("2026-10-07T10:00:00Z"));
    await minute(at("2026-10-07T10:01:00Z"));
    await minute(at("2026-10-07T22:30:00Z"));
    await minute(at("2026-10-06T21:59:00Z"));
    await minute(at("2026-10-07T10:02:00Z"), 120, "steps");

    expect(await recomputeDailySummary(env.DB, D, D, NOW)).toBe(1);
    expect(await row(D)).toEqual({
      local_date: D, rhr: 61, hrv_rmssd: 38.849, ln_rmssd: expect.closeTo(Math.log(38.849), 9) as unknown, resp_rate: 14.2, spo2_avg: 96.5,
      skin_temp_dev: -0.3, sleep_min: 380, sleep_eff: 84, deep_min: 74, rem_min: 118, sleep_latency_min: 7,
      bedtime_local: "23:15", waketime_local: "06:48", steps: 8123, azm: 40, workout_min: 42.5, hr_wear_min: 3,
      z_ln_rmssd: null, z_rhr: null, z_sleep: null, readiness_proxy: null, computed_at: NOW,
    });
  });

  it("writes a row for every date in the range, with nulls when there is no data", async () => {
    expect(await recomputeDailySummary(env.DB, "2026-10-01", "2026-10-03", NOW)).toBe(3);
    const rows = (await env.DB.prepare("SELECT local_date, rhr, sleep_min, steps, workout_min, hr_wear_min FROM daily_summary ORDER BY local_date").all()).results;
    expect(rows).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => ({ local_date: d, rhr: null, sleep_min: null, steps: null, workout_min: null, hr_wear_min: 0 })));
  });

  it("replaces an existing row on recompute and leaves dates outside the range alone", async () => {
    await daily("steps", "2026-10-02", 100);
    await recomputeDailySummary(env.DB, "2026-10-01", "2026-10-02", NOW);
    await env.DB.prepare("UPDATE metric_daily SET value = 250").run();
    await daily("steps", "2026-10-01", 7);
    await recomputeDailySummary(env.DB, "2026-10-02", "2026-10-02", NOW + 60);
    expect([(await row("2026-10-01"))?.steps, (await row("2026-10-02"))?.steps, (await row("2026-10-02"))?.computed_at]).toEqual([null, 250, NOW + 60]);
  });

  it("picks the longest main session by time in bed, then the latest end, ignoring naps", async () => {
    const D = "2026-10-07";
    await sleep("a", "2026-10-06T21:00:00Z", "2026-10-07T03:00:00Z", D, { asleep: 300, in_bed: 360 });
    await sleep("b", "2026-10-06T23:00:00Z", "2026-10-07T05:00:00Z", D, { asleep: 310, in_bed: 360 });
    await sleep("nap", "2026-10-07T10:00:00Z", "2026-10-07T20:00:00Z", D, { is_nap: 1, asleep: 590, in_bed: 600 });
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect([(await row(D))?.sleep_min, (await row(D))?.bedtime_local, (await row(D))?.waketime_local]).toEqual([310, "01:00", "07:00"]);
  });

  it("rejects bad ranges before writing", async () => {
    const bad: [string, string][] = [["2026-10-03", "2026-10-02"], ["2026-1-01", "2026-01-02"], ["2026-02-30", "2026-03-01"], ["2025-01-01", "2026-01-02"]];
    for (const [a, b] of bad) {
      await expect(recomputeDailySummary(env.DB, a, b, NOW)).rejects.toThrow(RangeError);
    }
    await summary("2026-10-02", { steps: 5 });
    const before = await snapshot();
    for (const [a, b] of bad) {
      await expect(recomputeDailySummary(env.DB, a, b, NOW)).rejects.toThrow(RangeError);
      expect(await snapshot()).toEqual(before);
    }
    await expect(recomputeDailySummary(env.DB, "2025-01-01", "2026-01-01", NOW)).resolves.toBe(366);
    const span = await env.DB.prepare("SELECT count(*) AS n, min(local_date) AS lo, max(local_date) AS hi FROM daily_summary WHERE local_date BETWEEN '2025-01-01' AND '2026-01-01'").first();
    expect(span).toEqual({ n: 366, lo: "2025-01-01", hi: "2026-01-01" });
    await expect(recomputeDailySummary(env.DB, "2028-02-28", "2028-03-01", NOW)).resolves.toBe(3);
    expect(await row("2028-02-29")).not.toBeNull();
  });
});

describe("AC1 selection edge cases", () => {
  const D = "2026-10-07";

  it("clears base columns and z-scores whose inputs disappeared", async () => {
    await summary(D, { rhr: 60, steps: 900, sleep_min: 400, z_rhr: 1, z_ln_rmssd: 1, z_sleep: 1, readiness_proxy: 1 });
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect(await row(D)).toEqual(expect.objectContaining({ rhr: null, steps: null, sleep_min: null, z_rhr: null, z_ln_rmssd: null, z_sleep: null, readiness_proxy: null }));
  });

  it("keeps zeros, keeps non-positive HRV with a null log", async () => {
    await daily("hrv_rmssd", D, 0);
    await daily("steps", D, 0);
    await daily("azm", D, 0);
    await sleep("z", "2026-10-06T22:00:00Z", "2026-10-07T05:00:00Z", D, { asleep: 0, in_bed: 420 });
    await daily("hrv_rmssd", "2026-10-08", -1);
    await recomputeDailySummary(env.DB, D, "2026-10-08", NOW);
    expect(await row(D)).toEqual(expect.objectContaining({ hrv_rmssd: 0, ln_rmssd: null, steps: 0, azm: 0, sleep_min: 0 }));
    expect(await row("2026-10-08")).toEqual(expect.objectContaining({ hrv_rmssd: -1, ln_rmssd: null }));
  });

  it("orders main sleep by time in bed (NULL last), then latest end, then source id, copying one session only", async () => {
    await sleep("a", "2026-10-06T21:00:00Z", "2026-10-07T03:00:00Z", D, { asleep: 300 });
    await sleep("b", "2026-10-06T22:00:00Z", "2026-10-07T04:00:00Z", D, { in_bed: 100, eff: 90 });
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect(await row(D)).toEqual(expect.objectContaining({ sleep_min: null, sleep_eff: 90, waketime_local: "06:00" }));
    await env.DB.prepare("DELETE FROM sleep_session").run();
    await sleep("x", "2026-10-06T22:00:00Z", "2026-10-07T04:00:00Z", D, { asleep: 1, in_bed: 300 });
    await sleep("y", "2026-10-06T22:00:00Z", "2026-10-07T04:00:00Z", D, { asleep: 2, in_bed: 300 });
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect((await row(D))?.sleep_min).toBe(2);
  });

  it("uses each session's own offset, including negative and half-hour ones, and leaves nap-only dates without sleep", async () => {
    await sleep("neg", "2026-10-07T03:00:00Z", "2026-10-07T10:30:00Z", D, { asleep: 400, in_bed: 450, tz: -300 });
    await sleep("nap", "2026-10-08T12:00:00Z", "2026-10-08T13:00:00Z", "2026-10-08", { is_nap: 1, asleep: 50, in_bed: 60, tz: 330 });
    await recomputeDailySummary(env.DB, D, "2026-10-08", NOW);
    expect([(await row(D))?.bedtime_local, (await row(D))?.waketime_local]).toEqual(["22:00", "05:30"]);
    expect(await row("2026-10-08")).toEqual(expect.objectContaining({ sleep_min: null, bedtime_local: null }));
  });

  it("reads metric_daily and metric_minute from gh only but sleep and workouts from every source", async () => {
    await daily("steps", D, 50, "manual");
    await minute(at("2026-10-07T10:00:00Z"), 120, "hr", "manual");
    await minute(at("2026-10-07T10:00:00Z"), -330);
    await minute(at("2026-10-07T03:00:00Z"), -330);
    await sleep("m", "2026-10-06T22:00:00Z", "2026-10-07T05:00:00Z", D, { asleep: 333, in_bed: 420 }, "manual");
    await env.DB.prepare("INSERT INTO workout (source_id, source, type, start_ts, end_ts, tz_offset_min, local_date, duration_min, updated_at) VALUES ('w', 'manual', 'RUN', 0, 1, 120, ?, 20, 1)").bind(D).run();
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect(await row(D)).toEqual(expect.objectContaining({ steps: null, hr_wear_min: 1, sleep_min: 333, workout_min: 20 }));
  });

  it("does all the work in one batch with at most 100 bound parameters per statement", async () => {
    const batches: number[] = [];
    const binds: number[] = [];
    const unwrap = new WeakMap<object, D1PreparedStatement>();
    const guard = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, { get(t, p) {
      if (p === "bind") return (...args: unknown[]) => {
        binds.push(args.length);
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
        if (prop === "batch") return (stmts: D1PreparedStatement[]) => {
          batches.push(stmts.length);
          return target.batch(stmts.map((x) => unwrap.get(x) ?? x));
        };
        if (prop === "prepare") return (sql: string) => {
          const raw = target.prepare(sql);
          const wrapped = guard(raw);
          unwrap.set(wrapped, raw);
          return wrapped;
        };
        const v: unknown = Reflect.get(target, prop);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await recomputeDailySummary(spy, "2025-01-01", "2026-01-01", NOW);
    expect(batches).toHaveLength(1);
    expect(Math.max(0, ...binds)).toBeLessThanOrEqual(100);
  });

  it("leaves existing summaries untouched when either phase fails", async () => {
    await summary(D, { steps: 1, z_rhr: 0.5 });
    await summary("2026-10-08", { steps: 2 });
    await daily("steps", D, 10);
    const before = await snapshot();
    for (const event of ["INSERT", "UPDATE"]) {
      await env.DB.prepare(`CREATE TRIGGER fail_p BEFORE ${event} ON daily_summary BEGIN SELECT RAISE(ABORT, 'failed'); END`).run();
      try {
        await expect(recomputeDailySummary(env.DB, D, "2026-10-09", NOW)).rejects.toThrow();
      } finally {
        await env.DB.prepare("DROP TRIGGER fail_p").run();
      }
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects and rolls back the base upsert when the z-score update fails", async () => {
    await daily("steps", D, 10);
    await env.DB.prepare("CREATE TRIGGER fail_z BEFORE UPDATE ON daily_summary BEGIN SELECT RAISE(ABORT, 'z failed'); END").run();
    try {
      await expect(recomputeDailySummary(env.DB, D, D, NOW)).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_z").run();
    }
    expect(await snapshot()).toEqual([]);
  });
});

describe("AC2 baselines and readiness", () => {
  const D = "2026-10-29";
  async function history(rhr: number[], hrv: number[], sleepMin: number[]) {
    for (let i = 0; i < rhr.length; i++) {
      const d = day(D, -(i + 1));
      await daily("rhr", d, rhr[i] ?? 0);
      await daily("hrv_rmssd", d, hrv[i] ?? 0);
      await sleep(`s${String(i)}`, `${day(d, -1)}T22:00:00Z`, `${d}T05:00:00Z`, d, { asleep: sleepMin[i] ?? 0, in_bed: 420 });
    }
  }

  it("z-scores today against the mean and sample SD of the previous 28 days and combines them", async () => {
    await history([60, 62, 64, 60, 62, 64, 62], [40, 40, 50, 50, 45, 45, 45], [400, 420, 440, 400, 420, 440, 420]);
    await daily("rhr", D, 65);
    await daily("hrv_rmssd", D, 30);
    await sleep("today", `${day(D, -1)}T22:00:00Z`, `${D}T05:00:00Z`, D, { asleep: 380, in_bed: 420 });
    await recomputeDailySummary(env.DB, day(D, -7), D, NOW);
    const lnHist = [40, 40, 50, 50, 45, 45, 45].map(Math.log);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
    const zLn = (Math.log(30) - mean(lnHist)) / sd(lnHist);
    const zRhr = (65 - 62) / sd([60, 62, 64, 60, 62, 64, 62]);
    const zSleep = (380 - 420) / sd([400, 420, 440, 400, 420, 440, 420]);
    const r = await row(D);
    expect(r?.z_ln_rmssd).toBeCloseTo(zLn, 9);
    expect(r?.z_rhr).toBeCloseTo(zRhr, 9);
    expect(r?.z_sleep).toBeCloseTo(zSleep, 9);
    expect(r?.readiness_proxy).toBeCloseTo(0.5 * zLn - 0.3 * zRhr + 0.2 * zSleep, 9);
  });

  it("needs at least 7 prior values in the 28-day window, ignores older days and today, and nulls a zero SD", async () => {
    await history([60, 62, 64, 60, 62, 64], [40, 41, 42, 43, 44, 45], [420, 420, 420, 420, 420, 420]);
    await daily("rhr", day(D, -29), 10);
    await daily("rhr", D, 65);
    await daily("hrv_rmssd", D, 30);
    await sleep("today", `${day(D, -1)}T22:00:00Z`, `${D}T05:00:00Z`, D, { asleep: 380, in_bed: 420 });
    await recomputeDailySummary(env.DB, day(D, -29), D, NOW);
    expect(await row(D)).toEqual(expect.objectContaining({ z_rhr: null, z_ln_rmssd: null, z_sleep: null, readiness_proxy: null }));
    await daily("rhr", day(D, -7), 62);
    await daily("hrv_rmssd", day(D, -7), 40);
    await sleep("s6", `${day(D, -8)}T22:00:00Z`, `${day(D, -7)}T05:00:00Z`, day(D, -7), { asleep: 420, in_bed: 420 });
    await recomputeDailySummary(env.DB, day(D, -7), D, NOW);
    const r = await row(D);
    expect(r?.z_rhr).toBeCloseTo((65 - 62) / Math.sqrt(16 / 6), 9);
    expect(r?.z_ln_rmssd).not.toBeNull();
    expect(r?.z_sleep).toBeNull();
    expect(r?.readiness_proxy).toBeNull();
  });

  it("uses stored summaries outside the range as history, not raw inputs", async () => {
    for (let i = 1; i <= 7; i++) await summary(day(D, -i), { rhr: [60, 62, 64, 60, 62, 64, 62][i - 1] ?? 0 });
    await daily("rhr", day(D, -1), 500);
    await daily("rhr", D, 65);
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect((await row(D))?.z_rhr).toBeCloseTo(3 / Math.sqrt(16 / 6), 9);
  });

  it("includes D-28, handles sparse and longer histories, and keeps sibling z-scores when one is missing", async () => {
    const days = [28, 20, 15, 10, 5, 3, 1];
    for (const [i, k] of days.entries()) await summary(day(D, -k), { rhr: [60, 62, 64, 60, 62, 64, 62][i] ?? 0, sleep_min: 420, ln_rmssd: 3 });
    await daily("rhr", D, 65);
    await daily("hrv_rmssd", D, 30);
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect(await row(D)).toEqual(expect.objectContaining({ z_rhr: expect.closeTo(3 / Math.sqrt(16 / 6), 9) as unknown, z_ln_rmssd: null, z_sleep: null, readiness_proxy: null }));
    const xs = [60, 62, 64, 60, 62, 64, 62, 70, 58, 61];
    await env.DB.prepare("DELETE FROM daily_summary").run();
    for (const [i, x] of xs.entries()) await summary(day(D, -(i + 1)), { rhr: x });
    await recomputeDailySummary(env.DB, D, D, NOW);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1));
    expect((await row(D))?.z_rhr).toBeCloseTo((65 - mean) / sd, 9);
  });

  it("computes each metric's baseline from its own population", async () => {
    for (let i = 1; i <= 9; i++) {
      await summary(day(D, -i), { rhr: i <= 8 ? 60 + (i % 3) : null, ln_rmssd: i <= 7 ? 3 + i / 10 : null, sleep_min: i <= 6 ? 400 + i : null });
    }
    await daily("rhr", D, 65);
    await daily("hrv_rmssd", D, 25);
    await sleep("t", `${day(D, -1)}T22:00:00Z`, `${D}T05:00:00Z`, D, { asleep: 380, in_bed: 420 });
    await recomputeDailySummary(env.DB, D, D, NOW);
    const r = await row(D);
    expect(r?.z_rhr).not.toBeNull();
    expect(r?.z_ln_rmssd).not.toBeNull();
    expect(r?.z_sleep).toBeNull();
    expect(r?.readiness_proxy).toBeNull();
  });

  it("clears z-scores when today stays but the history becomes ineligible", async () => {
    for (let i = 1; i <= 7; i++) await summary(day(D, -i), { rhr: 60 + i });
    await daily("rhr", D, 65);
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect((await row(D))?.z_rhr).not.toBeNull();
    await env.DB.prepare("DELETE FROM daily_summary WHERE local_date = ?").bind(day(D, -1)).run();
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect((await row(D))?.z_rhr).toBeNull();
    await env.DB.prepare("UPDATE daily_summary SET rhr = 60 WHERE local_date < ?").bind(D).run();
    await summary(day(D, -1), { rhr: 60 });
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect((await row(D))?.z_rhr).toBeNull();
  });

  it("replays identical inputs into an identical table", async () => {
    await history([60, 62, 64, 60, 62, 64, 62], [40, 40, 50, 50, 45, 45, 45], [400, 420, 440, 400, 420, 440, 420]);
    await daily("rhr", D, 65);
    await recomputeDailySummary(env.DB, day(D, -10), D, NOW);
    const first = await snapshot();
    await recomputeDailySummary(env.DB, day(D, -10), D, NOW);
    expect(await snapshot()).toEqual(first);
  });

  it("gives null z when today's value is missing even with a full history", async () => {
    for (let i = 1; i <= 7; i++) await summary(day(D, -i), { rhr: 60 + i });
    await recomputeDailySummary(env.DB, D, D, NOW);
    expect((await row(D))?.z_rhr).toBeNull();
  });

  it("uses summaries computed earlier in the same call (oldest date first)", async () => {
    await history([60, 62, 64, 60, 62, 64, 62], [40, 40, 50, 50, 45, 45, 45], [400, 420, 440, 400, 420, 440, 420]);
    await daily("rhr", D, 65);
    await recomputeDailySummary(env.DB, day(D, -7), D, NOW);
    expect((await row(D))?.z_rhr).toBeCloseTo(3 / Math.sqrt(16 / 6), 9);
  });
});
