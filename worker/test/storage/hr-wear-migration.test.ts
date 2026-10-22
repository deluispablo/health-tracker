import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < "0013_hr_wear_unknown.sql"));
});

it("clears historical zero HR wear without changing known coverage or other summary fields", async () => {
  await env.DB.prepare(`INSERT INTO daily_summary (local_date, hr_wear_min, steps, computed_at) VALUES
    ('2026-07-01', 0, 1234, 1),
    ('2026-07-02', 600, 2345, 2),
    ('2026-07-03', NULL, 3456, 3)`).run();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect((await env.DB.prepare(
    "SELECT local_date, hr_wear_min, steps, computed_at FROM daily_summary ORDER BY local_date",
  ).all()).results).toEqual([
    { local_date: "2026-07-01", hr_wear_min: null, steps: 1234, computed_at: 1 },
    { local_date: "2026-07-02", hr_wear_min: 600, steps: 2345, computed_at: 2 },
    { local_date: "2026-07-03", hr_wear_min: null, steps: 3456, computed_at: 3 },
  ]);
});
