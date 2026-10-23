import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthStatus } from "../../src/mcp/tools/status";

interface Status {
  now_local: string;
  streams: { stream: string; latest_local: string | null; age_hours: number | null }[];
  queue: { pending: number; stuck: number; oldest_received_local: string | null };
  google: { connected: boolean; token_updated_local: string | null };
  coverage: { date: string; hr_minutes: number | null }[];
  alerts: { code: string; message: string }[];
}
const readStatus: (db: D1Database, options: { now: number; tz: string }) => Promise<Status> = healthStatus;
const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T08:00:00Z");
const options = { now: NOW, tz: "Europe/Madrid" };
const codes = (out: Status) => out.alerts.map((alert) => alert.code);
const coverage = (first: string, counts: Record<string, number> = {}) => Array.from({ length: 14 }, (_, i) => {
  const date = new Date(Date.parse(`${first}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
  return { date, hr_minutes: counts[date] ?? null };
});
async function minute(ts: number, offset = 120, metric = "hr", source = "gh") {
  await env.DB.prepare("INSERT INTO metric_minute (metric, ts, tz_offset_min, value, source) VALUES (?, ?, ?, 60, ?)")
    .bind(metric, ts, offset, source).run();
}
async function token(name = "google_refresh_token") {
  await env.DB.prepare("INSERT INTO secret_blob (name, iv, ciphertext, updated_at) VALUES (?, ?, ?, ?)")
    .bind(name, new Uint8Array([255, 0, 17]), new Uint8Array([0, 255, 128, 42]), NOW - 60).run();
}
async function daily(date: string, computed = NOW, hrWearMin: number | null = null) {
  await env.DB.prepare("INSERT INTO daily_summary (local_date, computed_at, hr_wear_min) VALUES (?, ?, ?)")
    .bind(date, computed, hrWearMin).run();
}
async function sleep(end = NOW - 7200, isNap = 0, source = "gh") {
  await env.DB.prepare(`INSERT INTO sleep_session
    (source_id, source, start_ts, end_ts, tz_offset_min, local_date, is_nap, updated_at)
    VALUES (?, ?, ?, ?, 120, '2026-10-21', ?, 1)`)
    .bind(`${source}-${String(end)}-${String(isNap)}`, source, end - 28800, end, isNap).run();
}
async function watch(syncedUntil: number | null, lastError: string | null = null, dataType = "watch") {
  await env.DB.prepare("INSERT INTO sync_state (data_type, synced_until, last_ok_at, last_error) VALUES (?, ?, ?, ?)")
    .bind(dataType, syncedUntil, NOW - 60, lastError).run();
}

// Observe actual D1 reads, allowing both individual SELECTs and SELECT batches.
function selectOnlyDb(
  onRead: (sql: string, bindings: unknown[]) => void,
  onCall: (method: string) => void = () => {},
): D1Database {
  const statements = new WeakMap<object, { raw: D1PreparedStatement; sql: string; bindings: unknown[] }>();
  const check = (sql: string, bindings: unknown[]) => { expect(sql).toMatch(/^\s*SELECT\b/i); onRead(sql, bindings); };
  const wrap = (raw: D1PreparedStatement, sql: string, bindings: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(raw, { get(t, p) {
      if (p === "bind") return (...args: unknown[]) => wrap(t.bind(...args), sql, args);
      if (["first", "all", "raw", "run"].includes(String(p))) return (...args: unknown[]) => {
        onCall(String(p));
        check(sql, bindings);
        return (Reflect.get(t, p) as (...values: unknown[]) => unknown).apply(t, args);
      };
      const value: unknown = Reflect.get(t, p);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    } });
    statements.set(proxy, { raw, sql, bindings });
    return proxy;
  };
  return new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (sql: string) => { expect(sql).toMatch(/^\s*SELECT\b/i); return wrap(t.prepare(sql), sql); };
    if (p === "batch") return (batch: D1PreparedStatement[]) => {
      onCall("batch");
      return t.batch(batch.map((statement) => {
        const entry = statements.get(statement);
        if (!entry) throw new Error("unobserved statement");
        check(entry.sql, entry.bindings);
        return entry.raw;
      }));
    };
    if (p === "exec") return (sql: string) => { check(sql, []); return t.exec(sql); };
    if (p === "dump") return () => { throw new Error("unexpected dump"); };
    const value: unknown = Reflect.get(t, p);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  } });
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["metric_minute", "sleep_stage", "sleep_session", "daily_summary", "sync_pending", "sync_state", "secret_blob"]
    .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

describe("T10d AC1 health_status", () => {
  it("returns exactly the empty-database shape with ordered Spanish alerts", async () => {
    const out = await readStatus(env.DB, options);
    expect(out).toEqual({
      now_local: "2026-10-21T10:00",
      streams: [{ stream: "sleep", latest_local: null, age_hours: null }, { stream: "daily", latest_local: null, age_hours: null },
        { stream: "watch", latest_local: null, age_hours: null }],
      queue: { pending: 0, stuck: 0, oldest_received_local: null },
      google: { connected: false, token_updated_local: null },
      coverage: coverage("2026-10-08"),
      alerts: [
        { code: "google_disconnected", message: expect.any(String) as unknown },
        { code: "no_data_48h", message: expect.any(String) as unknown },
        { code: "daily_stale", message: expect.any(String) as unknown },
      ],
    });
    for (const alert of out.alerts) expect(alert.message.trim().length).toBeGreaterThan(0);
  });

  it("reports a healthy pipeline, observed metrics only, and no secret fields or raw rows", async () => {
    await token();
    await minute(NOW - 120);
    await daily("2026-10-20", NOW - 3600);
    await daily("2026-10-21", NOW - 3600, 1);
    await watch(NOW - 60);
    await env.DB.prepare(`INSERT INTO sleep_session
      (source_id, start_ts, end_ts, tz_offset_min, local_date, updated_at)
      VALUES ('night', ?, ?, 120, '2026-10-21', 1)`).bind(NOW - 36000, NOW - 7200).run();
    expect(await readStatus(env.DB, options)).toEqual({
      now_local: "2026-10-21T10:00",
      streams: [
        { stream: "metric:hr", latest_local: "2026-10-21T09:58", age_hours: 0 },
        { stream: "sleep", latest_local: "2026-10-21T08:00", age_hours: 2 },
        { stream: "daily", latest_local: "2026-10-21T09:00", age_hours: 1 },
        { stream: "watch", latest_local: "2026-10-21T09:59", age_hours: 0 },
      ],
      queue: { pending: 0, stuck: 0, oldest_received_local: null },
      google: { connected: true, token_updated_local: "2026-10-21T09:59" },
      coverage: coverage("2026-10-08", { "2026-10-21": 1 }), alerts: [],
    });
  });

  it("pairs each latest timestamp with its own offset, rounds ages, clamps future ages and prefixes metric names", async () => {
    await minute(NOW - 7200, 330);
    await minute(NOW - 4500, -300);
    await minute(NOW, 840, "hr", "other");
    await minute(NOW, 120, "other-only", "other");
    await minute(NOW + 3600, 0, "sleep");
    await minute(NOW - 3600, 60, "daily");
    await env.DB.prepare(`INSERT INTO sleep_session
      (source_id, source, start_ts, end_ts, tz_offset_min, local_date, is_nap, updated_at) VALUES
      ('later-start', 'gh', ?1, ?2, 330, '2026-10-21', 0, ?5),
      ('later-end-nap', 'gh', ?3, ?4, -300, '2026-10-21', 1, 1),
      ('other', 'other', ?1, ?5, 840, '2026-10-21', 0, ?5)`)
      .bind(NOW - 10000, NOW - 7200, NOW - 20000, NOW - 4500, NOW).run();
    await daily("2026-10-20", NOW + 3600);
    await daily("2026-10-21", NOW - 4500);
    expect((await readStatus(env.DB, options)).streams).toEqual([
      { stream: "metric:daily", latest_local: "2026-10-21T08:00", age_hours: 1 },
      { stream: "metric:hr", latest_local: "2026-10-21T01:45", age_hours: 1.3 },
      { stream: "metric:sleep", latest_local: "2026-10-21T09:00", age_hours: 0 },
      { stream: "sleep", latest_local: "2026-10-21T11:30", age_hours: 2 },
      { stream: "daily", latest_local: "2026-10-21T08:45", age_hours: 1.3 },
      { stream: "watch", latest_local: null, age_hours: null },
    ]);
  });

  it("counts all queue rows, distinguishes attempts 4 and 5, and orders all alerts", async () => {
    await token("unrelated-secret");
    await env.DB.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES
      ('hr', 0, 1, 'UPSERT', ?1, 4), ('sleep', 0, 1, 'DELETE', ?2, 5), ('steps', 0, 1, 'UPSERT', ?3, 9)`)
      .bind(NOW - 60, NOW - 7200, NOW).run();
    const out = await readStatus(env.DB, options);
    expect(out.queue).toEqual({ pending: 3, stuck: 2, oldest_received_local: "2026-10-21T08:00" });
    expect(out.google).toEqual({ connected: false, token_updated_local: null });
    expect(codes(out)).toEqual(["google_disconnected", "no_data_48h", "queue_stuck", "daily_stale"]);
    for (const alert of out.alerts) expect(alert).toEqual({ code: expect.any(String) as unknown, message: expect.any(String) as unknown });
    await env.DB.prepare("UPDATE sync_pending SET attempts = 4").run();
    expect((await readStatus(env.DB, options)).queue.stuck).toBe(0);
    expect(codes(await readStatus(env.DB, options))).not.toContain("queue_stuck");
  });

  it.each([
    ["exactly 48 hours", NOW - 172800, "gh", false],
    ["one second too old", NOW - 172801, "gh", true],
    ["exactly now", NOW, "gh", false],
    ["future only", NOW + 1, "gh", true],
    ["recent non-gh only", NOW - 60, "other", true],
  ] as const)("uses the inclusive gh HR freshness interval: %s", async (_label, ts, source, stale) => {
    await minute(ts, 120, "hr", source);
    await minute(NOW, 120, "steps");
    expect(codes(await readStatus(env.DB, options)).includes("no_data_48h")).toBe(stale);
  });

  it.each([["2026-10-20", false], ["2026-10-19", true]] as const)("judges daily staleness by local_date %s, not computed_at", async (date, stale) => {
    await daily(date, stale ? NOW : NOW - 10 * 86400);
    expect(codes(await readStatus(env.DB, options)).includes("daily_stale")).toBe(stale);
  });

  it.each([["2026-10-21", false], ["2026-10-20", true]] as const)("uses today's date in USER_TZ for now_local, coverage and yesterday: %s", async (date, stale) => {
    await daily(date);
    const out = await readStatus(env.DB, { ...options, now: at("2026-10-21T22:30:00Z") });
    expect(out.now_local).toBe("2026-10-22T00:30");
    expect(out.coverage).toEqual(coverage("2026-10-09"));
    expect(codes(out).includes("daily_stale")).toBe(stale);
  });

  it("T27 AC1 reads rounded coverage from daily summaries across the date window and DST", async () => {
    const now = at("2026-10-26T08:00:00Z");
    await daily("2026-10-12", NOW, 99);
    await daily("2026-10-13", NOW, 2.49);
    await daily("2026-10-14", NOW, null);
    await daily("2026-10-15", NOW, 0);
    await daily("2026-10-25", NOW, 2.5);
    await daily("2026-10-26", NOW, 1);
    await daily("2026-10-27", NOW, 99);
    // Raw minutes must not supply coverage, even on a date without a summary.
    await minute(at("2026-10-16T08:00:00Z"));
    const reads: string[] = [];
    const out = await readStatus(selectOnlyDb((sql) => { reads.push(sql); }), { ...options, now });
    expect(out.coverage).toEqual(
      coverage("2026-10-13", { "2026-10-13": 2, "2026-10-15": 0, "2026-10-25": 3, "2026-10-26": 1 }),
    );
    const minuteReads = reads.filter((sql) => /\bmetric_minute\b/i.test(sql));
    expect(minuteReads).not.toHaveLength(0);
    for (const sql of minuteReads) expect(sql).not.toMatch(/\bcount\s*\(|\bgroup\s+by\b|\bdate\s*\(/i);
  });
});

describe("T10e AC3 watch stream and alerts", () => {
  it.each([
    ["missing row, disconnected", undefined, false, null, null, false],
    ["missing row, connected", undefined, true, null, null, true],
    ["null timestamp, disconnected", null, false, null, null, false],
    ["null timestamp, connected", null, true, null, null, true],
    ["stale timestamp, disconnected", NOW - 86401, false, "2026-10-20T09:59", 24, false],
    ["one second under 24 hours", NOW - 86399, true, "2026-10-20T10:00", 24, false],
    ["exactly 24 hours", NOW - 86400, true, "2026-10-20T10:00", 24, false],
    ["24 hours plus one second", NOW - 86401, true, "2026-10-20T09:59", 24, true],
    ["age rounds up to 24.1", NOW - 86580, true, "2026-10-20T09:57", 24.1, true],
    ["age rounds half away from zero", NOW - 4500, true, "2026-10-21T08:45", 1.3, false],
    ["future timestamp", NOW + 3600, true, "2026-10-21T11:00", 0, false],
  ] as const)("uses elapsed age and token presence: %s", async (_label, ts, connected, latestLocal, ageHours, alert) => {
    if (connected) await token();
    if (ts !== undefined) await watch(ts, "previous lookup error");
    // A fresher unrelated row must never supply the watch timestamp.
    await watch(NOW, null, "heart-rate");
    const out = await readStatus(env.DB, options);
    expect(out.streams.at(-1)).toEqual({ stream: "watch", latest_local: latestLocal, age_hours: ageHours });
    expect(out.streams.map((row) => row.stream)).toEqual(["sleep", "daily", "watch"]);
    expect(codes(out).includes("watch_not_syncing")).toBe(alert);
  });

  it("appends the watch alert after existing alerts, with a short Spanish message and no state internals", async () => {
    await token();
    await watch(null, "private 'lookup' failure");
    await env.DB.prepare(`INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts)
      VALUES ('hr', 0, 1, 'UPSERT', ?, 5)`).bind(NOW).run();
    const out = await readStatus(env.DB, options);
    expect(codes(out)).toEqual(["no_data_48h", "no_sleep_48h", "queue_stuck", "daily_stale", "watch_not_syncing"]);
    expect(out.alerts.at(-1)).toEqual({ code: "watch_not_syncing", message: expect.any(String) as unknown });
    expect(out.alerts.at(-1)?.message.trim().length).toBeGreaterThan(0);
    expect(out.alerts.at(-1)?.message).toMatch(/reloj|sincroni/i);
    expect(out.streams.at(-1)).toEqual({ stream: "watch", latest_local: null, age_hours: null });
    expect(JSON.stringify(out)).not.toMatch(/last_ok_at|last_error|private 'lookup' failure/);
  });

  it("formats the watch instant in USER_TZ across the DST fallback", async () => {
    await token();
    const instant = at("2026-10-25T01:30:00Z");
    await watch(instant);
    expect((await readStatus(env.DB, { ...options, now: instant + 3600 })).streams.at(-1))
      .toEqual({ stream: "watch", latest_local: "2026-10-25T02:30", age_hours: 1 });
    expect((await readStatus(env.DB, { now: instant + 3600, tz: "America/New_York" })).streams.at(-1))
      .toEqual({ stream: "watch", latest_local: "2026-10-24T21:30", age_hours: 1 });
  });
});

describe("T10e AC4 watch state read", () => {
  it("reads watch by primary key in a SELECT, including when the row is absent", async () => {
    const reads: { sql: string; bindings: unknown[] }[] = [];
    const out = await readStatus(selectOnlyDb((sql, bindings) => { reads.push({ sql, bindings }); }), options);
    expect(out.streams.at(-1)).toEqual({ stream: "watch", latest_local: null, age_hours: null });
    const watchReads = reads.filter(({ sql }) => /\bsync_state\b/i.test(sql));
    expect(watchReads.length).toBeGreaterThan(0);
    for (const { sql, bindings } of watchReads) {
      const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings).all<{ detail: string }>()).results;
      expect(plan.some(({ detail }) => /SEARCH\b.*sqlite_autoindex_sync_state_\d+\b.*\(data_type=\?\)/i.test(detail))).toBe(true);
    }
  });
});

describe("T10d AC3 SELECT-only and all-or-nothing D1 reads", () => {
  it("uses only SELECTs and rejects a failure at any read without requiring a query count", async () => {
    await token();
    await minute(NOW - 60);
    await daily("2026-10-21");
    await watch(NOW - 60);
    await sleep();
    let reads = 0;
    const out = await readStatus(selectOnlyDb(() => { reads++; }), options);
    expect(out.alerts).toEqual([]);
    expect(reads).toBeGreaterThan(0);
    for (let failAt = 1; failAt <= reads; failAt++) {
      let current = 0;
      const failure = new Error(`D1 read ${String(failAt)} unavailable`);
      await expect(readStatus(selectOnlyDb(() => { if (++current === failAt) throw failure; }), options)).rejects.toBe(failure);
    }
  });

  it("rejects D1 failure through individual statements, batches or direct execution", async () => {
    const failure = new Error("D1 unavailable");
    const reject = () => Promise.reject(failure);
    const statement = { bind: () => statement, first: reject, all: reject, raw: reject, run: reject };
    const broken = { prepare: () => statement, batch: reject, exec: reject, dump: reject } as unknown as D1Database;
    await expect(readStatus(broken, options)).rejects.toBe(failure);
  });
});

describe("T27 AC2 batched reads", () => {
  it.each([0, 1, 3])("uses one batch with %i gh metrics", async (count) => {
    for (let i = 0; i < count; i++) await minute(NOW - 60, 120, `metric-${String(i)}`);
    await minute(NOW, 120, "other-only", "other");
    const calls: string[] = [];
    const out = await readStatus(selectOnlyDb(() => {}, (method) => { calls.push(method); }), options);
    expect(calls).toEqual(["batch"]);
    expect(out.streams.filter((row) => row.stream.startsWith("metric:")).map((row) => row.stream))
      .toEqual(Array.from({ length: count }, (_, i) => `metric:metric-${String(i)}`));
  });

  it("uses one batch when there are no metric names", async () => {
    const calls: string[] = [];
    await readStatus(selectOnlyDb(() => {}, (method) => { calls.push(method); }), options);
    expect(calls).toEqual(["batch"]);
  });

  it("rejects a D1 batch failure", async () => {
    const failure = new Error("D1 batch unavailable");
    const db = new Proxy(env.DB, { get(t, p) {
      if (p === "batch") return () => Promise.reject(failure);
      const value: unknown = Reflect.get(t, p);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    } });
    await expect(readStatus(db, options)).rejects.toBe(failure);
  });
});

describe("QA1-F4 prolonged stream gaps", () => {
  it("reports missing main sleep and a past HR coverage gap despite fresh steps and HR", async () => {
    const now = at("2026-10-22T08:00:00Z");
    await token();
    await watch(now);
    await sleep(at("2026-10-07T06:00:00Z"));
    await sleep(at("2026-10-21T15:00:00Z"), 1);
    await minute(now - 60, 120, "steps");
    await minute(now - 60);
    for (let day = 9; day <= 22; day++) {
      await daily(`2026-10-${String(day).padStart(2, "0")}`, now, day <= 19 ? 0 : 600);
    }
    const out = await readStatus(env.DB, { ...options, now });
    expect(out.alerts).toEqual([
      { code: "no_sleep_48h", message: expect.stringContaining("2026-10-07T08:00") as unknown },
      { code: "hr_coverage_gap", message: expect.stringMatching(/2026-10-09.*2026-10-19/) as unknown },
    ]);
    expect(out.streams.find((row) => row.stream === "sleep"))
      .toEqual({ stream: "sleep", latest_local: "2026-10-07T08:00", age_hours: 362 });
  });

  it.each([
    ["three near-zero days", [0, 0.4, 1], true],
    ["three unknown days", [null, null, null], false],
    ["two days", [600, 0, 0], false],
    ["coverage breaks the run", [0, 2, 0], false],
    ["null coverage breaks the run", [0, null, 0], false],
    ["missing summary breaks the run", [0, undefined, 0], false],
  ] as const)("checks consecutive completed days: %s", async (_label, minutes, alert) => {
    for (let i = 0; i < minutes.length; i++) {
      if (minutes[i] !== undefined) await daily(`2026-10-${String(18 + i)}`, NOW, minutes[i]);
    }
    await daily("2026-10-21", NOW, 0);
    const out = await readStatus(env.DB, options);
    expect(codes(out).includes("hr_coverage_gap")).toBe(alert);
    if (alert) expect(out.alerts.find((row) => row.code === "hr_coverage_gap")?.message)
      .toMatch(/2026-10-18.*2026-10-20/);
  });
});

describe("T27 AC3 sleep gap and AC4 sleep stream", () => {
  it.each([
    ["absent", undefined, 0, "gh", true, true],
    ["disconnected", undefined, 0, "gh", false, false],
    ["exactly 48 hours", NOW - 172800, 0, "gh", true, false],
    ["one second too old", NOW - 172801, 0, "gh", true, true],
    ["recent main sleep", NOW - 60, 0, "gh", true, false],
    ["exactly now", NOW, 0, "gh", true, false],
    ["future main sleep", NOW + 1, 0, "gh", true, false],
    ["recent nap only", NOW - 60, 1, "gh", true, true],
    ["recent non-gh only", NOW - 60, 0, "other", true, true],
  ] as const)("checks connected gh main sleep: %s", async (_label, end, isNap, source, connected, alert) => {
    if (connected) await token();
    if (end !== undefined) await sleep(end, isNap, source);
    await minute(NOW - 60, 120, "steps");
    const out = await readStatus(env.DB, options);
    expect(codes(out).includes("no_sleep_48h")).toBe(alert);
    if (alert) expect(out.alerts.find((row) => row.code === "no_sleep_48h"))
      .toEqual({ code: "no_sleep_48h", message: "Sin sesiones de sueño principal en las últimas 48 horas."
        + (end !== undefined && isNap === 0 && source === "gh" ? " Último sueño principal: 2026-10-19T09:59." : "") });
  });

  it.each([NOW - 172801, NOW - 172800])("uses main sleep freshness despite a newer nap with main sleep ending at %i", async (mainEnd) => {
    await token();
    await sleep(mainEnd);
    await sleep(NOW - 60, 1);
    await sleep(NOW, 0, "other");
    const out = await readStatus(env.DB, options);
    expect(out.streams.find((row) => row.stream === "sleep"))
      .toEqual({ stream: "sleep", latest_local: mainEnd < NOW - 172800 ? "2026-10-19T09:59" : "2026-10-19T10:00", age_hours: 48 });
    expect(codes(out).includes("no_sleep_48h")).toBe(mainEnd < NOW - 172800);
  });
});

describe("SY1 data_lag alert and foreign sync_state rows", () => {
  const lag = (out: Status) => out.alerts.filter((alert) => alert.code === "data_lag");

  it.each([[10860, true], [10800, false], [7200, false]] as const)("alerts only when the watch sync is over 3 h newer than the newest gh HR minute (%i s)", async (gap, alert) => {
    const hr = at("2026-10-21T05:00:00Z");
    await minute(hr, 0);
    // A newer non-gh HR row must not count as stored Google data.
    await minute(hr + gap, 0, "hr", "manual");
    await watch(hr + gap);
    const out = await readStatus(env.DB, options);
    // Both times use USER_TZ (Madrid, UTC+2), not the stored offset 0.
    expect(lag(out)).toEqual(alert
      ? [{ code: "data_lag", message: "El reloj se sincronizó con Google a las 10:01 pero el último pulso guardado es de las 07:00." }]
      : []);
  });

  it.each([["no watch row", false, true], ["null watch time", true, true], ["no HR", true, false]] as const)(
    "does not alert with %s", async (_label, watchRow, hrRow) => {
      if (hrRow) await minute(NOW - 7 * 3600);
      if (watchRow) await watch(hrRow ? null : NOW);
      expect(lag(await readStatus(env.DB, options))).toEqual([]);
    },
  );

  it("never reports a lag_pull or refresh row as a stream or alert", async () => {
    await watch(NOW - 60, null, "lag_pull");
    await watch(NOW - 60, "boom", "refresh");
    const out = await readStatus(env.DB, options);
    expect(out.streams.map((row) => row.stream)).toEqual(["sleep", "daily", "watch"]);
    expect(out.streams.at(-1)).toEqual({ stream: "watch", latest_local: null, age_hours: null });
    expect(JSON.stringify(out)).not.toMatch(/lag_pull|refresh|boom/);
  });
});
