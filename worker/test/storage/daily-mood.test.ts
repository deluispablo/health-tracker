import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

const MOODS = ["mood_genial", "mood_bien", "mood_tranquilo", "mood_cansado", "mood_estresado", "mood_ansioso", "mood_triste", "mood_enfadado"];

it("T38 AC1 upgrades 0001–0009 and replays 0010 while preserving every prior view column and stored value", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < "0010_daily_mood.sql"));
  expect(await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1").first("name")).toBe("0009_profile.sql");
  const oldColumns = (await env.DB.prepare("PRAGMA table_info(v_daily)").all<{ name: string }>()).results.map((c) => c.name);
  const summaryColumns = (await env.DB.prepare("PRAGMA table_info(daily_summary)").all<{ name: string; type: string }>()).results;
  await env.DB.prepare(`INSERT INTO daily_summary (${summaryColumns.map((c) => c.name).join(", ")})
    VALUES (${summaryColumns.map(() => "?").join(", ")})`)
    .bind(...summaryColumns.map((c, i) => c.name === "local_date" ? "2026-10-05" : c.type === "TEXT" ? "23:15" : i + 0.25)).run();
  await env.DB.prepare("INSERT INTO daily_summary (local_date, computed_at) VALUES ('2026-10-06', 2)").run();
  await env.DB.batch(["cigarettes", "alcohol", "caffeine", ...MOODS].map((tracker, i) => env.DB.prepare(
    "INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES ('2026-10-05', ?, ?, 1, 0)",
  ).bind(tracker, i + 1)));
  await env.DB.prepare("INSERT INTO profile VALUES ('smoker', 'false', 1)").run();
  await env.DB.prepare("INSERT INTO weight_log VALUES ('2026-10-05', 70, 1)").run();
  const snapshot = () => Promise.all(["daily_summary", "tracker_daily", "tracker", "profile", "weight_log"].map(async (table) =>
    (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
  const beforeTables = await snapshot();
  const beforeView = (await env.DB.prepare("SELECT * FROM v_daily ORDER BY local_date").all()).results;
  for (let replay = 0; replay < 3; replay++) {
    if (replay > 0) await env.DB.prepare("DELETE FROM d1_migrations WHERE name = '0010_daily_mood.sql'").run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name <= "0010_daily_mood.sql"));
    const columns = (await env.DB.prepare("PRAGMA table_info(v_daily)").all<{ name: string }>()).results.map((c) => c.name);
    expect(columns).toEqual([...oldColumns, ...MOODS]);
    const rows = (await env.DB.prepare("SELECT * FROM v_daily ORDER BY local_date").all()).results;
    expect(rows.map((row) => Object.fromEntries(oldColumns.map((column) => [column, row[column]])))).toEqual(beforeView);
    expect(rows.map((row) => MOODS.map((mood) => row[mood]))).toEqual([[4, 5, 6, 7, 8, 9, 10, 11], MOODS.map(() => null)]);
    expect(await snapshot()).toEqual(beforeTables);
  }
});
