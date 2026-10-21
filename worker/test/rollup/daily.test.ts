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
async function sleep(id: string, start: string, end: string, localDate: string, f: Partial<Record<string, number>> = {}) {
  await env.DB.prepare(`INSERT INTO sleep_session (source_id, start_ts, end_ts, tz_offset_min, local_date, is_nap, minutes_asleep,
    minutes_in_bed, efficiency, deep_min, rem_min, light_min, awake_min, latency_min, updated_at) VALUES (?, ?, ?, 120, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .bind(id, at(start), at(end), localDate, f.is_nap ?? 0, f.asleep ?? null, f.in_bed ?? null, f.eff ?? null, f.deep ?? null,
      f.rem ?? null, f.light ?? null, f.awake ?? null, f.latency ?? null).run();
}
async function minute(ts: number, tz = 120, metric = "hr") {
  await env.DB.prepare("INSERT INTO metric_minute (metric, ts, tz_offset_min, value) VALUES (?, ?, ?, 60)").bind(metric, ts, tz).run();
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
    await expect(recomputeDailySummary(env.DB, "2025-01-01", "2026-01-01", NOW)).resolves.toBe(366);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM daily_summary WHERE local_date < '2025-01-01'").first<{ n: number }>())?.n).toBe(0);
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

  it("uses summaries computed earlier in the same call (oldest date first)", async () => {
    await history([60, 62, 64, 60, 62, 64, 62], [40, 40, 50, 50, 45, 45, 45], [400, 420, 440, 400, 420, 440, 420]);
    await daily("rhr", D, 65);
    await recomputeDailySummary(env.DB, day(D, -7), D, NOW);
    expect((await row(D))?.z_rhr).toBeCloseTo(3 / Math.sqrt(16 / 6), 9);
  });
});
