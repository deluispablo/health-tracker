import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { healthContrast } from "../../src/mcp/tools/insights/contrast";
import { healthPeriods } from "../../src/mcp/tools/insights/periods";
import { healthScan } from "../../src/mcp/tools/insights/scan";

const deps = { nowSec: Date.parse("2026-10-01T08:00:00Z") / 1000, tz: "Europe/Madrid" };
const tools = [
  { name: "health_scan", run: healthScan, args: {} },
  { name: "health_periods", run: healthPeriods, args: {} },
  { name: "health_contrast", run: healthContrast, args: { a: {}, b: {}, metrics: ["rhr"] } },
];
afterEach(() => { vi.restoreAllMocks(); });
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { await env.DB.prepare("DELETE FROM analysis_log").run(); });

it.each(tools)("$name replies before its log write finishes and persists once afterward", async ({ name, run, args }) => {
  const ctx = createExecutionContext();
  const waitUntil = vi.spyOn(ctx, "waitUntil");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.startsWith("INSERT INTO analysis_log")) return statement;
      return { bind: (...values: unknown[]) => ({ run: async () => {
        await gate;
        return statement.bind(...values).run();
      } }) };
    };
    return Reflect.get(target, key) as unknown;
  } });
  try {
    const result = await run(db, args, deps, ctx);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_log").first("n")).toBe(0);
    expect(result.tests_last_24h).toBe(result.tests);
    release();
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare("SELECT * FROM analysis_log").all()).results)
      .toEqual([{ ts: deps.nowSec * 1000, tool: name, tests: result.tests }]);
  } finally {
    release();
    await waitOnExecutionContext(ctx);
  }
});

it.each(tools.flatMap(tool => ["prepare", "run"].map(stage => ({ ...tool, stage }))))("$name still replies when log storage fails at $stage", async ({ name, run, args, stage }) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const ctx = createExecutionContext();
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (sql.startsWith("INSERT INTO analysis_log")) {
        const error = new Error("storage unavailable weight_kg=72.4");
        if (stage === "prepare") throw error;
        return { bind: () => ({ run: () => Promise.reject(error) }) };
      }
      return target.prepare(sql);
    };
    return Reflect.get(target, key) as unknown;
  } });
  expect(await run(db, args, deps, ctx)).toHaveProperty("tests");
  await waitOnExecutionContext(ctx);
  expect(log).toHaveBeenCalledExactlyOnceWith(`analysis_log ${name}`, "Error");
  expect(JSON.stringify(log.mock.calls)).not.toContain("weight_kg=72.4");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_log").first("n")).toBe(0);
});
