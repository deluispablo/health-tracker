import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainSyncPending } from "../../src/ingest/drain";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T00:00:00Z");
const drainEnv = () => ({ DB: env.DB, USER_TZ: "Europe/Madrid" });
const opts = { now: () => NOW };

interface Call { type: string; start: string; end: string }
function fakeClient(reply: unknown[] | Error = []) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      rollUpHeartRate: () => Promise.reject(new Error("unexpected rollUpHeartRate")),
      dailyRollUp: () => Promise.reject(new Error("unexpected dailyRollUp")),
      listDaily: () => Promise.reject(new Error("unexpected listDaily")),
      reconcile(type: string, start: string, end: string) {
        calls.push({ type, start, end });
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      },
    },
  };
}

// Shape of a real reconcile item (spikes/S3.md, 2026-10-21 probe), trimmed to a few stages.
const stage = (start: string, end: string, type: string) =>
  ({ startTime: start, startUtcOffset: "7200s", endTime: end, endUtcOffset: "7200s", type, createTime: "x", updateTime: "x" });
function session(id: string, start: string, end: string,
  extra: { mainSleep?: boolean; summary?: unknown; stages?: unknown[]; endUtcOffset?: unknown } = {}) {
  return {
    dataPointName: `users/1/dataTypes/sleep/dataPoints/${id}`,
    sleep: {
      interval: { startTime: start, startUtcOffset: "7200s", endTime: end, endUtcOffset: "endUtcOffset" in extra ? extra.endUtcOffset : "7200s" },
      type: "STAGES",
      stages: extra.stages ?? [
        stage("2026-10-06T21:15:00Z", "2026-10-06T22:28:00Z", "AWAKE"),
        stage("2026-10-06T22:28:00Z", "2026-10-06T22:48:00Z", "LIGHT"),
        stage("2026-10-06T22:48:00Z", "2026-10-06T23:08:00Z", "DEEP"),
        stage("2026-10-06T23:08:00Z", "2026-10-07T04:48:00Z", "REM"),
      ],
      metadata: { stagesStatus: "SUCCEEDED", processed: true, mainSleep: extra.mainSleep ?? true },
      summary: "summary" in extra ? extra.summary : {
        minutesInSleepPeriod: "453", minutesAfterWakeUp: "0", minutesToFallAsleep: "7", minutesAsleep: "380", minutesAwake: "73",
        stagesSummary: [{ type: "AWAKE", minutes: "73", count: "1" }, { type: "LIGHT", minutes: "188", count: "9" },
          { type: "DEEP", minutes: "74", count: "3" }, { type: "REM", minutes: "118", count: "7" }],
      },
    },
  };
}
const ID = "users/1/dataTypes/sleep/dataPoints/";

async function queue(start: number, end: number, operation = "UPSERT", receivedAt = NOW - 60, attempts = 0, type = "sleep") {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(type, start, end, operation, receivedAt, attempts).run();
}
const summary = (fields: Record<string, string>) => ({ ...fields, stagesSummary: [] });
async function seedSession(id: string, start: number, end: number, source = "gh") {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sleep_session (source_id, source, start_ts, end_ts, tz_offset_min, local_date, updated_at) VALUES (?, ?, ?, ?, 120, '2026-10-01', 1)")
      .bind(ID + id, source, start, end),
    env.DB.prepare("INSERT INTO sleep_stage (session_id, start_ts, end_ts, stage) VALUES (?, ?, ?, 'LIGHT')").bind(ID + id, start, end),
  ]);
}
const sessions = async () => (await env.DB.prepare("SELECT * FROM sleep_session ORDER BY start_ts").all()).results;
const stages = async () => (await env.DB.prepare("SELECT * FROM sleep_stage ORDER BY session_id, start_ts").all()).results;
const pending = async () => (await env.DB.prepare(
  "SELECT start_ts, end_ts, operation, received_at, attempts FROM sync_pending WHERE data_type = 'sleep' ORDER BY start_ts").all()).results;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DROP TRIGGER IF EXISTS fail_queue"), env.DB.prepare("DELETE FROM sync_pending"),
    env.DB.prepare("DELETE FROM sleep_stage"), env.DB.prepare("DELETE FROM sleep_session")]);
});

describe("T25 AC1/AC3 daytime naps", () => {
  it("reclassifies the 15:37, 74-minute mainSleep probe and replays identically", async () => {
    const start = at("2026-07-19T13:37:00Z");
    const end = start + 74 * 60;
    const { client } = fakeClient([session("nap-probe", new Date(start * 1000).toISOString(), new Date(end * 1000).toISOString(), {
      summary: summary({ minutesInSleepPeriod: "74", minutesAsleep: "70" }), stages: [],
    })]);
    await queue(start, end);
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    const first = await sessions();
    expect(first).toEqual([expect.objectContaining({ is_nap: 1, minutes_in_bed: 74, local_date: "2026-07-19" })]);
    await queue(start, end);
    await drainSyncPending(drainEnv(), client, opts);
    expect(await sessions()).toEqual(first);
  });

  it.each([
    ["03:10 short night", "01:10:00", "7200s", 90, true, 0],
    ["seven-hour night", "21:00:00", "7200s", 420, true, 0],
    ["before 09:00", "06:59:59", "7200s", 90, true, 0],
    ["at 09:00", "07:00:00", "7200s", 90, true, 1],
    ["before 20:00", "17:59:59", "7200s", 179, true, 1],
    ["at 20:00", "18:00:00", "7200s", 90, true, 0],
    ["180-minute threshold", "13:37:00", "7200s", 180, true, 0],
    ["missing duration", "13:37:00", "7200s", null, true, 0],
    ["negative stored offset", "20:37:00", "-18000s", 74, true, 1],
    ["half-hour stored offset", "03:30:00", "19800s", 74, true, 1],
    ["UTC daytime but local night", "10:00:00", "-28800s", 74, true, 0],
    ["explicit non-main night", "21:00:00", "7200s", 420, false, 1],
    ["missing mainSleep", "21:00:00", "7200s", null, undefined, 1],
    ["non-boolean mainSleep", "21:00:00", "7200s", 420, "true", 1],
  ])("maps %s", async (_name, time, offset, minutes, mainSleep, isNap) => {
    const start = at(`2026-10-06T${time}Z`);
    const end = start + 7 * 3600;
    const item = session("rule", new Date(start * 1000).toISOString(), new Date(end * 1000).toISOString(), {
      endUtcOffset: offset, summary: { minutesInSleepPeriod: minutes }, stages: [],
    });
    Object.assign(item.sleep.metadata, { mainSleep });
    await queue(start, end);
    expect(await drainSyncPending(drainEnv(), fakeClient([item]).client, opts)).toEqual({ processed: 1, failed: 0 });
    expect((await sessions()).map((row) => row.is_nap)).toEqual([isNap]);
  });
});

describe("AC1 sleep sessions", () => {
  it("reconciles sessions ending in the interval (plus one minute) and stores session and stages", async () => {
    await queue(at("2026-10-06T21:15:00Z"), at("2026-10-07T04:48:00Z"));
    const { client, calls } = fakeClient([session("8481", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z")]);
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toEqual([{ type: "sleep", start: "2026-10-06T21:15:00.000Z", end: "2026-10-07T04:49:00.000Z" }]);
    expect(await sessions()).toEqual([{
      source_id: `${ID}8481`, source: "gh", start_ts: at("2026-10-06T21:15:00Z"), end_ts: at("2026-10-07T04:48:00Z"),
      tz_offset_min: 120, local_date: "2026-10-07", is_nap: 0, minutes_asleep: 380, minutes_in_bed: 453, efficiency: 84,
      deep_min: 74, rem_min: 118, light_min: 188, awake_min: 73, latency_min: 7, updated_at: NOW,
    }]);
    expect((await stages()).map((s) => [s.start_ts, s.end_ts, s.stage])).toEqual([
      [at("2026-10-06T21:15:00Z"), at("2026-10-06T22:28:00Z"), "AWAKE"],
      [at("2026-10-06T22:28:00Z"), at("2026-10-06T22:48:00Z"), "LIGHT"],
      [at("2026-10-06T22:48:00Z"), at("2026-10-06T23:08:00Z"), "DEEP"],
      [at("2026-10-06T23:08:00Z"), at("2026-10-07T04:48:00Z"), "REM"],
    ]);
    expect(await pending()).toEqual([]);
  });

  it("marks non-main sleep as a nap and stores nulls when the summary is missing", async () => {
    await queue(at("2026-10-07T12:00:00Z"), at("2026-10-07T12:40:00Z"));
    const { client } = fakeClient([session("9", "2026-10-07T12:00:00Z", "2026-10-07T12:40:00Z", { mainSleep: false, summary: undefined, stages: [] })]);
    await drainSyncPending(drainEnv(), client, opts);
    expect(await sessions()).toEqual([expect.objectContaining({
      is_nap: 1, minutes_asleep: null, minutes_in_bed: null, efficiency: null, deep_min: null, rem_min: null,
      light_min: null, awake_min: null, latency_min: null, local_date: "2026-10-07" })]);
    expect(await stages()).toEqual([]);
  });

  it("skips stages of other types and items without a name or valid interval", async () => {
    await queue(at("2026-10-06T21:15:00Z"), at("2026-10-07T04:48:00Z"));
    const odd = session("1", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z", {
      stages: [stage("2026-10-06T21:15:00Z", "2026-10-06T22:00:00Z", "ASLEEP"), stage("2026-10-06T22:00:00Z", "2026-10-07T04:48:00Z", "DEEP")] });
    const nameless = { sleep: session("2", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z").sleep };
    const broken = { ...session("3", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z"), sleep: { interval: { startTime: "nope" } } };
    await drainSyncPending(drainEnv(), fakeClient([odd, nameless, broken]).client, opts);
    expect((await sessions()).map((s) => s.source_id)).toEqual([`${ID}1`]);
    expect((await stages()).map((s) => s.stage)).toEqual(["DEEP"]);
  });

  it("uses the session's end offset for the wake date and tz, across midnight and with negative or half-hour offsets", async () => {
    await queue(at("2026-10-07T00:00:00Z"), at("2026-10-08T03:00:00Z"));
    const { client } = fakeClient([
      session("a", "2026-10-07T16:00:00Z", "2026-10-07T23:30:00Z", { stages: [] }),
      session("b", "2026-10-07T19:00:00Z", "2026-10-08T02:00:00Z", { stages: [], endUtcOffset: "-18000s" }),
      session("c", "2026-10-07T12:00:00Z", "2026-10-07T19:00:00Z", { stages: [], endUtcOffset: "19800s" }),
    ]);
    await drainSyncPending(drainEnv(), client, opts);
    expect((await sessions()).map((r) => [r.source_id, r.local_date, r.tz_offset_min])).toEqual([
      [`${ID}c`, "2026-10-08", 330], [`${ID}a`, "2026-10-08", 120], [`${ID}b`, "2026-10-07", -300]]);
  });

  it("skips sessions with a missing or malformed end offset or a reversed interval, keeping valid siblings", async () => {
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    const { client } = fakeClient([
      session("ok", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z", { stages: [] }),
      session("nooff", "2026-10-06T21:15:00Z", "2026-10-07T04:40:00Z", { stages: [], endUtcOffset: undefined }),
      session("badoff", "2026-10-06T21:15:00Z", "2026-10-07T04:41:00Z", { stages: [], endUtcOffset: "2h" }),
      session("rev", "2026-10-07T04:42:00Z", "2026-10-07T04:42:00Z", { stages: [] }),
      session("nodate", "2026-10-06", "2026-10-07T04:43:00Z", { stages: [] }),
    ]);
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect((await sessions()).map((r) => r.source_id)).toEqual([`${ID}ok`]);
  });

  it("skips invalid stages and floors fractional seconds", async () => {
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    const { client } = fakeClient([session("s", "2026-10-06T21:15:00.900Z", "2026-10-07T04:48:00.200Z", { stages: [
      stage("2026-10-06T21:15:00.900Z", "2026-10-06T22:00:00.500Z", "LIGHT"),
      stage("2026-10-06T22:00:00Z", "2026-10-06T22:00:00Z", "DEEP"),
      stage("bad", "2026-10-06T23:00:00Z", "REM"),
    ] })]);
    await drainSyncPending(drainEnv(), client, opts);
    expect((await sessions()).map((r) => [r.start_ts, r.end_ts])).toEqual([[at("2026-10-06T21:15:00Z"), at("2026-10-07T04:48:00Z")]]);
    expect((await stages()).map((r) => [r.start_ts, r.end_ts, r.stage])).toEqual([[at("2026-10-06T21:15:00Z"), at("2026-10-06T22:00:00Z"), "LIGHT"]]);
  });

  it("keeps the later of two stages that floor to the same second", async () => {
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    const { client } = fakeClient([session("f", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z", { stages: [
      stage("2026-10-06T22:00:00.100Z", "2026-10-06T22:00:00.600Z", "AWAKE"),
      stage("2026-10-06T22:00:00.600Z", "2026-10-06T22:30:00Z", "LIGHT"),
    ] })]);
    await drainSyncPending(drainEnv(), client, opts);
    expect((await stages()).map((r) => [r.start_ts, r.end_ts, r.stage])).toEqual([[at("2026-10-06T22:00:00Z"), at("2026-10-06T22:30:00Z"), "LIGHT"]]);
  });

  it("keeps only the last returned version of a duplicated session, stages included", async () => {
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    const first = session("dup", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z");
    const last = session("dup", "2026-10-06T21:20:00Z", "2026-10-07T04:48:00Z", {
      summary: summary({ minutesAsleep: "300" }), stages: [stage("2026-10-06T21:20:00Z", "2026-10-07T04:48:00Z", "LIGHT")] });
    await drainSyncPending(drainEnv(), fakeClient([first, last]).client, opts);
    expect((await sessions()).map((r) => [r.start_ts, r.minutes_asleep])).toEqual([[at("2026-10-06T21:20:00Z"), 300]]);
    expect((await stages()).map((r) => [r.start_ts, r.stage])).toEqual([[at("2026-10-06T21:20:00Z"), "LIGHT"]]);
  });

  it("stores a night with more stages than one D1 statement can bind", async () => {
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    const base = at("2026-10-06T21:15:00Z");
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const many = Array.from({ length: 40 }, (_, i) => stage(iso(base + i * 600), iso(base + (i + 1) * 600), ["LIGHT", "DEEP", "REM", "AWAKE"][i % 4] ?? "LIGHT"));
    const { client } = fakeClient([session("long", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z", { stages: many })]);
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(await stages()).toHaveLength(40);
    expect(await pending()).toEqual([]);
  });

  it("maps partial, zero and malformed summary values without inventing numbers", async () => {
    await queue(at("2026-10-01T00:00:00Z"), at("2026-10-04T00:00:00Z"));
    const { client } = fakeClient([
      session("p", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z", { stages: [], summary: summary({ minutesAsleep: "50" }) }),
      session("z", "2026-10-02T01:00:00Z", "2026-10-02T02:00:00Z", { stages: [], summary: { minutesAsleep: "0", minutesInSleepPeriod: "0", minutesToFallAsleep: "0",
        stagesSummary: [{ type: "DEEP", minutes: "0", count: "0" }] } }),
      session("m", "2026-10-03T01:00:00Z", "2026-10-03T02:00:00Z", { stages: [], summary: { minutesAsleep: "abc", minutesInSleepPeriod: "60",
        stagesSummary: [{ type: "REM", minutes: "x" }, "junk"] } }),
    ]);
    await drainSyncPending(drainEnv(), client, opts);
    const pick = (r: Record<string, unknown>) => [r.minutes_asleep, r.minutes_in_bed, r.efficiency, r.latency_min, r.deep_min, r.rem_min];
    expect((await sessions()).map(pick)).toEqual([[50, null, null, null, null, null], [0, 0, null, 0, 0, null], [null, 60, null, null, null, null]]);
  });

  it("replaces the stages of a returned session that moved out of the window", async () => {
    await seedSession("moved", at("2026-10-01T21:00:00Z"), at("2026-10-02T04:00:00Z"));
    await env.DB.prepare("INSERT INTO sleep_stage (session_id, start_ts, end_ts, stage) VALUES (?, ?, ?, 'DEEP')")
      .bind(`${ID}moved`, at("2026-10-02T03:00:00Z"), at("2026-10-02T04:00:00Z")).run();
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    const { client } = fakeClient([session("moved", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z", {
      stages: [stage("2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z", "LIGHT")] })]);
    await drainSyncPending(drainEnv(), client, opts);
    expect((await stages()).map((r) => [r.session_id, r.start_ts, r.stage])).toEqual([[`${ID}moved`, at("2026-10-06T21:15:00Z"), "LIGHT"]]);
    expect((await sessions()).map((r) => r.end_ts)).toEqual([at("2026-10-07T04:48:00Z")]);
  });

  it("an empty answer deletes in-window gh sessions only", async () => {
    await seedSession("in", at("2026-10-06T21:00:00Z"), at("2026-10-07T04:00:00Z"));
    await seedSession("edge", at("2026-10-06T22:00:00Z"), at("2026-10-07T05:00:00Z"));
    await seedSession("after", at("2026-10-06T22:00:00Z"), at("2026-10-07T05:01:00Z"));
    await seedSession("before", at("2026-10-06T10:00:00Z"), at("2026-10-06T20:59:59Z"));
    await seedSession("man", at("2026-10-06T21:00:00Z"), at("2026-10-07T04:30:00Z"), "manual");
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    await drainSyncPending(drainEnv(), fakeClient([]).client, opts);
    expect((await sessions()).map((r) => r.source_id).sort()).toEqual([`${ID}after`, `${ID}before`, `${ID}man`]);
    expect((await stages()).map((r) => r.session_id).sort()).toEqual([`${ID}after`, `${ID}before`, `${ID}man`]);
  });

  it("makes stored gh sessions ending in the window exactly Google's answer (UPSERT or DELETE)", async () => {
    await seedSession("old", at("2026-10-06T21:00:00Z"), at("2026-10-07T04:00:00Z"));
    await seedSession("keep", at("2026-10-05T21:00:00Z"), at("2026-10-06T04:00:00Z"));
    await seedSession("manual", at("2026-10-06T21:00:00Z"), at("2026-10-07T04:30:00Z"), "manual");
    await seedSession("8481", at("2026-10-06T21:00:00Z"), at("2026-10-07T04:48:00Z"));
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"), "DELETE");
    const { client } = fakeClient([session("8481", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z")]);
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect((await sessions()).map((s) => [s.source_id, s.start_ts])).toEqual([
      [`${ID}keep`, at("2026-10-05T21:00:00Z")], [`${ID}manual`, at("2026-10-06T21:00:00Z")], [`${ID}8481`, at("2026-10-06T21:15:00Z")]]);
    expect((await stages()).filter((s) => s.session_id === `${ID}old`)).toEqual([]);
    expect((await stages()).filter((s) => s.session_id === `${ID}8481`)).toHaveLength(4);
  });
});

describe("AC2 window and queue", () => {
  it("reads at most 7 days per run and advances the row to the window end", async () => {
    const start = at("2026-09-01T00:00:00Z");
    await queue(start, at("2026-09-20T00:00:00Z"), "UPSERT", NOW - 60, 2);
    const { client, calls } = fakeClient();
    await drainSyncPending(drainEnv(), client, opts);
    expect(calls).toEqual([{ type: "sleep", start: "2026-09-01T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" }]);
    expect(await pending()).toEqual([{ start_ts: start + 7 * 86400, end_ts: at("2026-09-20T00:00:00Z"), operation: "UPSERT", received_at: NOW - 60, attempts: 2 }]);
  });

  it("caps a row of exactly 7 days at 7 days and finishes the boundary minute on the next run", async () => {
    const start = at("2026-09-01T00:00:00Z");
    await queue(start, start + 7 * 86400);
    const { client, calls } = fakeClient();
    await drainSyncPending(drainEnv(), client, opts);
    await drainSyncPending(drainEnv(), client, opts);
    expect(calls.map((c) => [c.start, c.end])).toEqual([
      ["2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z"], ["2026-09-08T00:00:00.000Z", "2026-09-08T00:01:00.000Z"]]);
    expect(await pending()).toEqual([]);
  });

  it("does not cap a row just under 7 days", async () => {
    const start = at("2026-09-01T00:00:00Z");
    await queue(start, start + 7 * 86400 - 60);
    const { client, calls } = fakeClient();
    await drainSyncPending(drainEnv(), client, opts);
    expect(calls.map((c) => c.end)).toEqual(["2026-09-08T00:00:00.000Z"]);
    expect(await pending()).toEqual([]);
  });

  it("covers a long row over successive runs without gaps", async () => {
    const start = at("2026-09-01T00:00:00Z");
    await queue(start, at("2026-09-16T00:00:00Z"));
    const { client, calls } = fakeClient();
    for (let i = 0; i < 4; i++) await drainSyncPending(drainEnv(), client, opts);
    expect(calls.map((c) => [c.start, c.end])).toEqual([
      ["2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z"], ["2026-09-08T00:00:00.000Z", "2026-09-15T00:00:00.000Z"],
      ["2026-09-15T00:00:00.000Z", "2026-09-16T00:01:00.000Z"]]);
    expect(await pending()).toEqual([]);
  });

  it("merges an advance into a queued remainder and keeps a capped row re-received during the fetch", async () => {
    const start = at("2026-09-01T00:00:00Z");
    await queue(start, at("2026-09-20T00:00:00Z"), "UPSERT", NOW - 300, 2);
    await queue(start + 7 * 86400, at("2026-09-20T00:00:00Z"), "UPSERT", NOW - 30, 4);
    await drainSyncPending(drainEnv(), fakeClient().client, opts);
    expect(await pending()).toEqual([{ start_ts: start + 7 * 86400, end_ts: at("2026-09-20T00:00:00Z"), operation: "UPSERT", received_at: NOW - 30, attempts: 2 }]);
    await env.DB.prepare("DELETE FROM sync_pending").run();
    await queue(start, at("2026-09-20T00:00:00Z"));
    const racing = fakeClient();
    racing.client.reconcile = async () => {
      await env.DB.prepare("UPDATE sync_pending SET received_at = ?").bind(NOW).run();
      return [];
    };
    await drainSyncPending(drainEnv(), racing.client, opts);
    expect(await pending()).toEqual([{ start_ts: start, end_ts: at("2026-09-20T00:00:00Z"), operation: "UPSERT", received_at: NOW, attempts: 0 }]);
  });

  it("drains only the oldest eligible sleep row, skipping exhausted ones", async () => {
    await queue(at("2026-09-01T00:00:00Z"), at("2026-09-02T00:00:00Z"), "UPSERT", NOW - 900, 5);
    await queue(at("2026-09-05T00:00:00Z"), at("2026-09-06T00:00:00Z"), "UPSERT", NOW - 30);
    await queue(at("2026-09-03T00:00:00Z"), at("2026-09-04T00:00:00Z"), "UPSERT", NOW - 90);
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(calls.map((c) => c.start)).toEqual(["2026-09-03T00:00:00.000Z"]);
    expect((await pending()).map((r) => r.attempts)).toEqual([5, 0]);
  });

  it("still drains sleep after another type's Google failure", async () => {
    await queue(at("2026-10-18T10:00:00Z"), at("2026-10-18T11:00:00Z"), "UPSERT", NOW - 60, 0, "steps");
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    const { client, calls } = fakeClient();
    client.dailyRollUp = () => Promise.reject(new Error("503"));
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 1 });
    expect(calls).toHaveLength(1);
  });

  it("rejects without changing the row when persisting the attempt fails", async () => {
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"), "UPSERT", NOW - 60, 1);
    await env.DB.prepare("CREATE TRIGGER fail_queue BEFORE UPDATE ON sync_pending BEGIN SELECT RAISE(ABORT, 'queue write failed'); END").run();
    await expect(drainSyncPending(drainEnv(), fakeClient(new Error("503")).client, opts)).rejects.toThrow();
    await env.DB.prepare("DROP TRIGGER fail_queue").run();
    expect((await pending()).map((r) => r.attempts)).toEqual([1]);
  });

  it("keeps the row with attempts+1 and writes nothing when Google fails", async () => {
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    expect(await drainSyncPending(drainEnv(), fakeClient(new Error("503")).client, opts)).toEqual({ processed: 0, failed: 1 });
    expect((await pending()).map((r) => r.attempts)).toEqual([1]);
    expect(await sessions()).toEqual([]);
  });

  it("keeps a row re-received during the fetch", async () => {
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    const racing = fakeClient();
    racing.client.reconcile = async () => {
      await env.DB.prepare("UPDATE sync_pending SET received_at = ?").bind(NOW).run();
      return [];
    };
    await drainSyncPending(drainEnv(), racing.client, opts);
    expect((await pending()).map((r) => r.received_at)).toEqual([NOW]);
  });

  it("rolls back session writes and counts a failure when the queue mutation fails", async () => {
    await seedSession("old", at("2026-10-06T21:00:00Z"), at("2026-10-07T04:00:00Z"));
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    await env.DB.prepare("CREATE TRIGGER fail_queue BEFORE DELETE ON sync_pending BEGIN SELECT RAISE(ABORT, 'queue write failed'); END").run();
    expect(await drainSyncPending(drainEnv(), fakeClient([session("8481", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z")]).client, opts)).toEqual({ processed: 0, failed: 1 });
    await env.DB.prepare("DROP TRIGGER fail_queue").run();
    expect((await sessions()).map((s) => s.source_id)).toEqual([`${ID}old`]);
    expect(await stages()).toHaveLength(1);
    expect((await pending()).map((r) => r.attempts)).toEqual([1]);
  });
});
