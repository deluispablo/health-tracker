import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { upsertRows } from "../../src/lib/d1";
import { fromGoogleTime, nightOf, sleepLocalDate } from "../../src/lib/time";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const MM = ["metric", "source", "ts", "tz_offset_min", "value"];
const MM_KEYS = ["metric", "source", "ts"];

/** Wraps D1 to record the bind width of every statement and the number of batch calls. */
function recordingDb(): { db: D1Database; binds: number[]; batches: () => number } {
  const binds: number[] = [];
  let batches = 0;
  const db = {
    prepare: (sql: string) => {
      const stmt = env.DB.prepare(sql);
      return { bind: (...args: unknown[]) => { binds.push(args.length); return stmt.bind(...args); } };
    },
    batch: (stmts: D1PreparedStatement[]) => { batches++; return env.DB.batch(stmts); },
  } as unknown as D1Database;
  return { db, binds, batches: () => batches };
}

async function count(sql: string): Promise<number> {
  return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? -1;
}

describe("AC1 schema", () => {
  const TABLES = [
    "metric_def", "metric_minute", "metric_hour", "metric_daily", "sleep_session", "sleep_stage", "workout",
    "tracker", "event", "daily_summary", "tracker_daily", "sync_pending", "sync_state", "secret_blob", "audit_log",
  ];

  it("creates every table, view and index", async () => {
    const { results } = await env.DB.prepare("SELECT type, name FROM sqlite_master").all<{ type: string; name: string }>();
    const names = (type: string) => results.filter((r) => r.type === type).map((r) => r.name);
    expect(names("table")).toEqual(expect.arrayContaining(TABLES));
    expect(names("view")).toEqual(expect.arrayContaining(["v_daily", "v_events", "v_sleep", "v_workouts"]));
    expect(names("index")).toEqual(expect.arrayContaining(["ix_sleep_date", "ix_event_tracker_date"]));
  });

  it("keeps the plan §8 primary keys and checks", async () => {
    const pk = async (table: string) => (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`)
      .all<{ name: string }>()).results.map((r) => r.name);
    expect(await pk("metric_minute")).toEqual(["metric", "source", "ts"]);
    expect(await pk("metric_daily")).toEqual(["metric", "source", "local_date"]);
    expect(await pk("sync_pending")).toEqual(["data_type", "start_ts", "end_ts", "operation"]);
    await expect(env.DB.prepare("INSERT INTO metric_def(metric, unit, agg) VALUES ('x','u','median')").run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO sleep_session(source_id, start_ts, end_ts, tz_offset_min, local_date, updated_at) VALUES ('sp', 1, 9, 0, '2026-01-01', 1)").run();
    await env.DB.prepare("INSERT INTO sleep_stage(session_id, start_ts, end_ts, stage) VALUES ('sp',1,2,'LIGHT')").run();
    await expect(env.DB.prepare("INSERT INTO sleep_stage(session_id, start_ts, end_ts, stage) VALUES ('sp',3,4,'NAP')").run()).rejects.toThrow();
  });

  it("seeds the nine metrics with unit and aggregation", async () => {
    const r = await env.DB.prepare("SELECT metric, unit, agg FROM metric_def ORDER BY metric").all();
    expect(r.results).toEqual([
      { metric: "azm", unit: "min", agg: "sum" },
      { metric: "hr", unit: "bpm", agg: "avg" },
      { metric: "hrv_rmssd", unit: "ms", agg: "avg" },
      { metric: "resp_rate", unit: "brpm", agg: "avg" },
      { metric: "rhr", unit: "bpm", agg: "last" },
      { metric: "skin_temp_dev", unit: "°C", agg: "last" },
      { metric: "spo2", unit: "%", agg: "avg" },
      { metric: "steps", unit: "count", agg: "sum" },
      { metric: "vo2max", unit: "ml/kg/min", agg: "last" },
    ]);
  });

  it("projects the read-only views", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tracker(id, name, unit, value_type, created_at) VALUES ('cigarettes','Cigarettes','unit','count',0), ('alcohol','Alcohol','g_alcohol','amount',0), ('caffeine','Caffeine','mg','amount',0)"),
      env.DB.prepare("INSERT INTO event(id, tracker_id, ts, tz_offset_min, local_date, value, origin, created_at, deleted_at) VALUES ('e1','cigarettes',1,120,'2026-10-20',1,'mcp',1,NULL), ('e2','cigarettes',2,120,'2026-10-20',1,'mcp',2,5)"),
      env.DB.prepare("INSERT INTO daily_summary(local_date, rhr, computed_at) VALUES ('2026-10-20', 55, 1), ('2026-10-21', 56, 1)"),
      env.DB.prepare("INSERT INTO tracker_daily(local_date, tracker_id, total, n, evening_total) VALUES ('2026-10-20','cigarettes',3,3,2), ('2026-10-20','alcohol',24,2,24)"),
      env.DB.prepare("INSERT INTO sleep_session(source_id, start_ts, end_ts, tz_offset_min, local_date, updated_at) VALUES ('s1', 10, 20, 120, '2026-10-21', 1)"),
      env.DB.prepare("INSERT INTO workout(source_id, type, start_ts, end_ts, tz_offset_min, local_date, updated_at) VALUES ('w1', 'RUN', 10, 20, 120, '2026-10-20', 1)"),
    ]);
    const ev = await env.DB.prepare("SELECT id, tracker_id, value FROM v_events").all();
    expect(ev.results).toEqual([{ id: "e1", tracker_id: "cigarettes", value: 1 }]);
    const d = await env.DB.prepare("SELECT local_date, rhr, cigarettes, alcohol_g, caffeine_mg FROM v_daily ORDER BY local_date").all();
    expect(d.results).toEqual([
      { local_date: "2026-10-20", rhr: 55, cigarettes: 3, alcohol_g: 24, caffeine_mg: null },
      { local_date: "2026-10-21", rhr: 56, cigarettes: null, alcohol_g: null, caffeine_mg: null },
    ]);
    expect((await env.DB.prepare("SELECT source_id, local_date FROM v_sleep WHERE source_id = 's1'").all()).results)
      .toEqual([{ source_id: "s1", local_date: "2026-10-21" }]);
    expect((await env.DB.prepare("SELECT source_id, type FROM v_workouts").all()).results)
      .toEqual([{ source_id: "w1", type: "RUN" }]);
  });
});

describe("AC2 idempotent upsert", () => {
  const cols = ["metric", "source", "ts", "tz_offset_min", "value", "vmin", "vmax", "n"];

  it("keeps one row with the last value", async () => {
    await upsertRows(env.DB, "metric_minute", MM, MM_KEYS, [["hr", "gh", 1_792_520_000, 120, 70]]);
    await upsertRows(env.DB, "metric_minute", MM, MM_KEYS, [["hr", "gh", 1_792_520_000, 120, 75]]);
    expect((await env.DB.prepare("SELECT value FROM metric_minute WHERE ts = 1792520000").all()).results).toEqual([{ value: 75 }]);
  });

  it("replaces listed non-key columns, keeps unlisted ones, separates sources, is stable on replay", async () => {
    await upsertRows(env.DB, "metric_minute", cols, MM_KEYS, [
      ["hr", "gh", 1_792_530_000, 120, 70, 60, 80, 10],
      ["hr", "hc", 1_792_530_000, 120, 71, 61, 81, 11],
    ]);
    const update = ["hr", "gh", 1_792_530_000, 60, 72, null];
    await upsertRows(env.DB, "metric_minute", cols.slice(0, 6), MM_KEYS, [update]);
    await upsertRows(env.DB, "metric_minute", cols.slice(0, 6), MM_KEYS, [update]);
    const r = await env.DB.prepare("SELECT source, tz_offset_min, value, vmin, vmax, n FROM metric_minute WHERE ts = 1792530000 ORDER BY source").all();
    expect(r.results).toEqual([
      { source: "gh", tz_offset_min: 60, value: 72, vmin: null, vmax: 80, n: 10 },
      { source: "hc", tz_offset_min: 120, value: 71, vmin: 61, vmax: 81, n: 11 },
    ]);
  });

  it("does nothing on conflict when only keys are written", async () => {
    await upsertRows(env.DB, "sync_state", ["data_type", "synced_until"], ["data_type"], [["steps", 5]]);
    await upsertRows(env.DB, "sync_state", ["data_type"], ["data_type"], [["steps"]]);
    expect((await env.DB.prepare("SELECT synced_until FROM sync_state WHERE data_type = 'steps'").all()).results)
      .toEqual([{ synced_until: 5 }]);
  });

  it("binds text with quotes and BLOBs as values, replacing them on conflict", async () => {
    const blobCols = ["name", "iv", "ciphertext", "updated_at"];
    const bytes = (...b: number[]) => new Uint8Array(b).buffer;
    await upsertRows(env.DB, "secret_blob", blobCols, ["name"], [["it's", bytes(1, 2), bytes(3), 1]]);
    await upsertRows(env.DB, "secret_blob", blobCols, ["name"], [["it's", bytes(9, 8, 7), bytes(6, 5), 2]]);
    const row = await env.DB.prepare("SELECT hex(iv) AS iv, hex(ciphertext) AS ct, updated_at FROM secret_blob WHERE name = 'it''s'").first();
    expect(row).toEqual({ iv: "090807", ct: "0605", updated_at: 2 });
  });

  it("validates before writing and propagates batch errors", async () => {
    const empty = recordingDb();
    await expect(upsertRows(empty.db, "metric_minute", MM, MM_KEYS, [])).resolves.toBeUndefined();
    expect(empty.binds).toEqual([]);
    expect(empty.batches()).toBe(0);
    await expect(upsertRows(env.DB, "metric_minute; DROP TABLE x", MM, MM_KEYS, [])).rejects.toThrow(TypeError);
    await expect(upsertRows(env.DB, "metric_minute", MM, ["nope"], [])).rejects.toThrow(TypeError);
    await expect(upsertRows(env.DB, "metric_minute", [], [], [])).rejects.toThrow(TypeError);
    await expect(upsertRows(env.DB, "metric_minute", MM, [], [])).rejects.toThrow(TypeError);
    await expect(upsertRows(env.DB, "metric_minute", [...MM, "value"], MM_KEYS, [])).rejects.toThrow(TypeError);
    const wide = Array.from({ length: 101 }, (_, i) => `c${"abcdefghij"[i % 10]}${"abcdefghijk"[Math.floor(i / 10)]}`);
    await expect(upsertRows(env.DB, "metric_minute", wide, [wide[0] ?? ""], [])).rejects.toThrow(TypeError);
    const good = Array.from({ length: 25 }, (_, i) => ["spo2", "gh", 1_792_800_000 + i * 60, 0, 97]);
    await expect(upsertRows(env.DB, "metric_minute", MM, MM_KEYS, [...good, ["spo2", "gh"]])).rejects.toThrow(TypeError);
    expect(await count("SELECT count(*) AS n FROM metric_minute WHERE metric = 'spo2'")).toBe(0);
    const boom = new Error("batch failed");
    let called = false;
    const failing = { prepare: (sql: string) => env.DB.prepare(sql), batch: () => { called = true; return Promise.reject(boom); } } as unknown as D1Database;
    await expect(upsertRows(failing, "metric_minute", MM, MM_KEYS, [["spo2", "gh", 1, 0, 97]])).rejects.toBe(boom);
    expect(called).toBe(true);
  });
});

describe("AC3 batched upsert", () => {
  it("binds at most 100 params per statement in one batch", async () => {
    const { db, binds, batches } = recordingDb();
    const rows = Array.from({ length: 250 }, (_, i) => ["steps", "gh", 1_792_600_000 + i * 60, 120, i]);
    await upsertRows(db, "metric_minute", MM, MM_KEYS, rows);
    expect(batches()).toBe(1);
    expect(binds).toEqual([...new Array<number>(12).fill(100), 50]);
    expect(await count("SELECT count(*) AS n FROM metric_minute WHERE metric = 'steps'")).toBe(250);
  });

  it("chunks 250 four-column rows by 25", async () => {
    const { db, binds, batches } = recordingDb();
    const rows = Array.from({ length: 250 }, (_, i) => [`type_${String(i)}`, i, i, null]);
    await upsertRows(db, "sync_state", ["data_type", "synced_until", "last_ok_at", "last_error"], ["data_type"], rows);
    expect(batches()).toBe(1);
    expect(binds).toEqual(new Array<number>(10).fill(100));
    expect(await count("SELECT count(*) AS n FROM sync_state WHERE data_type LIKE 'type_%'")).toBe(250);
  });

  it("chunks six-column rows by 16 (96 params)", async () => {
    const { db, binds } = recordingDb();
    const rows = Array.from({ length: 17 }, (_, i) => ["rhr", "gh", 1_793_000_000 + i * 60, 0, 50, 49]);
    await upsertRows(db, "metric_minute", [...MM, "vmin"], MM_KEYS, rows);
    expect(binds).toEqual([96, 6]);
  });

  it("puts a partial final chunk in the same batch", async () => {
    const { db, binds, batches } = recordingDb();
    const rows = Array.from({ length: 21 }, (_, i) => ["azm", "gh", 1_792_700_000 + i * 60, 0, i]);
    await upsertRows(db, "metric_minute", MM, MM_KEYS, rows);
    expect(batches()).toBe(1);
    expect(binds).toEqual([100, 5]);
    expect(await count("SELECT count(*) AS n FROM metric_minute WHERE metric = 'azm'")).toBe(21);
  });
});

describe("AC4 Google time", () => {
  it("derives ts, offset and local date", () => {
    expect(fromGoogleTime("2026-10-20T22:30:00Z", "7200s")).toEqual({
      ts: Date.UTC(2026, 9, 20, 22, 30) / 1000, tzOffsetMin: 120, localDate: "2026-10-21",
    });
  });

  it("handles UTC, negative, non-hour, fractional and calendar edges", () => {
    expect(fromGoogleTime("2026-10-20T23:59:59Z", "0s")).toEqual({
      ts: Date.UTC(2026, 9, 20, 23, 59, 59) / 1000, tzOffsetMin: 0, localDate: "2026-10-20",
    });
    expect(fromGoogleTime("2026-10-21T03:30:00Z", "-18000s")).toMatchObject({ tzOffsetMin: -300, localDate: "2026-10-20" });
    expect(fromGoogleTime("2026-10-20T19:00:00Z", "19800s")).toMatchObject({ tzOffsetMin: 330, localDate: "2026-10-21" });
    expect(fromGoogleTime("2028-02-28T23:30:00.750Z", "3600s")).toEqual({
      ts: Date.UTC(2028, 1, 28, 23, 30) / 1000, tzOffsetMin: 60, localDate: "2028-02-29",
    });
    expect(fromGoogleTime("2026-12-31T23:00:00Z", "3600s").localDate).toBe("2027-01-01");
  });

  it("rejects malformed time or offset", () => {
    for (const t of ["yesterday", "2026-10-20", "2026-10-20T10:00:00+02:00", "2026-02-30T10:00:00Z"]) {
      expect(() => fromGoogleTime(t, "0s")).toThrow(TypeError);
    }
    expect(() => fromGoogleTime("2026-10-20T00:00:00Z", "7200")).toThrow(TypeError);
    expect(() => fromGoogleTime("2026-10-20T00:00:00Z", "7230s")).toThrow(TypeError);
  });
});

describe("AC5 sleep day", () => {
  it("dates a night by its wake day", () => {
    expect(sleepLocalDate(Date.UTC(2026, 9, 21, 4, 40) / 1000, 120)).toBe("2026-10-21");
    expect(nightOf("2026-10-20")).toBe("2026-10-21");
  });

  it("uses the local date at wake time across midnight and year end", () => {
    expect(sleepLocalDate(Date.UTC(2026, 9, 20, 22, 0) / 1000, 120)).toBe("2026-10-21");
    expect(sleepLocalDate(Date.UTC(2027, 0, 1, 5, 0) / 1000, -300)).toBe("2027-01-01");
    expect(nightOf("2026-12-31")).toBe("2027-01-01");
    expect(nightOf("2028-02-28")).toBe("2028-02-29");
  });
});
