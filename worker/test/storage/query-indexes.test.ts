import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { loadDayTable, resolveRange } from "../../src/mcp/tools/insights/units";

beforeAll(async () => {
  // loadDayTable reads the start offset from 0016; it is recorded, so the later full apply skips it.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(m => m.name < "0014_query_indexes.sql" || m.name === "0016_sleep_start_offset.sql"));
});

it("uses range searches for workout end times, audit retention and bounded event dates", async () => {
  const now = Date.parse("2026-10-22T08:00:00Z") / 1000;
  const range = resolveRange({ start: "2026-10-01", end: "2026-10-21" }, now, "Europe/Madrid");
  let query = "";
  await loadDayTable({ prepare: (sql: string) => {
    query = sql;
    return env.DB.prepare(sql);
  } } as D1Database, range, now);
  const bindings = [range.fetchStart, range.fetchEnd, now];
  const plan = async (sql: string, args: (string | number)[]) =>
    (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map(r => r.detail).join("\n");
  const housekeeping = "DELETE FROM audit_log WHERE ts < ?";
  expect(await plan(query, bindings)).toMatch(/SCAN w\b/);
  expect(await plan(housekeeping, [now - 90 * 86400])).toMatch(/SCAN audit_log\b/);

  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const after = await plan(query, bindings);
  expect(after).toMatch(/SEARCH w USING COVERING INDEX ix_workout_end \(end_ts>\? AND end_ts<\?\)/);
  expect(after).toMatch(/SEARCH event USING INDEX ix_event_date \(local_date>\? AND local_date<\?\)/);
  expect(after).toMatch(/SEARCH event USING INDEX ix_event_tracker_date \(tracker_id=\?\)/);
  expect(await plan(housekeeping, [now - 90 * 86400])).toMatch(/SEARCH audit_log USING INDEX ix_audit_log_ts \(ts<\?\)/);
});
