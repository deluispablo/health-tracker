import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

it("seeds water and supplements with their names, units, doses and watch surfaces", async () => {
  const rows = (await env.DB.prepare("SELECT * FROM tracker ORDER BY sort, id").all()).results;
  for (const [id, name, unit, default_value, min_value, max_value, surface, sort] of [
    ["water", "Agua", "ml", 250, 50, 2000, "face", 11],
    ["melatonin", "Melatonina", "mg", 1, 0.1, 10, "tile", 12],
    ["protein", "Batido de proteína", "g", 30, 5, 100, "tile", 13],
    ["creatine", "Creatina", "g", 5, 1, 20, "tile", 14],
  ]) {
    expect(rows.find((row) => row.id === id)).toMatchObject({
      name, unit, default_value, min_value, max_value, surface, sort, value_type: "amount", archived_at: null,
    });
  }
});
