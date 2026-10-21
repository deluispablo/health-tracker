import { describe, expect, it } from "vitest";
import { viewsOnly } from "../../src/mcp/tools/sqlviews";

function refuses(sql: string, reason: RegExp = /\S/) {
  const result: unknown = viewsOnly(sql);
  expect(result, sql).toMatchObject({ ok: false });
  expect(result, sql).toHaveProperty("reason", expect.stringMatching(reason));
}

function accepts(sql: string) {
  expect(viewsOnly(sql), sql).toEqual({ ok: true });
}

describe("T11 AC3e parser layer allows only the four views and declared CTEs", () => {
  it.each([
    "SELECT 1", "SELECT * FROM v_daily", "SELECT * FROM v_events", "SELECT * FROM v_sleep",
    "SELECT * FROM v_workouts", "SELECT * FROM V_DAILY", 'SELECT * FROM "v_daily"',
    "WITH q AS (SELECT * FROM v_daily) SELECT * FROM q",
    "WITH Q AS (SELECT * FROM v_daily) SELECT * FROM q",
    "WITH q AS (WITH r AS (SELECT * FROM v_events) SELECT * FROM r) SELECT * FROM q",
    "WITH RECURSIVE q(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM q WHERE n < 3) SELECT * FROM q",
    "SELECT * FROM v_daily WHERE local_date IN (WITH z AS (SELECT local_date FROM v_sleep) SELECT * FROM z)",
    "SELECT * FROM v_daily UNION SELECT * FROM v_workouts",
    "SELECT * FROM v_daily d JOIN v_sleep s ON s.local_date = d.local_date",
    "SELECT * FROM v_daily LEFT JOIN (SELECT * FROM v_events) e USING (local_date)",
    "SELECT (SELECT max(rhr) FROM v_daily) AS m",
    "SELECT * FROM v_events AS e, json_each(e.note, '$.a')",
    "SELECT LAG(rhr) OVER (PARTITION BY 1 ORDER BY local_date) FROM v_daily",
    "SELECT strftime('%w', local_date) AS d, avg(sleep_min) FROM v_daily GROUP BY d",
    "SELECT d.local_date, (SELECT AVG(p.rhr) FROM v_daily p WHERE p.local_date BETWEEN date(d.local_date, '-6 days') AND d.local_date) AS rolling_avg FROM v_daily d",
    "SELECT * FROM x WHERE EXISTS (WITH x AS (SELECT 1) SELECT * FROM x)",
  ])("accepts %s", accepts);

  it.each([
    "SELECT * FROM unknown_relation", "SELECT * FROM v_daily JOIN other_table USING (local_date)",
    "SELECT * FROM v_daily WHERE local_date IN (SELECT local_date FROM other_table)",
    "SELECT * FROM temp.v_daily", "SELECT * FROM main.v_daily", 'SELECT * FROM "null".v_daily', "SELECT * FROM null.v_daily", "SELECT 1; SELECT 2",
    'WITH q AS (SELECT * FROM "null".v_daily) SELECT * FROM q',
    'SELECT * FROM v_daily WHERE EXISTS (SELECT * FROM "null".v_sleep)',
    "INSERT INTO v_events VALUES (1)", "WITH q AS (SELECT 1) SELECT * FROM q JOIN other_table",
  ])("refuses relations outside the views, qualified names and non-single-select: %s", (sql) => {
    refuses(sql);
  });

  it.each([
    "SELECT * FROM", "SELECT AVG(rhr) OVER (ORDER BY local_date) FROM v_daily",
    "SELECT AVG(rhr) OVER (PARTITION BY 1 ORDER BY local_date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) FROM v_daily",
    "SELECT AVG(rhr) OVER (PARTITION BY 1 ORDER BY local_date RANGE BETWEEN 6 PRECEDING AND CURRENT ROW) FROM v_daily",
  ])("refuses syntax the parser does not support with rewrite hints: %s", (sql) => {
    expect(viewsOnly(sql)).toEqual({ ok: false, reason: "unsupported SQL syntax: window functions need PARTITION BY (use PARTITION BY 1 for the whole table) and window frames (ROWS/RANGE BETWEEN) are not supported; compute rolling values with a correlated subquery; quote identifiers with double quotes" });
  });
});
