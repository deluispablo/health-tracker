import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainSyncPending } from "../../src/ingest/drain";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T00:00:00Z");
const drainEnv = () => ({ DB: env.DB, USER_TZ: "Europe/Madrid" });
const opts = { now: () => NOW };

interface Call { method: string; type: string; start: string; end: string }
function fakeClient(lists: Record<string, unknown[] | Error> = {}, rollups: Record<string, unknown[] | Error> = {}) {
  const calls: Call[] = [];
  const answer = (r: unknown[] | Error | undefined) => r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? []);
  return {
    calls,
    client: {
      rollUpSteps: () => Promise.resolve([]),
      rollUpHeartRate: () => Promise.reject(new Error("unexpected rollUpHeartRate")),
      reconcile: () => Promise.reject(new Error("unexpected reconcile")),
      dailyRollUp(type: string, start: string, end: string) {
        calls.push({ method: "dailyRollUp", type, start, end });
        return answer(rollups[type]) as Promise<{ date: string; value: unknown }[]>;
      },
      listDaily(type: string, start: string, end: string) {
        calls.push({ method: "listDaily", type, start, end });
        return answer(lists[type]);
      },
    },
  };
}
const date = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return { year: y, month: m, day: dd }; };

async function queue(type: string, start: string, end: string, receivedAt = NOW - 60, operation = "UPSERT", attempts = 0) {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(type, at(start), at(end), operation, receivedAt, attempts).run();
}
const daily = async () => (await env.DB.prepare("SELECT metric, local_date, value FROM metric_daily ORDER BY metric, local_date").all()).results;
const pending = async () => (await env.DB.prepare(
  "SELECT data_type, start_ts, end_ts, operation, received_at, attempts FROM sync_pending ORDER BY data_type, start_ts").all()).results;

// One valid answer item per vital type for a date and value, in Google's shape.
const VITALS: { type: string; metric: string; via: "list" | "rollup"; item: (d: string, v: number) => unknown }[] = [
  { type: "daily-heart-rate-variability", metric: "hrv_rmssd", via: "list",
    item: (d, v) => ({ dailyHeartRateVariability: { date: date(d), averageHeartRateVariabilityMilliseconds: v } }) },
  { type: "daily-oxygen-saturation", metric: "spo2", via: "list",
    item: (d, v) => ({ dailyOxygenSaturation: { date: date(d), averagePercentage: v } }) },
  { type: "daily-respiratory-rate", metric: "resp_rate", via: "list",
    item: (d, v) => ({ dailyRespiratoryRate: { date: date(d), breathsPerMinute: v } }) },
  { type: "daily-sleep-temperature-derivations", metric: "skin_temp_dev", via: "list",
    item: (d, v) => ({ dailySleepTemperatureDerivations: { date: date(d), nightlyTemperatureCelsius: 34 + v, baselineTemperatureCelsius: 34 } }) },
  { type: "active-zone-minutes", metric: "azm", via: "rollup",
    item: (d, v) => ({ date: d, value: { sumInFatBurnHeartZone: String(v) } }) },
];
const answering = (t: (typeof VITALS)[number], items: unknown[] | Error) =>
  t.via === "list" ? fakeClient({ [t.type]: items }) : fakeClient({}, { [t.type]: items });

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM sync_pending"), env.DB.prepare("DELETE FROM metric_daily")]);
});

describe("AC1 daily vitals mapping", () => {
  it("maps each listed daily type to its metric (shapes from spikes/S3.md)", async () => {
    const types = ["daily-heart-rate-variability", "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations"];
    for (const t of types) await queue(t, "2026-10-07T10:00:00Z", "2026-10-07T11:00:00Z");
    const { client, calls } = fakeClient({
      "daily-heart-rate-variability": [{ dailyHeartRateVariability: { date: date("2026-10-07"), averageHeartRateVariabilityMilliseconds: 38.849,
        nonRemHeartRateBeatsPerMinute: "59", deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 39.5 } }],
      "daily-oxygen-saturation": [{ dailyOxygenSaturation: { date: date("2026-10-07"), averagePercentage: 96.9, lowerBoundPercentage: 94.3 } }],
      "daily-respiratory-rate": [{ dailyRespiratoryRate: { date: date("2026-10-07"), breathsPerMinute: 16.6 } }],
      "daily-sleep-temperature-derivations": [{ dailySleepTemperatureDerivations: { date: date("2026-10-07"),
        nightlyTemperatureCelsius: 34.361741682974589, baselineTemperatureCelsius: 34.325089775875092 } }],
    });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 4, failed: 0 });
    expect(calls.map((c) => [c.method, c.type, c.start, c.end])).toEqual(types.map((t) => ["listDaily", t, "2026-10-07", "2026-10-08"]));
    const rows = await daily();
    expect(rows.map((r) => r.metric)).toEqual(["hrv_rmssd", "resp_rate", "skin_temp_dev", "spo2"]);
    expect(rows.find((r) => r.metric === "hrv_rmssd")?.value).toBe(38.849);
    expect(rows.find((r) => r.metric === "resp_rate")?.value).toBe(16.6);
    expect(rows.find((r) => r.metric === "spo2")?.value).toBe(96.9);
    expect(rows.find((r) => r.metric === "skin_temp_dev")?.value).toBeCloseTo(34.361741682974589 - 34.325089775875092, 12);
  });

  it("sums the three heart-zone values of the AZM daily rollup", async () => {
    await queue("active-zone-minutes", "2026-10-05T10:00:00Z", "2026-10-06T11:00:00Z");
    const { client, calls } = fakeClient({}, { "active-zone-minutes": [
      { date: "2026-10-06", value: { sumInCardioHeartZone: "14", sumInPeakHeartZone: "0", sumInFatBurnHeartZone: "81" } },
      { date: "2026-10-05", value: { sumInFatBurnHeartZone: "3" } },
    ] });
    await drainSyncPending(drainEnv(), client, opts);
    expect(calls).toEqual([{ method: "dailyRollUp", type: "active-zone-minutes", start: "2026-10-05", end: "2026-10-07" }]);
    expect(await daily()).toEqual([{ metric: "azm", local_date: "2026-10-05", value: 3 }, { metric: "azm", local_date: "2026-10-06", value: 95 }]);
  });

  it("skips items whose value is missing or not a finite number, and a temperature without both parts", async () => {
    await queue("daily-respiratory-rate", "2026-10-06T10:00:00Z", "2026-10-07T11:00:00Z");
    await queue("daily-sleep-temperature-derivations", "2026-10-06T10:00:00Z", "2026-10-07T11:00:00Z");
    await queue("active-zone-minutes", "2026-10-06T10:00:00Z", "2026-10-07T11:00:00Z");
    const { client } = fakeClient({
      "daily-respiratory-rate": [{ dailyRespiratoryRate: { date: date("2026-10-06") } }, { dailyRespiratoryRate: { date: date("2026-10-07"), breathsPerMinute: "x" } }],
      "daily-sleep-temperature-derivations": [{ dailySleepTemperatureDerivations: { date: date("2026-10-06"), nightlyTemperatureCelsius: 34 } }],
    }, { "active-zone-minutes": [{ date: "2026-10-06", value: { sumInCardioHeartZone: "x" } }, { date: "2026-10-07", value: {} }] });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 3, failed: 0 });
    expect(await daily()).toEqual([]);
  });

  it("replaces stored values of the re-read dates like steps and RHR do", async () => {
    await env.DB.prepare("INSERT INTO metric_daily (metric, local_date, value, updated_at) VALUES ('spo2', '2026-10-06', 90, 1), ('spo2', '2026-10-07', 91, 1)").run();
    await queue("daily-oxygen-saturation", "2026-10-06T10:00:00Z", "2026-10-07T11:00:00Z");
    const { client } = fakeClient({ "daily-oxygen-saturation": [{ dailyOxygenSaturation: { date: date("2026-10-07"), averagePercentage: 97 } }] });
    await drainSyncPending(drainEnv(), client, opts);
    expect(await daily()).toEqual([{ metric: "spo2", local_date: "2026-10-07", value: 97 }]);
  });
});

describe.each(VITALS)("AC1 inherited daily rules: $type", (t) => {
  it("re-reads the touched local dates for DELETE too, replacing only gh rows of that metric in range", async () => {
    await env.DB.prepare(`INSERT INTO metric_daily (metric, local_date, value, source, updated_at) VALUES
      (?, '2026-10-05', 1, 'gh', 1), (?, '2026-10-06', 2, 'gh', 1), (?, '2026-10-06', 3, 'manual', 1), ('rhr', '2026-10-06', 60, 'gh', 1)`)
      .bind(t.metric, t.metric, t.metric).run();
    // 20:00Z..22:00Z on 6 Oct ends at local midnight in Madrid: only 6 Oct is touched.
    await queue(t.type, "2026-10-06T20:00:00Z", "2026-10-06T22:00:00Z", NOW - 60, "DELETE");
    const { client, calls } = answering(t, []);
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(calls.map((c) => [c.start, c.end])).toEqual([["2026-10-06", "2026-10-07"]]);
    const rows = (await env.DB.prepare("SELECT metric, local_date, value, source FROM metric_daily ORDER BY metric, local_date, source").all()).results;
    expect(rows).toEqual([
      ...[{ metric: t.metric, local_date: "2026-10-05", value: 1, source: "gh" }, { metric: t.metric, local_date: "2026-10-06", value: 3, source: "manual" },
        { metric: "rhr", local_date: "2026-10-06", value: 60, source: "gh" }].sort((a, b) => a.metric.localeCompare(b.metric)),
    ]);
  });

  it("stores valid items next to malformed ones and replays identically", async () => {
    await queue(t.type, "2026-10-06T10:00:00Z", "2026-10-07T10:00:00Z");
    const items = [t.item("2026-10-06", 0), t.item("2026-10-07", 5), { junk: true }, t.item("2026-10-09", 7)];
    await drainSyncPending(drainEnv(), answering(t, items).client, opts);
    const first = (await env.DB.prepare("SELECT * FROM metric_daily ORDER BY local_date").all()).results;
    expect(first.map((r) => [r.metric, r.local_date, r.value, r.source, r.source_id, r.updated_at])).toEqual([
      [t.metric, "2026-10-06", 0, "gh", null, NOW], [t.metric, "2026-10-07", 5, "gh", null, NOW]]);
    await queue(t.type, "2026-10-06T10:00:00Z", "2026-10-07T10:00:00Z");
    await drainSyncPending(drainEnv(), answering(t, items).client, opts);
    expect((await env.DB.prepare("SELECT * FROM metric_daily ORDER BY local_date").all()).results).toEqual(first);
  });

  it("caps at 31 dates, advances DST-safely, merges remainders and keeps a re-received row", async () => {
    await queue(t.type, "2026-03-01T22:30:00Z", "2026-04-15T10:00:00Z", NOW - 300, "UPSERT", 2);
    await queue(t.type, "2026-03-31T10:00:00Z", "2026-04-15T10:00:00Z", NOW - 30, "UPSERT", 4);
    const { client, calls } = answering(t, []);
    await drainSyncPending(drainEnv(), client, opts);
    expect(calls.map((c) => [c.start, c.end])).toEqual([["2026-03-01", "2026-04-01"]]);
    expect(await pending()).toEqual([{ data_type: t.type, start_ts: at("2026-03-31T10:00:00Z"), end_ts: at("2026-04-15T10:00:00Z"),
      operation: "UPSERT", received_at: NOW - 30, attempts: 2 }]);
    const racing = answering(t, []);
    const key = t.via === "list" ? "listDaily" : "dailyRollUp";
    const original = racing.client[key].bind(racing.client);
    racing.client[key] = async (type: string, start: string, end: string) => {
      await env.DB.prepare("UPDATE sync_pending SET received_at = ?").bind(NOW).run();
      return original(type, start, end) as never;
    };
    await drainSyncPending(drainEnv(), racing.client, opts);
    expect((await pending()).map((r) => r.received_at)).toEqual([NOW]);
  });

  it("counts failures up to 5 attempts, keeps stored values, then drains the next eligible row", async () => {
    await env.DB.prepare("INSERT INTO metric_daily (metric, local_date, value, updated_at) VALUES (?, '2026-10-06', 9, 1)").bind(t.metric).run();
    await queue(t.type, "2026-10-06T10:00:00Z", "2026-10-06T11:00:00Z", NOW - 900, "UPSERT", 4);
    expect(await drainSyncPending(drainEnv(), answering(t, new Error("503")).client, opts)).toEqual({ processed: 0, failed: 1 });
    expect((await daily()).map((r) => r.value)).toEqual([9]);
    await queue(t.type, "2026-10-08T10:00:00Z", "2026-10-08T11:00:00Z", NOW - 30);
    const ok = answering(t, []);
    await drainSyncPending(drainEnv(), ok.client, opts);
    expect(ok.calls.map((c) => c.start)).toEqual(["2026-10-08"]);
    expect((await pending()).map((r) => r.attempts)).toEqual([5]);
  });

  it("counts a batch failure and rejects if the attempt write fails, preserving stored data", async () => {
    await env.DB.prepare("INSERT INTO metric_daily (metric, local_date, value, updated_at) VALUES (?, '2026-10-06', 9, 1)").bind(t.metric).run();
    await queue(t.type, "2026-10-06T10:00:00Z", "2026-10-06T11:00:00Z");
    for (const [event, reply] of [["DELETE", []], ["UPDATE", new Error("503")]] as const) {
      await env.DB.prepare(`CREATE TRIGGER fail_queue BEFORE ${event} ON sync_pending BEGIN SELECT RAISE(ABORT, 'queue write failed'); END`).run();
      try {
        const result = drainSyncPending(drainEnv(), answering(t, reply instanceof Error ? reply : [t.item("2026-10-06", 1)]).client, opts);
        if (event === "DELETE") await expect(result).resolves.toEqual({ processed: 0, failed: 1 });
        else await expect(result).rejects.toThrow();
      } finally {
        await env.DB.prepare("DROP TRIGGER fail_queue").run();
      }
      expect((await daily()).map((r) => r.value)).toEqual([9]);
      expect((await pending()).map((r) => r.attempts)).toEqual([1]);
    }
  });
});

describe("AC1 value edge cases", () => {
  it("accepts numeric strings, zero and negative temperature deviations; AZM all-zero is 0 and mixed finite/non-finite is skipped", async () => {
    await queue("daily-oxygen-saturation", "2026-10-06T10:00:00Z", "2026-10-06T11:00:00Z");
    await queue("daily-sleep-temperature-derivations", "2026-10-06T10:00:00Z", "2026-10-07T11:00:00Z");
    await queue("active-zone-minutes", "2026-10-06T10:00:00Z", "2026-10-07T11:00:00Z");
    const { client } = fakeClient({
      "daily-oxygen-saturation": [{ dailyOxygenSaturation: { date: date("2026-10-06"), averagePercentage: "95.5" } }],
      "daily-sleep-temperature-derivations": [
        { dailySleepTemperatureDerivations: { date: date("2026-10-06"), nightlyTemperatureCelsius: 34, baselineTemperatureCelsius: 34 } },
        { dailySleepTemperatureDerivations: { date: date("2026-10-07"), nightlyTemperatureCelsius: 33.5, baselineTemperatureCelsius: 34 } }],
    }, { "active-zone-minutes": [
      { date: "2026-10-06", value: { sumInCardioHeartZone: "0", sumInPeakHeartZone: "0", sumInFatBurnHeartZone: "0" } },
      { date: "2026-10-07", value: { sumInCardioHeartZone: "5", sumInPeakHeartZone: "NaN" } }] });
    await drainSyncPending(drainEnv(), client, opts);
    expect(await daily()).toEqual([
      { metric: "azm", local_date: "2026-10-06", value: 0 },
      { metric: "skin_temp_dev", local_date: "2026-10-06", value: 0 }, { metric: "skin_temp_dev", local_date: "2026-10-07", value: -0.5 },
      { metric: "spo2", local_date: "2026-10-06", value: 95.5 }]);
  });

  it("skips invalid dates for listed vitals", async () => {
    await queue("daily-respiratory-rate", "2026-10-06T10:00:00Z", "2026-10-07T11:00:00Z");
    const { client } = fakeClient({ "daily-respiratory-rate": [
      { dailyRespiratoryRate: { date: { year: 2026, month: 2, day: 30 }, breathsPerMinute: 15 } },
      { dailyRespiratoryRate: { breathsPerMinute: 15 } },
      { dailyRespiratoryRate: { date: date("2026-10-07"), breathsPerMinute: 15 } }] });
    await drainSyncPending(drainEnv(), client, opts);
    expect(await daily()).toEqual([{ metric: "resp_rate", local_date: "2026-10-07", value: 15 }]);
  });
});

describe("AC2 order and isolation", () => {
  it("runs all ten types in order, the oldest eligible row of each", async () => {
    const all = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability", "daily-oxygen-saturation",
      "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "exercise"];
    for (const t of all) {
      await queue(t, "2026-10-07T10:00:00Z", "2026-10-07T10:30:00Z", NOW - 30);
      await queue(t, "2026-10-06T10:00:00Z", "2026-10-06T10:30:00Z", NOW - 90);
    }
    const order: string[] = [];
    const { client } = fakeClient();
    const record = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => { order.push(`${name}:${String(a[0])}:${String(a[1])}`); return fn(...a); };
    client.listDaily = record("list", client.listDaily.bind(client));
    client.dailyRollUp = record("rollup", client.dailyRollUp.bind(client));
    client.reconcile = record("reconcile", () => Promise.resolve([] as never));
    client.rollUpHeartRate = record("hr", () => Promise.resolve([] as never));
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 10, failed: 0 });
    expect(order).toEqual([
      "hr:2026-10-06T10:00:00.000Z:2026-10-06T10:30:00.000Z", "rollup:steps:2026-10-06", "list:daily-resting-heart-rate:2026-10-06",
      "reconcile:sleep:2026-10-06T10:00:00.000Z", "list:daily-heart-rate-variability:2026-10-06", "list:daily-oxygen-saturation:2026-10-06",
      "list:daily-respiratory-rate:2026-10-06", "list:daily-sleep-temperature-derivations:2026-10-06", "rollup:active-zone-minutes:2026-10-06", "reconcile:exercise:2026-10-06T10:00:00.000Z"]);
    expect((await pending()).every((r) => r.start_ts === at("2026-10-07T10:00:00Z"))).toBe(true);
  });

  it("drains one row per type in the fixed order and isolates a failing type", async () => {
    const all = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability", "daily-oxygen-saturation",
      "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes"];
    for (const t of all.slice(4)) await queue(t, "2026-10-07T10:00:00Z", "2026-10-07T11:00:00Z");
    const { client, calls } = fakeClient({ "daily-oxygen-saturation": new Error("503") });
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 4, failed: 1 });
    expect(calls.map((c) => c.type)).toEqual(all.slice(4));
    expect((await env.DB.prepare("SELECT data_type, attempts FROM sync_pending").all()).results).toEqual([{ data_type: "daily-oxygen-saturation", attempts: 1 }]);
  });
});
