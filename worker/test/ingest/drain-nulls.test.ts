import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainSyncPending } from "../../src/ingest/drain";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T00:00:00Z");
const drainEnv = () => ({ DB: env.DB, USER_TZ: "Europe/Madrid" });
const opts = { now: () => NOW };
const date = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return { year: y, month: m, day: dd }; };

function fakeClient(lists: Record<string, unknown[]> = {}, rollups: Record<string, unknown[]> = {}, sleep: unknown[] = []) {
  return {
    rollUpSteps: () => Promise.resolve([]),
    rollUpHeartRate: () => Promise.reject(new Error("unexpected rollUpHeartRate")),
    reconcile: () => Promise.resolve(sleep),
    dailyRollUp: (type: string) => Promise.resolve((rollups[type] ?? []) as { date: string; value: unknown }[]),
    listDaily: (type: string) => Promise.resolve(lists[type] ?? []),
  };
}
async function queue(type: string, start: string, end: string) {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES (?, ?, ?, 'UPSERT', ?)")
    .bind(type, at(start), at(end), NOW - 60).run();
}
const daily = async () => (await env.DB.prepare("SELECT metric, local_date, value FROM metric_daily ORDER BY metric, local_date").all()).results;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch(["sync_pending", "metric_daily", "sleep_stage", "sleep_session"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("AC1 no fake zeros", () => {
  it("skips null, empty-string and boolean values instead of storing 0", async () => {
    for (const t of ["daily-resting-heart-rate", "daily-oxygen-saturation", "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "steps"]) {
      await queue(t, "2026-10-06T10:00:00Z", "2026-10-08T10:00:00Z");
    }
    const client = fakeClient({
      "daily-resting-heart-rate": [
        { dailyRestingHeartRate: { date: date("2026-10-06"), beatsPerMinute: null } },
        { dailyRestingHeartRate: { date: date("2026-10-07"), beatsPerMinute: "" } },
        { dailyRestingHeartRate: { date: date("2026-10-08"), beatsPerMinute: "61" } }],
      "daily-oxygen-saturation": [
        { dailyOxygenSaturation: { date: date("2026-10-06"), averagePercentage: true } },
        { dailyOxygenSaturation: { date: date("2026-10-07"), averagePercentage: "  " } },
        { dailyOxygenSaturation: { date: date("2026-10-08"), averagePercentage: ["3"] } }],
      "daily-respiratory-rate": [
        { dailyRespiratoryRate: { date: date("2026-10-06"), breathsPerMinute: [] } },
        { dailyRespiratoryRate: { date: date("2026-10-07"), breathsPerMinute: [0] } },
        { dailyRespiratoryRate: { date: date("2026-10-08"), breathsPerMinute: { valueOf: () => 5 } } }],
      "daily-sleep-temperature-derivations": [
        { dailySleepTemperatureDerivations: { date: date("2026-10-06"), nightlyTemperatureCelsius: 34.4, baselineTemperatureCelsius: null } },
        { dailySleepTemperatureDerivations: { date: date("2026-10-07"), nightlyTemperatureCelsius: null, baselineTemperatureCelsius: 34 } },
        { dailySleepTemperatureDerivations: { date: date("2026-10-08"), nightlyTemperatureCelsius: 34.5, baselineTemperatureCelsius: 34 } }],
    }, {
      "active-zone-minutes": [
        { date: "2026-10-06", value: { sumInCardioHeartZone: null, sumInFatBurnHeartZone: "5" } },
        { date: "2026-10-07", value: { sumInFatBurnHeartZone: "" } },
        { date: "2026-10-08", value: { sumInFatBurnHeartZone: "7" } }],
      steps: [{ date: "2026-10-06", value: { countSum: null } }, { date: "2026-10-07", value: { countSum: "" } }, { date: "2026-10-08", value: { countSum: "0" } }],
    });
    await drainSyncPending(drainEnv(), client, opts);
    expect(await daily()).toEqual([
      { metric: "azm", local_date: "2026-10-08", value: 7 },
      { metric: "rhr", local_date: "2026-10-08", value: 61 },
      { metric: "skin_temp_dev", local_date: "2026-10-08", value: 0.5 },
      { metric: "steps", local_date: "2026-10-08", value: 0 },
    ]);
  });

  it("stores NULL, not 0, for empty or null sleep summary values", async () => {
    await queue("sleep", "2026-10-06T21:00:00Z", "2026-10-07T05:00:00Z");
    const client = fakeClient({}, {}, [{
      dataPointName: "users/1/dataTypes/sleep/dataPoints/n",
      sleep: {
        interval: { startTime: "2026-10-06T21:15:00Z", startUtcOffset: "7200s", endTime: "2026-10-07T04:48:00Z", endUtcOffset: "7200s" },
        metadata: { mainSleep: true },
        summary: { minutesAsleep: "", minutesInSleepPeriod: null, minutesToFallAsleep: "3", minutesAwake: " ",
          stagesSummary: [{ type: "DEEP", minutes: null }, { type: "REM", minutes: "" }, { type: "LIGHT", minutes: "0" }, { type: "AWAKE", minutes: ["4"] }] },
      },
    }]);
    await drainSyncPending(drainEnv(), client, opts);
    expect(await env.DB.prepare("SELECT minutes_asleep, minutes_in_bed, latency_min, deep_min, rem_min, light_min FROM sleep_session").first())
      .toEqual({ minutes_asleep: null, minutes_in_bed: null, latency_min: 3, deep_min: null, rem_min: null, light_min: 0 });
    expect(await env.DB.prepare("SELECT awake_min FROM sleep_session").first()).toEqual({ awake_min: null });
  });
});
