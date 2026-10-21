import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drainSyncPending } from "../../src/ingest/drain";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T00:00:00Z");
const START = at("2026-10-02T00:00:00Z");
const END = START + 86400;
const ID = "users/1/dataTypes/exercise/dataPoints/";
const opts = { now: () => NOW };
const drainEnv = () => ({ DB: env.DB, USER_TZ: "Europe/Madrid" });

function workout(id: unknown = `${ID}probe`, fields: Record<string, unknown> = {}, interval: Record<string, unknown> = {}) {
  return { dataPointName: id, exercise: {
    interval: { startTime: "2026-10-02T12:19:23Z", startUtcOffset: "7200s", endTime: "2026-10-02T13:14:34Z", endUtcOffset: "7200s", ...interval },
    exerciseType: "CARDIO_WORKOUT", metricsSummary: { caloriesKcal: 336, averageHeartRateBeatsPerMinute: "119",
      activeZoneMinutes: "40", heartRateZoneDurations: { lightTime: "1080s" } },
    displayName: "Actividad", activeDuration: "3311s", ...fields,
  } };
}
function fakeClient(reply: unknown[] | Error = []) {
  const calls: { type: string; start: string; end: string }[] = [];
  return { calls, client: {
    rollUpHeartRate: () => Promise.reject(new Error("unexpected rollUpHeartRate")),
    dailyRollUp: () => Promise.reject(new Error("unexpected dailyRollUp")),
    listDaily: () => Promise.reject(new Error("unexpected listDaily")),
    reconcile(type: string, start: string, end: string) {
      calls.push({ type, start, end });
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  } };
}
async function queue(start = START, end = END, operation = "UPSERT", received = NOW - 60, attempts = 0, type = "exercise") {
  await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(type, start, end, operation, received, attempts).run();
}
async function seed(id: string, start = START, end = END, source = "gh") {
  await env.DB.prepare("INSERT INTO workout (source_id, source, type, start_ts, end_ts, tz_offset_min, local_date, updated_at) VALUES (?, ?, 'OLD', ?, ?, 0, '2026-10-02', 1)")
    .bind(id, source, start, end).run();
}
const rows = async () => (await env.DB.prepare("SELECT * FROM workout ORDER BY source_id").all()).results;
const pending = async () => (await env.DB.prepare("SELECT start_ts, end_ts, operation, received_at, attempts FROM sync_pending WHERE data_type = 'exercise' ORDER BY start_ts").all()).results;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DROP TRIGGER IF EXISTS fail_workouts"), env.DB.prepare("DELETE FROM workout"), env.DB.prepare("DELETE FROM sync_pending")]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("T10f AC3/AC4 exercise drain", () => {
  it.each(["UPSERT", "DELETE"])("reconciles once for %s, maps the probe and removes the queue in one batch", async (operation) => {
    await queue(START, END, operation);
    const { client, calls } = fakeClient([workout()]);
    const batch = vi.spyOn(env.DB, "batch");
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(calls).toEqual([{ type: "exercise", start: "2026-10-02T00:00:00.000Z", end: "2026-10-03T00:01:00.000Z" }]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([{
      source_id: `${ID}probe`, source: "gh", type: "CARDIO_WORKOUT", start_ts: at("2026-10-02T12:19:23Z"), end_ts: at("2026-10-02T13:14:34Z"),
      tz_offset_min: 120, local_date: "2026-10-02", duration_min: 3311 / 60, avg_hr: 119, max_hr: null,
      kcal: 336, azm: 40, distance_m: null, updated_at: NOW,
    }]);
    expect(await pending()).toEqual([]);
  });

  it("replaces gh rows by start in the half-open window, preserving other sources and boundaries", async () => {
    for (const [id, start, end, source] of [
      ["lower", START, END + 900, "gh"], ["last", END + 59, END + 900, "gh"],
      ["upper", END + 60, END + 900, "gh"], ["before", START - 1, START + 1, "gh"],
      ["manual", START + 1, START + 100, "manual"],
    ] as const) await seed(id, start, end, source);
    await queue();
    await drainSyncPending(drainEnv(), fakeClient().client, opts);
    expect((await rows()).map((r) => r.source_id)).toEqual(["before", "manual", "upper"]);
    expect(await pending()).toEqual([]);
  });

  it("upserts a source_id whose old start was outside the window", async () => {
    await seed(`${ID}probe`, START - 86400, START - 1);
    await queue();
    await drainSyncPending(drainEnv(), fakeClient([workout()]).client, opts);
    expect(await rows()).toEqual([expect.objectContaining({ source_id: `${ID}probe`, start_ts: at("2026-10-02T12:19:23Z"), type: "CARDIO_WORKOUT" })]);
  });

  it("uses the start offset and floored instants across local midnight, accepting fractional and offset timestamps", async () => {
    await queue();
    await drainSyncPending(drainEnv(), fakeClient([
      workout("a", {}, { startTime: "2026-10-02T23:30:00.999999Z", endTime: "2026-10-03T00:15:00.123456Z", endUtcOffset: "-18000s" }),
      workout("b", {}, { startTime: "2026-10-02T01:00:00.999-02:00", endTime: "2026-10-02T04:00:00.123Z", startUtcOffset: "-18000s" }),
      workout("c", {}, { startTime: "2026-10-02T19:00:00Z", endTime: "2026-10-02T20:00:00Z", startUtcOffset: "19800s" }),
    ]).client, opts);
    expect((await rows()).map((r) => [r.start_ts, r.end_ts, r.tz_offset_min, r.local_date])).toEqual([
      [at("2026-10-02T23:30:00Z"), at("2026-10-03T00:15:00Z"), 120, "2026-10-03"],
      [at("2026-10-02T03:00:00Z"), at("2026-10-02T04:00:00Z"), -300, "2026-10-01"],
      [at("2026-10-02T19:00:00Z"), at("2026-10-02T20:00:00Z"), 330, "2026-10-03"],
    ]);
  });

  it.each([undefined, null, "", "bad", "-60s", "+60s", "1e3s", " 60s", "60", 60, "1.s", ".5s"])("falls back to floored interval duration for activeDuration %j", async (activeDuration) => {
    await queue();
    await drainSyncPending(drainEnv(), fakeClient([workout("fallback", { activeDuration }, {
      startTime: "2026-10-02T12:00:00.999Z", endTime: "2026-10-02T12:02:01.001Z",
    })]).client, opts);
    expect((await rows()).map((r) => r.duration_min)).toEqual([121 / 60]);
  });

  it("accepts zero and decimal active durations and converts numeric metric strings and distance millimeters", async () => {
    await queue();
    await drainSyncPending(drainEnv(), fakeClient([
      workout("a", { activeDuration: "0s", metricsSummary: { averageHeartRateBeatsPerMinute: "0", caloriesKcal: 0,
        activeZoneMinutes: "0", distanceMillimeters: "1234567", maxHeartRateBeatsPerMinute: 200 } }),
      workout("b", { activeDuration: "90.5s", metricsSummary: { averageHeartRateBeatsPerMinute: 123.5, caloriesKcal: "12.5", activeZoneMinutes: 4, distanceMillimeters: 2000 } }),
    ]).client, opts);
    expect((await rows()).map((r) => [r.duration_min, r.avg_hr, r.max_hr, r.kcal, r.azm, r.distance_m])).toEqual([
      [0, 0, null, 0, 0, 1234.567], [90.5 / 60, 123.5, null, 12.5, 4, 2],
    ]);
  });

  it.each([undefined, null, {}, { averageHeartRateBeatsPerMinute: " ", caloriesKcal: true, activeZoneMinutes: [], distanceMillimeters: {} },
    { averageHeartRateBeatsPerMinute: "NaN", caloriesKcal: "Infinity", activeZoneMinutes: "x", distanceMillimeters: "bad" }])("keeps absent or invalid metrics null: %j", async (metricsSummary) => {
    await queue();
    await drainSyncPending(drainEnv(), fakeClient([workout("nulls", { metricsSummary })]).client, opts);
    expect((await rows()).map((r) => [r.avg_hr, r.max_hr, r.kcal, r.azm, r.distance_m])).toEqual([[null, null, null, null, null]]);
  });

  it("skips invalid identifiers, intervals and offsets while keeping valid siblings and quoted unknown types", async () => {
    await queue();
    const invalid = [null, {}, { exercise: null }, workout("no-interval", { interval: undefined }), ...[undefined, null, 12, ""].map((id) => ({ ...workout(), dataPointName: id })),
      ...[undefined, null, 12, ""].map((exerciseType) => workout("type", { exerciseType })),
      ...[undefined, null, 7200, "", "2h", "+7200s", "1s", "60.0s"].map((startUtcOffset) => workout("offset", {}, { startUtcOffset })),
      ...[undefined, "bad", "2026-10-02", "2026-10-02T12:00:00", "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-10-02T24:00:00Z",
        "2026-10-02T12:60:00Z", "2026-10-02T12:00:60Z"].flatMap((instant) => [
        workout("start", {}, { startTime: instant }), workout("end", {}, { endTime: instant }),
      ]), workout("equal", {}, { endTime: "2026-10-02T12:19:23Z" }), workout("reverse", {}, { endTime: "2026-10-02T12:00:00Z" })];
    await drainSyncPending(drainEnv(), fakeClient([...invalid, workout("owner's \"id\"", { exerciseType: "UNKNOWN 'type'" })]).client, opts);
    expect((await rows()).map((r) => [r.source_id, r.type])).toEqual([["owner's \"id\"", "UNKNOWN 'type'"]]);
    expect(await pending()).toEqual([]);
  });

  it("rejects impossible end dates that Date.parse would normalize, keeping a real leap day", async () => {
    await queue();
    await drainSyncPending(drainEnv(), fakeClient([
      workout("bad-end", {}, { startTime: "2026-02-28T00:00:00Z", endTime: "2026-02-30T00:00:00Z" }),
      workout("bad-leap-end", {}, { startTime: "2026-02-28T00:00:00Z", endTime: "2026-02-29T00:00:00Z" }),
      workout("leap", {}, { startTime: "2028-02-29T00:00:00Z", endTime: "2028-02-29T01:00:00Z" }),
    ]).client, opts);
    expect((await rows()).map((r) => r.source_id)).toEqual(["leap"]);
  });

  it("compares intervals before flooring and stores any non-empty identifier or type verbatim", async () => {
    await queue();
    await drainSyncPending(drainEnv(), fakeClient([workout(" ", { exerciseType: " ", activeDuration: undefined }, {
      startTime: "2026-10-02T12:00:00.100123Z", endTime: "2026-10-02T12:00:00.200999Z", startUtcOffset: "0s",
    })]).client, opts);
    expect(await rows()).toEqual([expect.objectContaining({ source_id: " ", type: " ", tz_offset_min: 0,
      start_ts: at("2026-10-02T12:00:00Z"), end_ts: at("2026-10-02T12:00:00Z"), duration_min: 0 })]);
  });

  it("keeps the last valid duplicate and never lets a later invalid item erase it", async () => {
    await queue();
    await drainSyncPending(drainEnv(), fakeClient([workout("dup"), workout("dup", { exerciseType: "LAST", activeDuration: "60s" }),
      workout("dup", { exerciseType: "" }), workout("dup", {}, { startUtcOffset: "1s" })]).client, opts);
    expect(await rows()).toEqual([expect.objectContaining({ source_id: "dup", type: "LAST", duration_min: 1 })]);
  });

  it("writes eight workouts in one atomic batch with at most 100 bindings per statement and replays without duplicates", async () => {
    const reply = Array.from({ length: 8 }, (_, i) => workout(`${ID}${String(i)}`));
    await queue();
    const prepare = env.DB.prepare.bind(env.DB);
    const sizes: number[] = [];
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...values: unknown[]) => {
        sizes.push(values.length);
        expect(values.length).toBeLessThanOrEqual(100);
        return bind(...values);
      });
      return statement;
    });
    const batch = vi.spyOn(env.DB, "batch");
    expect(await drainSyncPending(drainEnv(), fakeClient(reply).client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(sizes.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(100);
    const first = await rows();
    expect(first).toHaveLength(8);
    await queue();
    batch.mockClear();
    await drainSyncPending(drainEnv(), fakeClient(reply).client, opts);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual(first);
    expect(await pending()).toEqual([]);
  });
});

describe("T10f AC3 exercise queue and failures", () => {
  it("caps at seven days, merges the remainder with newest receipt and lowest attempts", async () => {
    await queue(START, START + 19 * 86400, "DELETE", NOW - 300, 2);
    await queue(START + 7 * 86400, START + 19 * 86400, "DELETE", NOW - 30, 4);
    const { client, calls } = fakeClient();
    await drainSyncPending(drainEnv(), client, opts);
    expect(calls).toEqual([{ type: "exercise", start: "2026-10-02T00:00:00.000Z", end: "2026-10-09T00:00:00.000Z" }]);
    expect(await pending()).toEqual([{ start_ts: START + 7 * 86400, end_ts: START + 19 * 86400, operation: "DELETE", received_at: NOW - 30, attempts: 2 }]);
  });

  it.each([7 * 86400 - 60, 7 * 86400, 15 * 86400])("covers a %i-second row over successive capped windows with the final minute", async (span) => {
    await queue(START, START + span);
    const { client, calls } = fakeClient();
    for (let i = 0; i < 4; i++) await drainSyncPending(drainEnv(), client, opts);
    const windows: [string, string][] = [];
    for (let start = START; start < START + span + 60; start += 7 * 86400) windows.push([
      new Date(start * 1000).toISOString(), new Date(Math.min(start + 7 * 86400, START + span + 60) * 1000).toISOString(),
    ]);
    expect(calls.map((c) => [c.start, c.end])).toEqual(windows);
    expect(await pending()).toEqual([]);
  });

  it("processes only the oldest eligible exercise row, leaving exhausted rows", async () => {
    await queue(START, END, "UPSERT", NOW - 900, 5);
    await queue(END, END + 60, "UPSERT", NOW - 30);
    await queue(END + 60, END + 120, "UPSERT", NOW - 90);
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 0 });
    expect(calls.map((c) => c.start)).toEqual(["2026-10-03T00:01:00.000Z"]);
    expect((await pending()).map((r) => r.attempts)).toEqual([5, 0]);
  });

  it.each([86400, 19 * 86400])("preserves a row re-received during a %i-second fetch without creating a remainder", async (span) => {
    await queue(START, START + span);
    const { client } = fakeClient();
    client.reconcile = async () => {
      await env.DB.prepare("UPDATE sync_pending SET received_at = ?").bind(NOW).run();
      return [];
    };
    await drainSyncPending(drainEnv(), client, opts);
    expect(await pending()).toEqual([{ start_ts: START, end_ts: START + span, operation: "UPSERT", received_at: NOW, attempts: 0 }]);
  });

  it("keeps workouts and increments attempts when Google fails", async () => {
    await seed("old");
    await queue();
    const before = await rows();
    const { client, calls } = fakeClient(new Error("503"));
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 0, failed: 1 });
    expect(calls).toHaveLength(1);
    expect(await rows()).toEqual(before);
    expect(await pending()).toEqual([{ start_ts: START, end_ts: END, operation: "UPSERT", received_at: NOW - 60, attempts: 1 }]);
  });

  it("continues to exercise after another type fails", async () => {
    await queue(START, END, "UPSERT", NOW - 60, 0, "steps");
    await queue();
    const { client, calls } = fakeClient();
    expect(await drainSyncPending(drainEnv(), client, opts)).toEqual({ processed: 1, failed: 1 });
    expect(calls.map((c) => c.type)).toEqual(["exercise"]);
    expect(await pending()).toEqual([]);
  });

  it("rejects when the attempts update fails and preserves all stored state", async () => {
    await seed("old");
    await queue();
    const before = [await rows(), await pending()];
    await env.DB.prepare("CREATE TRIGGER fail_workouts BEFORE UPDATE ON sync_pending BEGIN SELECT RAISE(ABORT, 'attempt failed'); END").run();
    await expect(drainSyncPending(drainEnv(), fakeClient(new Error("503")).client, opts)).rejects.toThrow();
    expect([await rows(), await pending()]).toEqual(before);
  });

  it.each(["INSERT ON workout", "DELETE ON sync_pending"])("rolls back deletes, upserts and queue removal if %s fails", async (target) => {
    await seed("old");
    await queue();
    const before = [await rows(), await pending()];
    await env.DB.prepare(`CREATE TRIGGER fail_workouts BEFORE ${target} BEGIN SELECT RAISE(ABORT, 'batch failed'); END`).run();
    expect(await drainSyncPending(drainEnv(), fakeClient([workout()]).client, opts)).toEqual({ processed: 0, failed: 1 });
    expect(await rows()).toEqual(before[0]);
    expect(await pending()).toEqual(before[1].map((row) => ({ ...row, attempts: 1 })));
  });
});
