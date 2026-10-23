import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleScheduled, route } from "../src/app";
import { logEvent } from "../src/mcp/tools/trackers";
import { createEvaluator } from "../src/mcp/tools/insights/evaluator";
import { healthFindings } from "../src/mcp/tools/insights/findings";
import type { FamilyRow } from "../src/mcp/tools/insights/types";

const TOKEN = "watch-token-0123456789abcdef0123456789";
const NOW = Date.parse("2026-11-01T14:30:00Z") / 1000; // 15:30 Madrid on 11-01, 01:30 Sydney on 11-02
const deps = { fetch, now: () => NOW, sleep: () => Promise.resolve() };
const appEnv = (DB: D1Database = env.DB) => ({
  DB, OAUTH_KV: env.OAUTH_KV, USER_TZ: "Europe/Madrid", WEBHOOK_SECRET: "Bearer hook-secret-0123456789",
  GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", ALLOWED_EMAIL: "owner@example.com", TOKEN_ENC_KEY: "key", WATCH_TOKEN: TOKEN,
});
const today = (headers: Record<string, string> = {}, DB?: D1Database) => route(
  new Request("https://example.com/watch/today", { headers: { authorization: `Bearer ${TOKEN}`, ...headers } }), appEnv(DB), deps);
const dateOf = async (res: Response) => (await res.json<{ date: string }>()).date;
const store =(value: string) => env.DB.prepare("INSERT INTO profile (key, value, updated_at) VALUES ('tz', ?, 1)").bind(value).run();
const stored = async () => (await env.DB.prepare("SELECT value FROM profile WHERE key = 'tz'").first<{ value: string }>())?.value ?? null;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["finding_check", "finding", "analysis_log", "event", "sleep_session", "daily_summary", "profile"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("zone reported by the watch", () => {
  it("stores a valid X-Time-Zone and answers that request in it", async () => {
    const res = await today({ "x-time-zone": "Australia/Sydney" });
    expect(await dateOf(res)).toBe("2026-11-02");
    expect(await stored()).toBe('"Australia/Sydney"');
  });

  it("stores a report equal to the fallback when the row is missing", async () => {
    await today({ "x-time-zone": "Europe/Madrid" });
    expect(await stored()).toBe('"Europe/Madrid"');
  });

  it("replaces an invalid stored row with a report equal to the fallback", async () => {
    await store('"Mars/Base"');
    await today({ "x-time-zone": "Europe/Madrid" });
    expect(await stored()).toBe('"Europe/Madrid"');
  });

  it.each([["Mars/Base"], [""], [undefined]])("ignores %j and answers in the stored zone", async (header) => {
    await store('"Australia/Sydney"');
    const headers: Record<string, string> = header === undefined ? {} : { "x-time-zone": header };
    const res = await today(headers);
    expect(res.status).toBe(200);
    expect(await dateOf(res)).toBe("2026-11-02");
    expect(await stored()).toBe('"Australia/Sydney"');
  });

  it("without a stored row an invalid or absent header keeps the wrangler zone and stores nothing", async () => {
    for (const headers of [{ "x-time-zone": "Mars/Base" }, {}] as Record<string, string>[]) {
      expect(await dateOf(await today(headers))).toBe("2026-11-01");
    }
    expect(await stored()).toBeNull();
  });

  it.each([["{"], ["5"], ['""'], ['"Mars/Base"'], ["null"]])("falls back to the wrangler zone for the stored value %s without rewriting it", async (value) => {
    await store(value);
    expect(await dateOf(await today())).toBe("2026-11-01");
    expect(await stored()).toBe(value);
  });

  it("falls back when the lookup fails", async () => {
    await store('"Australia/Sydney"');
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("'tz'") && sql.startsWith("SELECT")) throw new Error("down");
        return target.prepare(sql);
      };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    expect(await dateOf(await today({}, db))).toBe("2026-11-01");
  });

  it("the cron rolls up the stored zone's today", async () => {
    await store('"Australia/Sydney"');
    await handleScheduled("*/5 * * * *", appEnv(), deps);
    const rows = await env.DB.prepare("SELECT local_date FROM daily_summary").all<{ local_date: string }>();
    expect(rows.results.map((r) => r.local_date)).toEqual(["2026-11-02"]);
  });

  it("keeps the local_date and offset of rows logged before the switch", async () => {
    const at = Date.parse("2026-10-23T10:00:00Z") / 1000;
    await logEvent(env.DB, { tracker_id: "caffeine", at: new Date(at * 1000).toISOString() }, { now: at, tz: "Europe/Madrid" });
    await today({ "x-time-zone": "Australia/Sydney" });
    const row = await env.DB.prepare("SELECT local_date, tz_offset_min FROM event").first();
    expect(row).toEqual({ local_date: "2026-10-23", tz_offset_min: 120 });
  });
});

describe("findings keep the zone they were saved in", () => {
  const iso = (i: number) => new Date(Date.parse("2026-10-10T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
  const saveAt = Date.parse("2026-11-01T19:00:00Z"); // 20:00 Madrid (11-01 open), 06:00 Sydney on 11-02 (11-01 complete)
  const caffeine = { a: { where: [{ behavior: "caffeine", op: ">", value: 0 }] }, b: { where: [{ behavior: "caffeine", op: "=", value: 0 }] } };
  const args = { start: "2026-10-15", end: "2026-10-31", ...caffeine, metrics: ["steps"], timing: "next_day" };

  beforeEach(async () => {
    const s = [];
    for (let i = 0; i <= 23; i++) {
      const d = iso(i);
      const ts = Date.parse(`${d}T10:00:00Z`) / 1000;
      const event = (id: string, tracker: string) => env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES (?,?,?,60,?,1,'import',1)").bind(id, tracker, ts, d);
      s.push(event(`mood-${d}`, "mood_bien"));
      if (i % 2 === 0) s.push(event(`caf-${d}`, "caffeine"));
      s.push(env.DB.prepare("INSERT INTO daily_summary (local_date,steps,hr_wear_min,workout_min,rhr,ln_rmssd,computed_at) VALUES (?,?,900,0,60,4,1)").bind(d, 5000 + i * 100));
    }
    await env.DB.batch(s);
  });

  const save = async () => {
    const madrid = createEvaluator(env.DB, { nowSec: saveAt / 1000, tz: "Europe/Madrid" });
    const origin = madrid.validateOrigin({ tool: "health_contrast", args });
    const ref = (await madrid.family(origin, {})).rows[0].ref;
    const out = await healthFindings(env.DB, { action: "save", statement: "caffeine steps", ref }, { nowMs: saveAt, evaluator: madrid });
    return (out.finding as { id: number; ref: { tz: string } });
  };
  const recheck = async (id: number) => {
    const sydney = createEvaluator(env.DB, { nowSec: saveAt / 1000 + 86400, tz: "Australia/Sydney" });
    await healthFindings(env.DB, { action: "recheck", id }, { nowMs: saveAt + 86400000, evaluator: sydney });
    const row = await env.DB.prepare("SELECT result FROM finding_check WHERE finding_id = ?").bind(id).first<{ result: string }>();
    return JSON.parse(row?.result ?? "null") as FamilyRow;
  };
  const saved = async (id: number) => JSON.parse((await env.DB.prepare("SELECT result FROM finding WHERE id = ?").bind(id).first<{ result: string }>())?.result ?? "null") as FamilyRow;

  it("stores ref.tz and a historical recheck in another zone reproduces the same n", async () => {
    const finding = await save();
    expect(finding.ref.tz).toBe("Europe/Madrid");
    const fresh = await recheck(finding.id);
    const before = await saved(finding.id);
    expect([fresh.n_a, fresh.n_b]).toEqual([before.n_a, before.n_b]);
    // The same fixture read in Sydney (11-01 complete) would gain the 10-31 exposure.
    const sydney = createEvaluator(env.DB, { nowSec: saveAt / 1000, tz: "Australia/Sydney" });
    const other = (await sydney.family(sydney.validateOrigin({ tool: "health_contrast", args }), {})).rows[0];
    expect(other.n_a + other.n_b).toBe(before.n_a + before.n_b + 1);
  });

  it("ignores a ref.tz edited to an invalid zone and uses the current zone", async () => {
    const finding = await save();
    await env.DB.prepare("UPDATE finding SET ref = json_set(ref, '$.tz', 'Mars/Base') WHERE id = ?").bind(finding.id).run();
    const fresh = await recheck(finding.id);
    const before = await saved(finding.id);
    expect(fresh.n_a + fresh.n_b).toBe(before.n_a + before.n_b + 1);
  });
});
