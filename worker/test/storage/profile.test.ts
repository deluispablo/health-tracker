import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("T35 AC1 adds the exact profile tables and preserves rows across consecutive migration replays", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const columns = async (table: string) => (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results;
  expect((await columns("profile")).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
    { name: "key", type: "TEXT", notnull: 0, pk: 1 },
    { name: "value", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
  ]);
  expect((await columns("weight_log")).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
    { name: "local_date", type: "TEXT", notnull: 0, pk: 1 },
    { name: "kg", type: "REAL", notnull: 1, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
  ]);
  await env.DB.prepare("INSERT INTO profile VALUES ('smoker', 'false', 1)").run();
  await env.DB.prepare("INSERT INTO weight_log VALUES ('2000-01-01', 30, 1)").run();
  for (let i = 0; i < 2; i++) {
    await env.DB.prepare("DELETE FROM d1_migrations WHERE name = '0009_profile.sql'").run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect((await env.DB.prepare("SELECT * FROM profile").all()).results).toEqual([{ key: "smoker", value: "false", updated_at: 1 }]);
    expect((await env.DB.prepare("SELECT * FROM weight_log").all()).results).toEqual([{ local_date: "2000-01-01", kg: 30, updated_at: 1 }]);
  }
});
