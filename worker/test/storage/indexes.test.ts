import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("T21 AC2 hot query indexes on empty tables after migrations", () => {
  const cases = [
    {
      name: "tracker rollup (rollup/trackers.ts)", table: "event", index: "ix_event_date",
      sql: `
      SELECT local_date, tracker_id, SUM(value), COUNT(*),
        SUM(CASE WHEN ((ts + tz_offset_min * 60) % 86400 + 86400) % 86400 >= 18 * 3600
          THEN value ELSE 0 END),
        MIN(ts), MAX(ts)
      FROM event
      WHERE deleted_at IS NULL AND local_date BETWEEN ?1 AND ?2
      GROUP BY local_date, tracker_id
    `,
      bindings: ["2026-10-01", "2026-10-31"],
    },
    {
      name: "health_workouts (mcp/tools/workouts.ts)", table: "workout", index: "ix_workout_date",
      sql: `
    SELECT local_date, type, start_ts, end_ts, tz_offset_min, duration_min, avg_hr, kcal, azm, distance_m
    FROM workout WHERE local_date BETWEEN ? AND ? ORDER BY start_ts, source_id
  `,
      bindings: ["2026-10-01", "2026-10-31"],
    },
    {
      name: "exercise drain (ingest/drain.ts)", table: "workout", index: "ix_workout_start",
      sql: "DELETE FROM workout WHERE source = 'gh' AND start_ts >= ? AND start_ts < ?",
      bindings: [0, 2000000000],
    },
    {
      name: "sleep drain (ingest/drain.ts)", table: "sleep_session", index: "ix_sleep_end",
      sql: "DELETE FROM sleep_session WHERE source = 'gh' AND end_ts >= ? AND end_ts < ?",
      bindings: [0, 2000000000],
    },
    {
      name: "sleep stage subquery (ingest/drain.ts)", table: "sleep_session", index: "ix_sleep_end",
      sql: "SELECT source_id FROM sleep_session WHERE source = 'gh' AND end_ts >= ? AND end_ts < ?",
      bindings: [0, 2000000000],
    },
    {
      name: "health_status latest sleep (mcp/tools/status.ts)", table: "sleep_session", index: "ix_sleep_end",
      sql: `
    SELECT end_ts AS ts, tz_offset_min FROM sleep_session
    WHERE source = 'gh' ORDER BY end_ts DESC LIMIT 1
  `,
      bindings: [],
    },
  ];

  it.each(cases)("$name uses $index without scanning $table", async ({ sql, bindings, table, index }) => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings).all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).toMatch(new RegExp(`\\bINDEX ${index}\\b`));
    expect(plan).not.toMatch(new RegExp(`\\bSCAN ${table}\\b`));
  });
});
