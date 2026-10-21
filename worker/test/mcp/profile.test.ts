import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { healthProfile, healthSetProfile } from "../../src/mcp/tools/profile";

const options = { now: Date.parse("2026-12-31T23:30:00Z") / 1000, tz: "Europe/Madrid" };
const empty = {
  birth_year: null, sex: null, height_cm: null, weight_kg: null, weight_date: null,
  step_goal: 7000, sleep_goal_min: 450, max_hr: null, max_hr_source: null,
  smoker: null, age: null, weight_history: [],
};
const read = () => healthProfile(env.DB, options);
const set = (args: Record<string, unknown>) => healthSetProfile(env.DB, args, options);
const stored = async () => ({
  profile: (await env.DB.prepare("SELECT * FROM profile ORDER BY key").all()).results,
  weights: (await env.DB.prepare("SELECT * FROM weight_log ORDER BY local_date").all()).results,
});
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { await env.DB.batch([env.DB.prepare("DELETE FROM profile"), env.DB.prepare("DELETE FROM weight_log")]); });

describe("T35 AC2 profile reads", () => {
  it("returns the exact empty shape without persisting read defaults", async () => {
    expect(await read()).toEqual(empty);
    expect(await stored()).toEqual({ profile: [], weights: [] });
  });

  it("uses the owner's local year, estimates max HR, and preserves measured HR and false", async () => {
    expect(await set({ birth_year: 1920, smoker: false })).toEqual({ ...empty,
      birth_year: 1920, age: 107, max_hr: 133, max_hr_source: "estimated", smoker: false });
    expect(await healthProfile(env.DB, { ...options, tz: "America/Los_Angeles" })).toMatchObject({ age: 106, max_hr: 134 });
    expect(await set({ max_hr: 120 })).toMatchObject({ max_hr: 120, max_hr_source: "measured", smoker: false });
  });

  it.each(["not-json", '"7000"', "true", "{}", "999999"])("treats corrupt stored values %s as unset and permits unrelated writes", async (value) => {
    await env.DB.batch(["birth_year", "step_goal", "sleep_goal_min", "max_hr", "height_cm", "sex", "smoker"].map((key) =>
      env.DB.prepare("INSERT INTO profile VALUES (?, ?, 1)").bind(key, value)));
    const expected = { ...empty, ...(value === "true" ? { smoker: true } : {}) };
    expect(await read()).toEqual(expected);
    expect(await set({ weight_kg: 30 })).toEqual({ ...expected, weight_kg: 30, weight_date: "2027-01-01",
      weight_history: [{ date: "2027-01-01", kg: 30 }] });
  });

  it("uses defaults/estimate for invalid stored goals and max HR with a valid birth year", async () => {
    await set({ birth_year: 1920 });
    await env.DB.prepare("INSERT INTO profile VALUES ('max_hr', 'true', 1), ('step_goal', '{}', 1), ('sleep_goal_min', '1', 1)").run();
    expect(await read()).toMatchObject({ step_goal: 7000, sleep_goal_min: 450, max_hr: 133, max_hr_source: "estimated" });
  });

  it("filters invalid weights before selecting the newest 90 by date", async () => {
    const weights = Array.from({ length: 92 }, (_, i) => ({ date: new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10), kg: 30 }));
    await env.DB.batch([
      ...weights.map(({ date, kg }) => env.DB.prepare("INSERT INTO weight_log VALUES (?, ?, 1)").bind(date, kg)),
      ...[["garbage", 30], ["2026-02-30", 30], ["2026-12-31", "bad"], ["2026-12-30", 301], ["2026-12-29", 999999]]
        .map(([date, kg]) => env.DB.prepare("INSERT INTO weight_log VALUES (?, ?, 1)").bind(date, kg)),
    ]);
    // D1's JSON transport cannot represent non-finite values; inject at the read boundary.
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("FROM weight_log")) return statement;
        return { all: async () => {
          const result = await statement.all<{ local_date: string; kg: number }>();
          return { ...result, results: result.results.map((row) => ({ ...row, kg: row.kg === 999999 ? Infinity : row.kg })) };
        } };
      };
      throw new Error(`unexpected operation ${String(property)}`);
    } });
    const expected = weights.reverse().slice(0, 90);
    expect(await healthProfile(db, options)).toEqual({ ...empty, weight_kg: 30, weight_date: expected[0].date, weight_history: expected });
    expect(await set({ smoker: false })).toMatchObject({ smoker: false, weight_history: expected });
  });

  it.each(["profile", "weight_log"])("propagates a D1 %s read failure", async (table) => {
    const failure = new Error("private read sentinel");
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.includes(`FROM ${table}`)) throw failure;
        return target.prepare(sql);
      };
      throw new Error(`unexpected operation ${String(property)}`);
    } });
    await expect(healthProfile(db, options)).rejects.toBe(failure);
  });
});

describe("T35 AC3 profile updates", () => {
  it("updates partially, rounds decimals, encodes JSON, clears sex and uses one atomic batch", async () => {
    const batch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements));
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return batch;
      if (property === "prepare") return target.prepare.bind(target);
      throw new Error(`unexpected operation ${String(property)}`);
    } });
    expect(await healthSetProfile(db, { birth_year: 2027, sex: "female", height_cm: 100.16,
      weight_kg: 30.16, step_goal: 1000, sleep_goal_min: 240, max_hr: 120, smoker: false }, options))
      .toEqual({ birth_year: 2027, sex: "female", height_cm: 100.2, weight_kg: 30.2, weight_date: "2027-01-01",
        step_goal: 1000, sleep_goal_min: 240, max_hr: 120, max_hr_source: "measured", smoker: false, age: 0,
        weight_history: [{ date: "2027-01-01", kg: 30.2 }] });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT value FROM profile WHERE key = 'smoker'").first("value")).toBe("false");
    expect(await env.DB.prepare("SELECT value FROM profile WHERE key = 'sex'").first("value")).toBe('"female"');
    expect((await stored()).profile).toEqual(expect.arrayContaining([expect.objectContaining({ updated_at: options.now })]));
    expect(await set({ sex: null })).toMatchObject({ sex: null, height_cm: 100.2, smoker: false });
    expect(await set({ sex: "male", height_cm: 250, weight_kg: 300, step_goal: 50000, sleep_goal_min: 720, max_hr: 230, smoker: true }))
      .toMatchObject({ sex: "male", height_cm: 250, weight_kg: 300, step_goal: 50000, sleep_goal_min: 720, max_hr: 230, smoker: true });
  });

  it("upserts dated weights without changing which date is latest; explicit dates survive midnight retries", async () => {
    await set({ weight_kg: 300, date: "2024-02-29" });
    await set({ weight_kg: 30, date: "2000-01-01" });
    const args = { weight_kg: 30, date: "2024-02-29" };
    const result = await set(args);
    expect(result).toEqual({ ...empty, weight_kg: 30, weight_date: "2024-02-29",
      weight_history: [{ date: "2024-02-29", kg: 30 }, { date: "2000-01-01", kg: 30 }] });
    expect(await healthSetProfile(env.DB, args, { ...options, now: options.now + 86400 })).toEqual(result);
    expect(await set({ weight_kg: 300 })).toMatchObject({ weight_date: "2027-01-01", weight_kg: 300 });
  });

  it("uses local today on each side of midnight and keeps an explicit date stable on retry", async () => {
    const before = { ...options, now: Date.parse("2026-12-31T22:59:00Z") / 1000 };
    const after = { ...options, now: before.now + 120 };
    expect(await healthSetProfile(env.DB, { weight_kg: 30 }, before)).toMatchObject({ weight_date: "2026-12-31" });
    expect(await healthSetProfile(env.DB, { weight_kg: 30, date: "2026-12-31" }, after))
      .toMatchObject({ weight_history: [{ date: "2026-12-31", kg: 30 }] });
    expect(await healthSetProfile(env.DB, { weight_kg: 30 }, after))
      .toMatchObject({ weight_history: [{ date: "2027-01-01", kg: 30 }, { date: "2026-12-31", kg: 30 }] });
  });

  const ranges = { birth_year: [1920, 2027], height_cm: [100, 250], weight_kg: [30, 300],
    step_goal: [1000, 50000], sleep_goal_min: [240, 720], max_hr: [120, 230] };
  for (const [field, [min, max]] of Object.entries(ranges)) {
    it.each([min - 1, max + 1, String(min), NaN, Infinity, -Infinity, true, {}, null])(`rejects invalid ${field} %j before D1`, async (value) => {
      const prepare = vi.fn();
      const db = { prepare } as unknown as D1Database;
      const result = healthSetProfile(db, { [field]: value }, options);
      await expect(result).rejects.toBeInstanceOf(RangeError);
      await expect(result).rejects.toThrow(new RegExp(`${field}.*${String(min)}.*${String(max)}`));
      expect(prepare).not.toHaveBeenCalled();
    });
  }
  it.each(["birth_year", "step_goal", "sleep_goal_min", "max_hr"])("rejects fractional %s", async (field) => {
    await expect(set({ [field]: ranges[field as keyof typeof ranges][0] + 0.5 })).rejects.toThrow(RangeError);
  });
  it.each([
    [{}, /field/], [{ mystery: 1 }, /mystery/], [{ date: "2000-01-01" }, /date.*weight_kg/],
    [{ sex: "unknown" }, /sex.*female.*male.*null/], [{ smoker: 0 }, /smoker.*boolean/],
    ...["2000-1-01", "2026-02-29", "2026-02-30", "1999-12-31", "2027-01-02", "garbage", null, 1]
      .map((date) => [{ weight_kg: 30, date }, /date.*2000-01-01.*2027-01-01/]),
  ] as [Record<string, unknown>, RegExp][])("refuses %j without modifying data", async (args, message) => {
    const before = await stored();
    await expect(set(args)).rejects.toThrow(message);
    expect(await stored()).toEqual(before);
  });

  it("propagates batch failure and rolls back the entire profile/weight update", async () => {
    await set({ smoker: false });
    const before = await stored();
    await env.DB.prepare("CREATE TRIGGER fail_profile_weight BEFORE INSERT ON weight_log BEGIN SELECT RAISE(ABORT, 'write sentinel'); END").run();
    try {
      await expect(set({ smoker: true, weight_kg: 30 })).rejects.toThrow("write sentinel");
      expect(await stored()).toEqual(before);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_profile_weight").run();
    }
  });

  it("propagates a read failure after a successful batch", async () => {
    const failure = new Error("read after write sentinel");
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return target.batch.bind(target);
      if (property === "prepare") return (sql: string) => {
        if (/SELECT/.test(sql)) throw failure;
        return target.prepare(sql);
      };
      throw new Error(`unexpected operation ${String(property)}`);
    } });
    await expect(healthSetProfile(db, { smoker: false }, options)).rejects.toBe(failure);
  });
});
