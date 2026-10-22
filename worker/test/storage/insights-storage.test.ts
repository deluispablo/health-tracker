import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthSql } from "../../src/mcp/tools/sql";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["finding_check", "finding", "analysis_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("insight storage", () => {
  it("creates the tables and timestamp index", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('finding', 'finding_check', 'analysis_log', 'analysis_log_ts') ORDER BY name").all();
    expect(results.map((r) => r.name)).toEqual(["analysis_log", "analysis_log_ts", "finding", "finding_check"]);
  });

  it("enforces unique hashes and the status check", async () => {
    const insert = (hash: string, status: string) => env.DB.prepare("INSERT INTO finding (saved_at, statement, ref, ref_hash, result, status) VALUES (1, 'text', '{}', ?, '{}', ?)").bind(hash, status).run();
    await insert("same", "active");
    await expect(insert("same", "active")).rejects.toThrow(/UNIQUE/);
    await expect(insert("different", "invalid")).rejects.toThrow(/CHECK/);
  });

  it.each(["finding", "finding_check", "analysis_log"])("healthSql refuses %s", async (table) => {
    await expect(healthSql(env.DB, { query: `SELECT * FROM ${table}` })).rejects.toBeInstanceOf(RangeError);
  });
});
