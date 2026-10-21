import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("T36 AC2 adds the hourly metric through an insert-only replayable migration", async () => {
  const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0008_hourly_steps.sql");
  expect(migration).toBeDefined();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await env.DB.prepare("SELECT metric, unit, agg FROM metric_def WHERE metric = 'steps_h'").first())
    .toEqual({ metric: "steps_h", unit: "count", agg: "sum" });
  const before = (await env.DB.prepare("SELECT * FROM metric_def ORDER BY metric").all()).results;
  for (const query of migration?.queries ?? []) {
    expect(query.replace(/--[^\n]*/g, "").trim()).toMatch(/^INSERT OR IGNORE INTO metric_def/i);
    await env.DB.prepare(query).run();
  }
  expect((await env.DB.prepare("SELECT * FROM metric_def ORDER BY metric").all()).results).toEqual(before);
});
