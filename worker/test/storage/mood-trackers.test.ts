import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const emotions = ["genial", "bien", "tranquilo", "cansado", "estresado", "ansioso", "triste", "enfadado"];
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe("T33 AC3 mood tracker migration", () => {
  it("seeds exactly eight named count trackers with default and limits 1", async () => {
    const rows = (await env.DB.prepare("SELECT * FROM tracker WHERE id LIKE 'mood_%' ORDER BY id").all()).results;
    expect(rows).toEqual(emotions.map((emotion) => ({ id: `mood_${emotion}`, name: `Ánimo: ${emotion}`,
      unit: "u", value_type: "count", default_value: 1, min_value: 1, max_value: 1,
      archived_at: null, created_at: expect.any(Number) as unknown })).sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("replays INSERT OR IGNORE without changing configured or archived trackers, events or schema", async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0007_mood_trackers.sql");
    expect(migration).toBeDefined();
    if (!migration) throw new Error("missing mood migration");
    for (const query of migration.queries) expect(query.trim()).toMatch(/^INSERT OR IGNORE INTO tracker\b/i);
    await env.DB.batch([
      env.DB.prepare("UPDATE tracker SET name = 'Edited', unit = 'custom', default_value = 3, min_value = NULL, max_value = 9, created_at = 17 WHERE id = 'mood_bien'"),
      env.DB.prepare("UPDATE tracker SET archived_at = 0 WHERE id = 'mood_triste'"),
      env.DB.prepare("INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at) VALUES ('mood-import', 'mood_triste', 1, 0, '2000-01-01', 7, 'import', 2)"),
    ]);
    const snapshot = async () => [
      (await env.DB.prepare("SELECT * FROM tracker ORDER BY id").all()).results,
      (await env.DB.prepare("SELECT * FROM event ORDER BY id").all()).results,
      (await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results,
    ];
    const before = await snapshot();
    for (let i = 0; i < 2; i++) {
      await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));
      expect(await snapshot()).toEqual(before);
    }
  });
});
