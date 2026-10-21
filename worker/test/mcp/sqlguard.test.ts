import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { validateReadOnlyQuery } from "../../src/mcp/tools/sqlguard";

function refuses(sql: string) {
  const result: unknown = validateReadOnlyQuery(sql);
  expect(result, sql).toMatchObject({ ok: false });
  expect(result, sql).toHaveProperty("reason", expect.stringMatching(/\S/));
}

function accepts(sql: string) {
  expect(validateReadOnlyQuery(sql), sql).toEqual({ ok: true, sql });
}

const keywords = [
  "INSERT", "UPDATE", "DELETE", "REPLACE", "UPSERT", "CREATE", "DROP", "ALTER", "ATTACH", "DETACH",
  "PRAGMA", "VACUUM", "REINDEX", "ANALYZE", "SAVEPOINT", "RELEASE", "BEGIN", "COMMIT", "ROLLBACK",
  "TRANSACTION", "RETURNING",
];
const deniedNames = [
  "metric_minute", "metric_hour", "metric_daily", "metric_def", "sleep_session", "sleep_stage", "workout",
  "tracker", "event", "daily_summary", "tracker_daily", "sync_pending", "sync_state", "secret_blob",
  "audit_log", "oauth_state", "d1_migrations", "sqlite_master", "sqlite_schema", "sqlite_custom",
  "pragma_custom", "_cf_custom", "sqlite_", "pragma_", "_cf_", "main", "temp", "temporary",
];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("T11 AC1 single SELECT/WITH statement", () => {
  it.each([
    "SELECT 1", "sElEcT 1", "SELECT * FROM v_daily", "SELECT * FROM v_events",
    "SELECT * FROM v_sleep", "SELECT * FROM v_workouts",
    "WITH q AS (SELECT * FROM v_daily) SELECT * FROM q",
    "wItH q AS (SELECT 1) SELECT * FROM q",
    "WITH RECURSIVE q(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM q WHERE n < 3) SELECT * FROM q",
  ])("accepts %s unchanged", accepts);

  it.each([
    " \t\r\nSELECT 1; \n", "/* INSERT; */ -- DELETE\nSELECT 1; -- tail",
    "/* lead */WITH q AS (SELECT 1) SELECT * FROM q;/* tail */",
  ])("accepts surrounding whitespace/comments and one terminator: %s", (sql) => {
    expect(validateReadOnlyQuery(sql)).toMatchObject({ ok: true });
  });

  it.each([
    "INSERT INTO v_events VALUES (1)", "EXPLAIN SELECT 1", "VALUES (1)", "(SELECT 1)",
    "SELECTED 1", "WITHIN q", '"SELECT" 1', "'SELECT' 1", "SEL/**/ECT 1", "WI-- split\nTH q",
    ";SELECT 1", "SELECT 1; SELECT 2", "SELECT 1;/**/SELECT 2", "SELECT 1;-- hide\nDELETE FROM v_events",
    "SELECT 1;;", "SELECT 1; /* gap */ ;", "SELECT 1; 'tail'", 'SELECT 1; "tail"', "SELECT 1; 2",
  ])("refuses non-read starts or extra tokens/statements: %s", refuses);
});

describe("T11 AC2 tokenized keywords and dangerous functions", () => {
  it.each(keywords)("refuses bare %s anywhere, case-insensitively", (keyword) => {
    for (const word of [keyword, keyword.toLowerCase()]) {
      refuses(`SELECT 1 ${word}`);
      refuses(`SELECT 1/**/${word}/**/1`);
      refuses(`WITH q AS (SELECT 1) SELECT (SELECT ${word} FROM v_daily) FROM q`);
    }
  });

  it("refuses a pragma_ identifier even where a keyword-like label is meant (AC3 precedence)", () => {
    refuses("SELECT pragma_label FROM v_events");
  });

  it("refuses mixed-case keywords after line comments", () => {
    refuses("SELECT 1 -- harmless\n uPdAtE v_daily SET steps = 0");
  });

  it.each(keywords)("does not treat %s in strings, identifiers or comments as a keyword", (word) => {
    accepts(`SELECT '${word}', "${word}", [${word}], \`${word}\`, label_${word.toLowerCase()} FROM v_events`);
    expect(validateReadOnlyQuery(`SELECT /* ${word}; */ 1 -- ${word}`)).toMatchObject({ ok: true });
  });

  it.each(["load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "sqlite_version"])(
    "refuses function %s, including quoted calls and intervening comments", (name) => {
      for (const fn of [name, name.toUpperCase(), `"${name}"`, `[${name}]`, `\`${name}\``]) {
        refuses(`SELECT ${fn} ('x')`);
        refuses(`SELECT (SELECT ${fn}/**/('x') FROM v_events)`);
      }
    },
  );

  it.each(["load_extension", "readfile", "writefile", "edit", "fts3_tokenizer"])(
    "allows the function name %s as ordinary string content", (word) => { accepts(`SELECT '${word}'`); },
  );
});

describe("T11 AC3/AC3a deny names in every identifier form and whole string literals", () => {
  it.each(deniedNames)("refuses %s in bare, quoted and literal forms regardless of case", (name) => {
    for (const spelling of [name, name.toUpperCase()]) {
      for (const token of [spelling, `"${spelling}"`, `[${spelling}]`, `\`${spelling}\``, `'${spelling}'`]) {
        refuses(`SELECT * FROM ${token}`);
        refuses(`SELECT ${token} FROM v_events`);
      }
    }
  });

  it.each([
    "SELECT * FROM SeCrEt_BlOb", "SELECT 1 AS EvEnT", "SELECT * FROM v_events AS secret_blob",
    "SELECT SqLiTe_custom()", "SELECT * FROM PrAgMa_custom", "SELECT * FROM _cF_custom",
    "SELECT * FROM v_events AS e JOIN secret_blob AS s ON 1 = 1",
    "SELECT * FROM v_daily UNION SELECT * FROM secret_blob",
    "SELECT (SELECT name FROM secret_blob) FROM v_daily",
    "SELECT * FROM v_daily WHERE EXISTS (SELECT 1 FROM oauth_state)",
    "WITH secret_blob AS (SELECT 1) SELECT * FROM secret_blob",
    "SELECT (WITH secret_blob AS (SELECT 1) SELECT count(*) FROM secret_blob) FROM secret_blob",
    "WITH secret_blob AS (SELECT 1) SELECT name FROM main.secret_blob",
    "SELECT * FROM main.v_daily", 'SELECT * FROM "temp".v_events', "SELECT * FROM temporary.v_sleep",
    "SELECT name FROM (secret_blob)", "SELECT * FROM ((secret_blob))",
    "SELECT * FROM pragma_table_info('event')", "SELECT * FROM PRAGMA_TABLE_INFO('v_events')",
    "SELECT * FROM 'secret_blob'", "SELECT * FROM 'SQLITE_MASTER'",
    "SELECT (SELECT name FROM 'secret_blob') FROM v_events",
    "SELECT * FROM v_daily WHERE EXISTS (SELECT 1 FROM 'SQLITE_MASTER')",
    "SELECT * FROM json_each('secret_blob')", "SELECT * FROM json_tree('PRAGMA_x')",
    "SELECT e.event FROM v_events AS e", "SELECT 1 AS '_cf_hidden'",
  ])("refuses nested/shadowed/qualified/grouped access and denied aliases: %s", refuses);

  it.each([
    "SELECT * FROM unknown_relation",
    "WITH q AS (SELECT * FROM v_daily), r AS (SELECT * FROM q) SELECT * FROM r",
    "WITH q AS (WITH r AS (SELECT * FROM v_events) SELECT * FROM r) SELECT * FROM q",
    "SELECT (WITH q AS (SELECT note FROM v_events) SELECT * FROM q) FROM v_daily",
    "SELECT * FROM (v_events)", "SELECT * FROM ((v_sleep))", "SELECT e.note FROM v_events AS e",
    "SELECT (SELECT note FROM v_events) FROM v_daily",
    "SELECT * FROM v_daily WHERE EXISTS (SELECT 1 FROM v_events)",
    "SELECT * FROM v_daily UNION SELECT * FROM v_workouts",
    "SELECT 'cigarettes', '2026-10-21', 'hello event', 'secret_blob suffix', 'prefix sqlite_master'",
    "SELECT event_label, my_secret_blob, my_pragma, sqlite, _cf FROM v_events",
    'SELECT "hello event", [event label], `secret_blob suffix` FROM v_events',
    "SELECT * FROM 'unknown_relation'", "SELECT * FROM 'v_events'",
  ])("accepts other identifiers, view queries and nonmatching literal contents: %s", accepts);

  it.each(["json_each", "json_tree"])("allows %s with arbitrary safe arguments", (fn) => {
    for (const args of [
      "'x'", "'{\"event\": [1,2], \"secret_blob\": 3}'", "note", "e.note", "1 + 2", "upper(note)",
      "(SELECT note FROM v_events LIMIT 1)", "note, '$.event'",
    ]) accepts(`SELECT * FROM v_events AS e, ${fn}(${args})`);
  });
});

describe("T11 AC3b migrated schema coverage", () => {
  it("refuses every actual non-view table, including internal and migration tables", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    expect(results.length).toBeGreaterThan(0);
    expect(results.map(({ name }) => name)).toContain("secret_blob");
    for (const { name } of results) {
      refuses(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
      refuses(`SELECT * FROM '${name.replaceAll("'", "''")}'`);
    }
  });
});

describe("T11 AC3c lexical boundaries without SQL grammar parsing", () => {
  it.each([
    "", " \t\r\n", "-- SELECT 1", "/* SELECT 1 */", "/* first */ -- second\n", ";",
    "SELECT 'unterminated", "SELECT 'escaped''", 'SELECT "unterminated', 'SELECT "escaped""',
    "SELECT [unterminated", "SELECT `unterminated", "SELECT `escaped``", "SELECT 1 /* unterminated",
    "SELECT 1; /* unterminated", "/* unterminated",
  ])("refuses empty input or unterminated lexical tokens: %s", refuses);

  it.each(["SELECT", "WITH", "SELECT FROM", "WITH q AS (", "SELECT * FROM"])(
    "leaves malformed SQL grammar to D1: %s", accepts,
  );

  it("counts the original input at exactly 4000/4001 UTF-16 code units", () => {
    const ascii = `SELECT '${"x".repeat(3991)}'`;
    const astral = `SELECT '${"😀".repeat(1995)}x'`;
    for (const sql of [ascii, astral]) {
      expect(sql.length).toBe(4000);
      accepts(sql);
      refuses(`${sql} `);
      refuses(`${sql};`);
    }
    const commented = `SELECT 1/*${"x".repeat(3989)}*/`;
    expect(commented.length).toBe(4001);
    refuses(commented);
  });
});

describe("T11 SQLite token boundaries", () => {
  it.each([
    "SELECT event$label FROM v_events", "SELECT \u00e9event FROM v_events",
    "SELECT event\u00e9 FROM v_events",
  ])("treats $ and non-ASCII code points as identifier characters: %s", accepts);

  it.each(["SELECT\u00e9 1", "SELECT\u00a0* FROM v_daily", "\u00a0SELECT 1"])(
    "does not treat NBSP or non-ASCII suffixes as keyword boundaries: %s", refuses,
  );

  it("ends line comments only at LF", () => {
    const result: unknown = validateReadOnlyQuery("SELECT 1--x\r+2");
    expect(result).toMatchObject({ ok: true });
    expect(result).toHaveProperty("sql", expect.stringMatching(/^SELECT 1\s*$/));
  });

  it("closes block comments at the first terminator without nesting", () => {
    expect(validateReadOnlyQuery("SELECT 1/* outer /* inner */+2")).toEqual({ ok: true, sql: "SELECT 1 +2" });
  });
});

describe("T11 AC3d normalized SQL preserves token contents", () => {
  it.each([
    ["SELECT/**/1", "SELECT 1"],
    ["SELECT/* first *//* second */1;", "SELECT  1"],
    ["SELECT 1 AS/* label */answer;", "SELECT 1 AS answer"],
    ["SELECT 'a;--/*x*/''b', \"a;--/*x*/\"\"b\", [a;--/*x*/], `a;--/*x*/``b`;",
      "SELECT 'a;--/*x*/''b', \"a;--/*x*/\"\"b\", [a;--/*x*/], `a;--/*x*/``b`"],
    ["SELECT 'DROP; UPDATE -- /* secret_blob */', 'café 😀', 'a\\b';",
      "SELECT 'DROP; UPDATE -- /* secret_blob */', 'café 😀', 'a\\b'"],
  ])("normalizes %s", (sql, normalized) => {
    expect(validateReadOnlyQuery(sql)).toEqual({ ok: true, sql: normalized });
  });

  it("ends line comments at the newline without swallowing the next token", () => {
    const result: unknown = validateReadOnlyQuery("SELECT 1-- hidden ; DROP TABLE secret_blob\n+ 2;");
    expect(result).toMatchObject({ ok: true });
    expect(result).toHaveProperty("sql", expect.stringMatching(/^SELECT 1 \s*\+ 2$/));
  });

  it.each(["SELECT 1 -- tail", "SELECT 1; -- tail", "/* lead */ SELECT 1; /* tail */"])(
    "removes boundary comments and the optional terminator: %s", (sql) => {
      const result: unknown = validateReadOnlyQuery(sql);
      expect(result).toMatchObject({ ok: true });
      expect(result).toHaveProperty("sql", expect.stringMatching(/^\s*SELECT 1\s*$/));
    },
  );
});
