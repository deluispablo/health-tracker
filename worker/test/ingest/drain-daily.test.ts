import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainSyncPending } from "../../src/ingest/drain";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T00:00:00Z");
const drainEnv = () => ({ DB: env.DB, USER_TZ: "Europe/Madrid" });
const opts = { now: () => NOW };

interface Call { method: string; type: string; start: string; end: string }
type Reply = unknown[] | Error;
function fakeClient(replies: { steps?: Reply; rhr?: Reply } = {}) {
  const calls: Call[] = [];
  const answer = (r: Reply | undefined) => r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? []);
  return {
    calls,
    client: {
      rollUpSteps: () => Promise.resolve([]),
      rollUpHeartRate: () => Promise.reject(new Error("unexpected rollUpHeartRate")),
      dailyRollUp(type: string, start: string, end: string) {
        calls.push({ method: "dailyRollUp", type, start, end });
        return answer(replies.steps) as Promise<{ date: string; value: unknown }[]>;
      },
      listDaily(type: string, start: string, end: string) {
        calls.push({ method: "listDaily", type, start, end });
        return answer(replies.rhr);
      },
      reconcile: () => Promise.reject(new Error("unexpected reconcile")),
    },
  };
}
const steps = (date: string, n: string) => ({ date, value: { countSum: n } });
const rhr = (y: number, m: number, d: number, bpm: string) =>
  ({ dailyRestingHeartRate: { date: { year: y, month: m, day: d }, beatsPerMinute: bpm } });

async function queue(type: string, start: number, end: number, operation = "UPSERT", receivedAt = NOW - 60, attempts = 0) {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(type, start, end, operation, receivedAt, attempts).run();
}
async function seedDaily(metric: string, date: string, value: number, source = "gh") {
  await env.DB.prepare("INSERT INTO metric_daily (metric, local_date, value, source, updated_at) VALUES (?, ?, ?, ?, 1)")
    .bind(metric, date, value, source).run();
}
const pending = async () => (await env.DB.prepare(
  "SELECT data_type, start_ts, end_ts, operation, received_at, attempts FROM sync_pending ORDER BY data_type, start_ts").all()).results;
const daily = async () => (await env.DB.prepare(
  "SELECT metric, local_date, value, source, source_id, updated_at FROM metric_daily ORDER BY metric, source, local_date").all()).results;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DROP TRIGGER IF EXISTS fail_queue"), env.DB.prepare("DELETE FROM sync_pending"),
    env.DB.prepare("DELETE FROM metric_daily"), env.DB.prepare("DELETE FROM metric_minute")]);
});

describe("AC1 steps daily totals", () => {
  it("re-reads the local dates the interval touches and stores each day's total", async () => {
    // 21:30Z..23:10Z on 20 Oct is 23:30..01:10 in Madrid: local dates 20 and 21 Oct.
    await queue("steps", at("2026-10-20T21:30:00Z"), at("2026-10-20T23:10:00Z"));
    const { client, calls } = fakeClient({ steps: [steps("2026-10-20", "8123"), steps("2026-10-21", "40")] });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toEqual([{ method: "dailyRollUp", type: "steps", start: "2026-10-20", end: "2026-10-22" }]);
    expect(await daily()).toEqual([
      { metric: "steps", local_date: "2026-10-20", value: 8123, source: "gh", source_id: null, updated_at: NOW },
      { metric: "steps", local_date: "2026-10-21", value: 40, source: "gh", source_id: null, updated_at: NOW },
    ]);
    expect(await pending()).toEqual([]);
  });

  it("uses the exclusive end: an interval ending at local midnight does not touch the next day", async () => {
    await queue("steps", at("2026-10-20T20:00:00Z"), at("2026-10-20T22:00:00Z"));
    const { client, calls } = fakeClient();
    await drainSyncPending(drainEnv(), client, opts);
    expect(calls.map((c) => [c.start, c.end])).toEqual([["2026-10-20", "2026-10-21"]]);
  });

  it("treats a DELETE like an UPSERT: Google's current totals replace the stored ones, missing days are removed", async () => {
    await seedDaily("steps", "2026-10-19", 500);
    await seedDaily("steps", "2026-10-20", 900);
    await seedDaily("steps", "2026-10-20", 77, "manual");
    await seedDaily("rhr", "2026-10-20", 60);
    await queue("steps", at("2026-10-19T10:00:00Z"), at("2026-10-20T10:00:00Z"), "DELETE");
    const { client } = fakeClient({ steps: [steps("2026-10-20", "850")] });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect((await daily()).map((r) => [r.metric, r.local_date, r.value, r.source])).toEqual([
      ["rhr", "2026-10-20", 60, "gh"], ["steps", "2026-10-20", 850, "gh"], ["steps", "2026-10-20", 77, "manual"],
    ]);
  });

  it("re-reads at most 31 local dates per run and advances the row to UTC midnight of the range end minus 14 h", async () => {
    const start = at("2026-08-01T10:00:00Z");
    await queue("steps", start, at("2026-10-01T10:00:00Z"), "UPSERT", NOW - 60, 1);
    const { client, calls } = fakeClient();
    await drainSyncPending(drainEnv(), client, opts);
    expect(calls.map((c) => [c.start, c.end])).toEqual([["2026-08-01", "2026-09-01"]]);
    expect(await pending()).toEqual([
      { data_type: "steps", start_ts: at("2026-08-31T10:00:00Z"), end_ts: at("2026-10-01T10:00:00Z"), operation: "UPSERT", received_at: NOW - 60, attempts: 1 }]);
  });

  it("loses no date across the spring DST change over successive runs", async () => {
    // 1 Mar 2026 23:30 in Madrid (CET) is 22:30Z.
    await queue("steps", at("2026-03-01T22:30:00Z"), at("2026-04-15T10:00:00Z"));
    const { client, calls } = fakeClient();
    for (let i = 0; i < 3; i++) await drainSyncPending(drainEnv(), client, opts);
    expect(calls.map((c) => [c.start, c.end])).toEqual([["2026-03-01", "2026-04-01"], ["2026-03-31", "2026-04-16"]]);
    expect(await pending()).toEqual([]);
  });

  it("keeps a daily row re-received during the fetch and merges an advance into a queued remainder", async () => {
    await queue("steps", at("2026-10-18T10:00:00Z"), at("2026-10-18T11:00:00Z"));
    const racing = fakeClient();
    const original = racing.client.dailyRollUp.bind(racing.client);
    racing.client.dailyRollUp = async (type: string, start: string, end: string) => {
      await env.DB.prepare("UPDATE sync_pending SET received_at = ?").bind(NOW).run();
      return original(type, start, end);
    };
    expect(await drainSyncPending(drainEnv(), racing.client, opts)).toEqual({ processed: 1, failed: 0 });
    expect((await pending()).map((r) => r.received_at)).toEqual([NOW]);
    await env.DB.prepare("DELETE FROM sync_pending").run();
    const start = at("2026-08-01T10:00:00Z");
    await queue("steps", start, at("2026-10-01T10:00:00Z"), "UPSERT", NOW - 300, 2);
    await queue("steps", at("2026-08-31T10:00:00Z"), at("2026-10-01T10:00:00Z"), "UPSERT", NOW - 30, 4);
    await drainSyncPending(drainEnv(), fakeClient().client, opts);
    expect(await pending()).toEqual([
      { data_type: "steps", start_ts: at("2026-09-30T10:00:00Z"), end_ts: at("2026-10-01T10:00:00Z"), operation: "UPSERT", received_at: NOW - 30, attempts: 2 }]);
  });

  it("skips days whose total is not a number or that fall outside the range, keeping valid and zero totals", async () => {
    await queue("steps", at("2026-10-19T10:00:00Z"), at("2026-10-21T10:00:00Z"));
    const { client, calls } = fakeClient({ steps: [{ date: "2026-10-20", value: {} }, steps("2026-10-19", "12"), steps("2026-10-21", "0"),
      steps("2026-10-22", "5"), { date: "2026-10-20" }] });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect((await daily()).map((r) => [r.local_date, r.value])).toEqual([["2026-10-19", 12], ["2026-10-21", 0]]);
    expect(await pending()).toEqual([]);
  });

  it("keeps a capped row re-received during the fetch and inserts no stale remainder", async () => {
    await queue("steps", at("2026-08-01T10:00:00Z"), at("2026-10-01T10:00:00Z"));
    const racing = fakeClient();
    const original = racing.client.dailyRollUp.bind(racing.client);
    racing.client.dailyRollUp = async (type: string, start: string, end: string) => {
      await env.DB.prepare("UPDATE sync_pending SET received_at = ?").bind(NOW).run();
      return original(type, start, end);
    };
    await drainSyncPending(drainEnv(), racing.client, opts);
    expect(await pending()).toEqual([
      { data_type: "steps", start_ts: at("2026-08-01T10:00:00Z"), end_ts: at("2026-10-01T10:00:00Z"), operation: "UPSERT", received_at: NOW, attempts: 0 }]);
  });
});

describe("AC2 resting heart rate", () => {
  it("lists daily RHR for the touched dates and stores it as rhr", async () => {
    await seedDaily("rhr", "2026-10-19", 70);
    await queue("daily-resting-heart-rate", at("2026-10-19T10:00:00Z"), at("2026-10-20T10:00:00Z"));
    const { client, calls } = fakeClient({ rhr: [rhr(2026, 10, 20, "64")] });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toEqual([{ method: "listDaily", type: "daily-resting-heart-rate", start: "2026-10-19", end: "2026-10-21" }]);
    expect((await daily()).map((r) => [r.metric, r.local_date, r.value])).toEqual([["rhr", "2026-10-20", 64]]);
    expect(await pending()).toEqual([]);
  });

  it("zero-pads Google's civil dates and ignores items outside the range or without a value", async () => {
    await queue("daily-resting-heart-rate", at("2026-01-09T10:00:00Z"), at("2026-01-09T11:00:00Z"));
    const { client } = fakeClient({ rhr: [rhr(2026, 1, 9, "58"), rhr(2026, 1, 12, "59"),
      { dailyRestingHeartRate: { date: { year: 2026, month: 1, day: 9 } } }, { dailyRestingHeartRate: { beatsPerMinute: "70" } }, {}] });
    await drainSyncPending(drainEnv(), client, opts);
    expect((await daily()).map((r) => [r.local_date, r.value])).toEqual([["2026-01-09", 58]]);
  });
});

describe("AC1/AC2 impossible dates", () => {
  it("skips impossible calendar dates and keeps valid leap days for both daily types", async () => {
    await queue("steps", at("2028-02-28T10:00:00Z"), at("2028-03-01T10:00:00Z"));
    await queue("daily-resting-heart-rate", at("2028-02-28T10:00:00Z"), at("2028-03-01T10:00:00Z"));
    const { client } = fakeClient({
      steps: [steps("2028-02-29", "100"), steps("2028-02-30", "999")],
      rhr: [rhr(2028, 2, 29, "57"), rhr(2028, 2, 30, "99"), rhr(2028, 2, 0, "98")],
    });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 2, failed: 0 });
    expect((await daily()).map((r) => [r.metric, r.local_date, r.value])).toEqual([["rhr", "2028-02-29", 57], ["steps", "2028-02-29", 100]]);
  });
});

describe("AC3 queued rows", () => {
  it("drains all daily rows globally oldest first", async () => {
    await queue("steps", at("2026-10-18T10:00:00Z"), at("2026-10-18T11:00:00Z"), "UPSERT", NOW - 30);
    await queue("steps", at("2026-10-17T10:00:00Z"), at("2026-10-17T11:00:00Z"), "UPSERT", NOW - 90);
    await queue("daily-resting-heart-rate", at("2026-10-18T10:00:00Z"), at("2026-10-18T11:00:00Z"));
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 3, failed: 0 });
    expect(calls.map((c) => [c.method, c.start])).toEqual([["dailyRollUp", "2026-10-17"], ["listDaily", "2026-10-18"], ["dailyRollUp", "2026-10-18"]]);
    expect(await pending()).toEqual([]);
  });

  it("counts a failure per type and keeps going with the other types", async () => {
    await queue("steps", at("2026-10-18T10:00:00Z"), at("2026-10-18T11:00:00Z"));
    await queue("daily-resting-heart-rate", at("2026-10-18T10:00:00Z"), at("2026-10-18T11:00:00Z"));
    const { client } = fakeClient({ steps: new Error("503"), rhr: [rhr(2026, 10, 18, "61")] });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 1 });
    expect((await pending()).map((r) => [r.data_type, r.attempts])).toEqual([["steps", 1]]);
    expect((await daily()).map((r) => r.value)).toEqual([61]);
  });

  it("stops a daily row at 5 attempts and drains the next eligible row of that type", async () => {
    await queue("daily-resting-heart-rate", at("2026-10-15T10:00:00Z"), at("2026-10-15T11:00:00Z"), "UPSERT", NOW - 900, 4);
    const failing = fakeClient({ rhr: new Error("503") });
    expect(await drainSyncPending(drainEnv(), failing.client, opts)).toEqual({ processed: 0, failed: 1 });
    await queue("daily-resting-heart-rate", at("2026-10-18T10:00:00Z"), at("2026-10-18T11:00:00Z"), "UPSERT", NOW - 30);
    const ok = fakeClient();
    expect(await drainSyncPending(drainEnv(), ok.client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(ok.calls.map((c) => c.start)).toEqual(["2026-10-18"]);
    expect((await pending()).map((r) => r.attempts)).toEqual([5]);
  });

  it("rolls back a type's writes and counts a failure when its queue mutation fails", async () => {
    await seedDaily("steps", "2026-10-18", 10);
    await queue("steps", at("2026-10-18T10:00:00Z"), at("2026-10-18T11:00:00Z"));
    await env.DB.prepare("CREATE TRIGGER fail_queue BEFORE DELETE ON sync_pending BEGIN SELECT RAISE(ABORT, 'queue write failed'); END").run();
    expect(await drainSyncPending(drainEnv(), fakeClient({ steps: [] }).client, opts)).toEqual({ processed: 0, failed: 1 });
    await env.DB.prepare("DROP TRIGGER fail_queue").run();
    expect((await daily()).map((r) => r.value)).toEqual([10]);
    expect(await pending()).toHaveLength(1);
    expect((await pending()).map((r) => r.attempts)).toEqual([1]);
  });
});
