import { Parser } from "node-sql-parser/build/sqlite";
import { describe, expect, it } from "vitest";
import { viewsOnly } from "../../src/mcp/tools/sqlviews";

const parser = new Parser();

function refuses(sql: string, reason: RegExp = /\S/) {
  const result: unknown = viewsOnly(sql, parser);
  expect(result, sql).toMatchObject({ ok: false });
  expect(result, sql).toHaveProperty("reason", expect.stringMatching(reason));
}

function accepts(sql: string) {
  expect(viewsOnly(sql, parser), sql).toEqual({ ok: true });
}

describe("T11 AC3e parser layer allows only the four views and declared CTEs", () => {
  it.each([
    "SELECT 1", "SELECT * FROM v_daily", "SELECT * FROM v_events", "SELECT * FROM v_sleep",
    "SELECT * FROM v_workouts", "SELECT * FROM V_DAILY", 'SELECT * FROM "v_daily"',
    "WITH q AS (SELECT * FROM v_daily) SELECT * FROM q",
    "WITH Q AS (SELECT * FROM v_daily) SELECT * FROM q",
    "WITH q AS (WITH r AS (SELECT * FROM v_events) SELECT * FROM r) SELECT * FROM q",
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
    expect(viewsOnly(sql, parser)).toMatchObject({ ok: false, reason: "unsupported SQL syntax; quote identifiers with double quotes", error: expect.any(Error) as unknown });
  });
});


describe("SQL resource bounds", () => {
  it.each([
    "SELECT hex(zeroblob(1000000))",
    'SELECT "randomblob"(1000000)',
    "SELECT 'ZeRoBlOb'(1000000)",
    "WITH q AS (SELECT randomblob(1000000)) SELECT * FROM q",
    "SELECT 1 WHERE EXISTS (SELECT zeroblob(1000000))",
  ])("refuses blob allocation in %s", sql => { refuses(sql, /function .* is not allowed.*unbounded blobs/); });

  it.each([
    "SELECT printf('%.*c', 1e8, 'x')",
    'SELECT "FoRmAt"(\'%.*c\', 1e8, \'x\')',
    "SELECT 'printf'('%.*c', 1e8, 'x')",
    "WITH q AS (SELECT format('%.*c', 1e8, 'x')) SELECT * FROM q",
  ])("refuses string allocation in %s", sql => { refuses(sql, /function .* is not allowed.*unbounded strings/); });

  it.each([
    "WITH RECURSIVE q(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM q) SELECT max(n) FROM q",
    "WITH RECURSIVE q(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM q WHERE n < 3) SELECT * FROM q",
    "WITH q AS (WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r) SELECT * FROM q",
  ])("refuses recursive CTEs in %s", sql => { refuses(sql, /WITH RECURSIVE is not allowed/); });

  it.each([
    "WITH q(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM q) SELECT max(n) FROM q",
    "SELECT (WITH q(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM q) SELECT max(n) FROM q)",
    'WITH "Q" AS (SELECT * FROM v_daily JOIN "q" ON 1=1) SELECT * FROM q',
    "WITH q AS (SELECT (SELECT count(*) FROM q)) SELECT * FROM q",
  ])("refuses self-referencing CTEs without RECURSIVE in %s", sql => { refuses(sql, /recursive CTE q is not allowed/); });

  it.each([
    "SELECT 'zeroblob(1000000)', 'WITH RECURSIVE', 'randomblob(1)'",
    'SELECT 1 AS "zeroblob", 2 AS "randomblob"',
    "WITH zeroblob AS (SELECT 1 AS n) SELECT n FROM zeroblob",
    "SELECT 1 /* randomblob(1000000) WITH RECURSIVE */",
    "WITH q AS (SELECT q, d.q FROM v_daily d) SELECT * FROM q",
    "WITH q AS (SELECT * FROM r), r AS (SELECT 1) SELECT * FROM q",
    "SELECT (WITH q AS (SELECT 1 AS q) SELECT q FROM q)",
    "SELECT 'printf', 'format', 'printf(1000000)'",
    'SELECT 1 AS "printf", 2 AS "format"',
  ])("preserves ordinary literals, names and comments in %s", accepts);
});
