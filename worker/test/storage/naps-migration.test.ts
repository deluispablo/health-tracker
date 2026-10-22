import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recomputeDailySummary } from "../../src/rollup/daily";

const at = (iso: string) => Date.parse(iso) / 1000;
async function seed(id: string, date: string, time = "13:37:00", minutes: number | null = 74, offset = 120, isNap = 0, elapsed = 74) {
  const start = at(`2026-07-19T${time}Z`);
  await env.DB.prepare(`INSERT INTO sleep_session
    (source_id, start_ts, end_ts, tz_offset_min, local_date, is_nap, minutes_in_bed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).bind(id, start, start + elapsed * 60, offset, date, isNap, minutes).run();
}
const dirty = async () => (await env.DB.prepare("SELECT local_date, version FROM rollup_dirty ORDER BY local_date").all()).results;
const sequence = () => env.DB.prepare("SELECT n FROM rollup_seq WHERE id = 1").first("n");
const upgrade = () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name <= "0006_daytime_naps.sql"));

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name <= "0005_rollup_dirty.sql"));
});

beforeEach(async () => {
  await env.DB.batch([
    ...["sleep_stage", "sleep_session", "rollup_dirty"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    env.DB.prepare("UPDATE rollup_seq SET n = 0 WHERE id = 1"),
    env.DB.prepare("DELETE FROM d1_migrations WHERE name > '0005_rollup_dirty.sql'"),
  ]);
});

describe("T25 AC2/AC3 daytime nap migration", () => {
  it("leaves an empty database's sequence at zero", async () => {
    await upgrade();
    expect(await sequence()).toBe(0);
    expect(await dirty()).toEqual([]);
  });

  it("reclassifies qualifying rows and upserts each changed valid date with a fresh version", async () => {
    const changed = [
      ["probe", "2026-07-19", "13:37:00", 74, 120],
      ["same-date", "2026-07-19", "14:00:00", 29, 120],
      ["lower", "2026-07-20", "07:00:00", 89, 120],
      ["upper", "2026-07-21", "17:59:59", 179, 120],
      ["negative-offset", "2026-07-22", "20:37:00", 74, -300],
      ["half-hour", "2028-02-29", "03:30:00", 74, 330],
      ...["garbage", "2026-02-30", "2026-2-01", "1999-12-31", "2100-01-01"]
        .map((date) => [`invalid-${date}`, date, "13:37:00", 74, 120] as const),
    ] as const;
    for (const [id, date, time, minutes, offset] of changed) await seed(id, date, time, minutes, offset);
    await env.DB.batch([
      env.DB.prepare("UPDATE rollup_seq SET n = 7 WHERE id = 1"),
      env.DB.prepare("INSERT INTO rollup_dirty VALUES ('2026-07-19', 3), ('2026-06-01', 6)"),
    ]);
    await upgrade();
    expect.soft((await env.DB.prepare("SELECT source_id, is_nap FROM sleep_session ORDER BY source_id").all()).results)
      .toEqual(changed.map(([source_id]) => ({ source_id, is_nap: 1 })).sort((a, b) => a.source_id.localeCompare(b.source_id)));
    expect.soft(await sequence()).toBe(8);
    expect.soft(await dirty()).toEqual([
      { local_date: "2026-06-01", version: 6 },
      ...["2026-07-19", "2026-07-20", "2026-07-21", "2026-07-22", "2028-02-29"]
        .map((local_date) => ({ local_date, version: 8 })),
    ]);
  });

  it("leaves already-clean rows, dirty marks and sequence unchanged", async () => {
    await seed("short-night", "2026-07-19", "01:10:00", 90);
    await seed("long-night", "2026-07-19", "21:00:00", 420);
    await seed("before", "2026-07-19", "06:59:59", 90);
    await seed("after", "2026-07-19", "18:00:00", 90);
    await seed("threshold", "2026-07-19", "13:37:00", 180);
    await seed("null", "2026-07-19", "13:37:00", null);
    await seed("local-night", "2026-07-19", "10:00:00", 74, -480);
    await seed("already-nap", "2026-07-19", "13:37:00", 74, 120, 1);
    await env.DB.batch([
      env.DB.prepare("UPDATE rollup_seq SET n = 7 WHERE id = 1"),
      env.DB.prepare("INSERT INTO rollup_dirty VALUES ('2026-07-19', 6)"),
    ]);
    const before = (await env.DB.prepare("SELECT * FROM sleep_session ORDER BY source_id").all()).results;
    await upgrade();
    expect((await env.DB.prepare("SELECT * FROM sleep_session ORDER BY source_id").all()).results).toEqual(before);
    expect(await sequence()).toBe(7);
    expect(await dirty()).toEqual([{ local_date: "2026-07-19", version: 6 }]);
  });
});

describe("daytime nap migration v2", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < "0011_daytime_naps_v2.sql"));
  });

  it("reclassifies missing-duration naps, marks affected dates and clears their main sleep on recompute", async () => {
    await seed("july", "2026-07-19", "13:37:00", null);
    await seed("august", "2026-08-07", "14:11:00", null, 120, 0, 49);
    await seed("september", "2026-09-22", "14:34:00", null, 120, 0, 61);
    await seed("october", "2026-10-21", "14:42:00", null, 120, 0, 29);
    await seed("same-date", "2026-07-19", "14:00:00", null);
    await seed("negative-offset", "2026-07-20", "20:37:00", null, -300);
    await seed("half-hour", "2026-07-21", "03:30:00", null, 330);
    await seed("invalid-date", "2026-02-30", "13:37:00", null);
    await env.DB.prepare("UPDATE sleep_session SET minutes_asleep = 24").run();
    await recomputeDailySummary(env.DB, "2026-07-19", "2026-07-19", 1);
    expect(await env.DB.prepare("SELECT sleep_min FROM v_daily WHERE local_date = '2026-07-19'").first("sleep_min")).toBe(24);
    await env.DB.batch([
      env.DB.prepare("UPDATE rollup_seq SET n = 7 WHERE id = 1"),
      env.DB.prepare("INSERT INTO rollup_dirty VALUES ('2026-07-19', 3), ('2026-06-01', 6)"),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect((await env.DB.prepare("SELECT DISTINCT is_nap FROM sleep_session").all()).results).toEqual([{ is_nap: 1 }]);
    expect(await sequence()).toBe(8);
    expect(await dirty()).toEqual([
      { local_date: "2026-06-01", version: 6 },
      ...["2026-07-19", "2026-07-20", "2026-07-21", "2026-08-07", "2026-09-22", "2026-10-21"]
        .map((local_date) => ({ local_date, version: 8 })),
    ]);
    await recomputeDailySummary(env.DB, "2026-07-19", "2026-07-19", 2);
    expect(await env.DB.prepare("SELECT sleep_min, bedtime_local, waketime_local FROM v_daily WHERE local_date = '2026-07-19'").first())
      .toEqual({ sleep_min: null, bedtime_local: null, waketime_local: null });
    await env.DB.prepare("DELETE FROM d1_migrations WHERE name = '0011_daytime_naps_v2.sql'").run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await sequence()).toBe(8);
  });

  it("preserves night sleep, long sleeps, known durations and existing naps without dirtying dates", async () => {
    await seed("after-midnight", "2026-07-19", "23:10:00", null);
    await seed("late-night", "2026-07-19", "01:10:00", null, 120, 0, 420);
    await seed("before-daytime", "2026-07-19", "06:59:59", null);
    await seed("after-daytime", "2026-07-19", "18:00:00", null);
    await seed("long-daytime", "2026-07-19", "13:37:00", null, 120, 0, 420);
    await seed("threshold", "2026-07-19", "13:37:00", null, 120, 0, 180);
    await seed("known-long-duration", "2026-07-19", "13:37:00", 420);
    await seed("already-nap", "2026-07-19", "13:37:00", null, 120, 1);
    const before = (await env.DB.prepare("SELECT * FROM sleep_session ORDER BY source_id").all()).results;
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect((await env.DB.prepare("SELECT * FROM sleep_session ORDER BY source_id").all()).results).toEqual(before);
    expect(await sequence()).toBe(0);
    expect(await dirty()).toEqual([]);
  });
});
