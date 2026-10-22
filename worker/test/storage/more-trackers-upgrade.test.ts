import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { recomputeTrackerDaily } from "../../src/rollup/trackers";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < "0015_more_trackers.sql"));
});

it("upgrades 0014 watch surfaces while preserving custom and archived new-id configs, events and rollups", async () => {
  await env.DB.prepare(`INSERT INTO tracker (id, name, unit, value_type, default_value, created_at)
    VALUES ('custom', 'Custom', 'u', 'count', 1, 1)`).run();
  // These ids belonged to the owner before they became seeded watch trackers.
  await env.DB.prepare(`INSERT INTO tracker (id, name, unit, value_type, default_value, min_value, max_value, created_at, archived_at) VALUES
    ('water', 'My water', 'litres', 'amount', 0.5, 0.1, 2, 123, NULL),
    ('melatonin', 'Archived dose', 'drops', 'count', NULL, 1, 9, 124, 125),
    ('protein', 'My protein', 'scoops', 'amount', 2, NULL, 5, 126, NULL),
    ('creatine', 'Old creatine', 'mg', 'amount', 3000, 100, 9000, 127, 128)`).run();
  await env.DB.prepare(`INSERT INTO event (id, tracker_id, ts, tz_offset_min, local_date, value, note, origin, created_at, deleted_at) VALUES
    ('old-water', 'water', 100, 0, '2026-10-20', 0.75, 'preserve', 'import', 123, NULL),
    ('old-dose', 'melatonin', 200, 0, '2026-10-20', 3, NULL, 'mcp', 124, NULL),
    ('old-protein', 'protein', 300, 0, '2026-10-20', 1.5, NULL, 'artifact', 126, NULL),
    ('old-creatine', 'creatine', 400, 0, '2026-10-20', 3000, NULL, 'mcp', 127, NULL)`).run();
  await recomputeTrackerDaily(env.DB, "2026-10-20", "2026-10-20");
  const events = (await env.DB.prepare("SELECT * FROM event ORDER BY id").all()).results;
  const rollups = (await env.DB.prepare("SELECT * FROM tracker_daily ORDER BY tracker_id").all()).results;
  expect(events).toHaveLength(4);
  expect(rollups).toHaveLength(4);
  const before = (await env.DB.prepare("SELECT * FROM tracker ORDER BY id").all()).results;
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const rows = (await env.DB.prepare("SELECT * FROM tracker ORDER BY sort, id").all()).results;
  for (const row of before) expect(rows.find((t) => t.id === row.id)).toMatchObject(row);
  expect((await env.DB.prepare("SELECT * FROM event ORDER BY id").all()).results).toEqual(events);
  expect((await env.DB.prepare("SELECT * FROM tracker_daily ORDER BY tracker_id").all()).results).toEqual(rollups);
  expect(rows.find((t) => t.id === "custom")).toMatchObject({ surface: null, sort: null });
  const ids = ["caffeine", "cigarettes", "alcohol", "mood_genial", "mood_bien", "mood_tranquilo", "mood_cansado",
    "mood_estresado", "mood_ansioso", "mood_triste", "mood_enfadado", "water", "melatonin", "protein", "creatine"];
  expect(rows.filter((t) => t.surface !== null).map((t) => t.id)).toEqual(ids);
  for (const [i, id] of ids.entries()) {
    expect(rows.find((t) => t.id === id)).toMatchObject({ surface: i < 12 ? "face" : "tile", sort: i });
  }
  await expect(env.DB.prepare("UPDATE tracker SET surface = 'unknown' WHERE id = 'water'").run()).rejects.toThrow();
});
