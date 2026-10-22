import { expect, it, vi } from "vitest";

it("180-day contrast JS path takes ≤20 ms cold and ≤8 ms warm (median of five)", async () => {
  vi.resetModules();
  const { healthContrast } = await import("../../src/mcp/tools/insights/contrast");
  const start = "2026-04-04", end = "2026-09-30";
  const deps = { nowSec: Date.parse("2026-10-01T08:00:00Z") / 1000, tz: "Europe/Madrid" };
  let seed = 20261022;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  // Raw SELECT rows: all 224 calendar days populated, including the 43-day baseline.
  const rows = Array.from({ length: 224 }, (_, i) => {
    const ts = Date.parse(start + "T00:00:00Z") / 1000 + (i - 43) * 86400;
    const row: Record<string, string | number | null> = {
      local_date: new Date(ts * 1000).toISOString().slice(0, 10),
      active: 1, previous_active: 1, hr_wear_min: 1440,
      steps: 3500 + random() * 7000, workout_min: random() * 60,
      bed: ts - 8 * 3600, bedtime: 300 + random() * 120,
      sleep_min: 380 + random() * 100, deep_min: 60 + random() * 60,
      rem_min: 60 + random() * 60, light_min: 200 + random() * 60,
      awake_min: random() * 40, efficiency: 85 + random() * 10,
      latency_min: random() * 30, awakenings: Math.floor(random() * 5),
      rhr: 60 + random() * 8, hrv: 3.6 + random() * 0.4,
      spo2_avg: 96 + random() * 3, skin_temp_dev: random() * 0.2,
      resp_rate: 14 + random() * 2, tests_last_24h: 0,
      cigarettes: 1, caffeine: 100, alcohol: 0,
      mood_bien: 1, mood_cansado: i % 2,
    };
    for (const tracker of ["cigarettes", "caffeine", "alcohol", "mood"]) {
      row[`first_${tracker}_ts`] = ts - (i + 1) * 86400;
      row[`first_${tracker}_bday`] = "2026-02-19";
    }
    return row;
  });
  let reads = 0, writes = 0;
  const all = () => { reads++; return Promise.resolve({ results: rows }); };
  const run = () => { writes++; return Promise.resolve({ success: true }); };
  // Stub only SQL I/O; loadDayTable, models, sensitivity legs and response shaping stay real.
  const db = { prepare: (sql: string) => ({ bind: () =>
    sql.includes("WITH RECURSIVE") ? { all } : { run } }) } as unknown as D1Database;
  const where = Array.from({ length: 3 }, () => ({ metric: "steps", scale: "value", op: ">=", value: 0 }));
  const args = { start, end, timing: "following_night",
    a: { where: [...where, { metric: "steps", op: ">=", value: 7000 }] },
    b: { where: [...where, { metric: "steps", op: "<", value: 7000 }] } };

  const measure = async () => {
    const before = performance.now();
    const result = await healthContrast(db, args, deps);
    const serialized = JSON.stringify(result);
    const elapsed = performance.now() - before;
    expect(result.tests).toBe(16);
    expect(result.rows).toHaveLength(15);
    for (const row of result.rows as { n_a: number; n_b: number; diff: number | null; sensitivity: unknown }[]) {
      expect(row.n_a).toBeGreaterThan(30);
      expect(row.n_b).toBeGreaterThan(30);
      expect(row.diff).not.toBeNull();
      expect(row.sensitivity).toHaveProperty("alcohol");
    }
    expect(result.truncated).toBe(true);
    expect(serialized.length).toBeLessThanOrEqual(20000);
    return elapsed;
  };
  // First call after a fresh import; no priming or discarded samples.
  const cold = await measure();
  const warm: number[] = [];
  for (let i = 0; i < 5; i++) warm.push(await measure());
  const median = warm.sort((a, b) => a - b)[2];
  console.info(`health_contrast JS: cold=${cold.toFixed(2)} ms; warm median=${median.toFixed(2)} ms`);
  expect(reads).toBe(6);
  expect(writes).toBe(6);
  expect(cold).toBeLessThanOrEqual(20);
  expect(median).toBeLessThanOrEqual(8);
});
