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
function session(id: string, start: string, end: string, extra: { mainSleep?: boolean; summary?: unknown; stages?: unknown[] } = {}) {
  return {
    dataPointName: `users/1/dataTypes/sleep/dataPoints/${id}`,
    sleep: {
      interval: { startTime: start, startUtcOffset: "7200s", endTime: end, endUtcOffset: "7200s" },
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

async function queue(start: number, end: number, operation = "UPSERT", receivedAt = NOW - 60, attempts = 0) {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES ('sleep', ?, ?, ?, ?, ?)")
    .bind(start, end, operation, receivedAt, attempts).run();
}
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
  "SELECT start_ts, end_ts, operation, received_at, attempts FROM sync_pending ORDER BY start_ts").all()).results;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DROP TRIGGER IF EXISTS fail_queue"), env.DB.prepare("DELETE FROM sync_pending"),
    env.DB.prepare("DELETE FROM sleep_stage"), env.DB.prepare("DELETE FROM sleep_session")]);
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

  it("rolls back session writes when the queue mutation fails", async () => {
    await seedSession("old", at("2026-10-06T21:00:00Z"), at("2026-10-07T04:00:00Z"));
    await queue(at("2026-10-06T21:00:00Z"), at("2026-10-07T05:00:00Z"));
    await env.DB.prepare("CREATE TRIGGER fail_queue BEFORE DELETE ON sync_pending BEGIN SELECT RAISE(ABORT, 'queue write failed'); END").run();
    await expect(drainSyncPending(drainEnv(), fakeClient([session("8481", "2026-10-06T21:15:00Z", "2026-10-07T04:48:00Z")]).client, opts)).rejects.toThrow();
    await env.DB.prepare("DROP TRIGGER fail_queue").run();
    expect((await sessions()).map((s) => s.source_id)).toEqual([`${ID}old`]);
    expect(await stages()).toHaveLength(1);
  });
});
