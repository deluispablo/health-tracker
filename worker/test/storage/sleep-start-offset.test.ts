import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

const NAME = "0016_sleep_start_offset.sql";

it("adds a nullable start offset, backfills it from the stored offset and exposes it in v_sleep", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < NAME));
  await env.DB.prepare(`INSERT INTO sleep_session (source_id, start_ts, end_ts, tz_offset_min, local_date, updated_at)
    VALUES ('a', 1, 2, 120, '2026-10-07', 1), ('b', 3, 4, -300, '2026-10-08', 1), ('c', 5, 6, 330, '2026-10-09', 1)`).run();
  const before = (await env.DB.prepare("SELECT * FROM sleep_session ORDER BY source_id").all()).results;
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name <= NAME));
  expect((await env.DB.prepare("SELECT * FROM v_sleep ORDER BY source_id").all()).results)
    .toEqual(before.map((row) => ({ ...row, start_tz_offset_min: row.tz_offset_min })));
  const column = (await env.DB.prepare("PRAGMA table_info(sleep_session)").all<{ name: string; notnull: number }>()).results
    .find((c) => c.name === "start_tz_offset_min");
  expect(column?.notnull).toBe(0);
  await env.DB.prepare(`INSERT INTO sleep_session (source_id, start_ts, end_ts, tz_offset_min, local_date, updated_at)
    VALUES ('d', 7, 8, 60, '2026-10-25', 1)`).run();
  expect(await env.DB.prepare("SELECT start_tz_offset_min FROM sleep_session WHERE source_id = 'd'").first("start_tz_offset_min")).toBeNull();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sleep_session").first("n")).toBe(4);
});
