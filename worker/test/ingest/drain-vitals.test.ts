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

async function queue(type: string, start: string, end: string, receivedAt = NOW - 60) {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES (?, ?, ?, 'UPSERT', ?)")
    .bind(type, at(start), at(end), receivedAt).run();
}
const daily = async () => (await env.DB.prepare("SELECT metric, local_date, value FROM metric_daily ORDER BY metric, local_date").all()).results;

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

describe("AC2 order and isolation", () => {
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
