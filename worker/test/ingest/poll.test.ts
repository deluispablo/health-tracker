import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueLagPull, enqueueReconcile, RECONCILE_TYPES } from "../../src/ingest/poll";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T04:30:27Z");
const START = at("2026-10-19T04:30:00Z");
const END = at("2026-10-21T04:30:00Z");
const TYPES = ["heart-rate", "steps", "daily-resting-heart-rate", "sleep", "daily-heart-rate-variability", "daily-oxygen-saturation",
  "daily-respiratory-rate", "daily-sleep-temperature-derivations", "active-zone-minutes", "exercise"];

const pending = async () => (await env.DB.prepare(
  "SELECT data_type, start_ts, end_ts, operation, received_at, attempts FROM sync_pending ORDER BY data_type, start_ts").all()).results;
const state = async () => (await env.DB.prepare("SELECT * FROM sync_state ORDER BY data_type").all()).results;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DROP TRIGGER IF EXISTS fail_q"), env.DB.prepare("DELETE FROM sync_pending"), env.DB.prepare("DELETE FROM sync_state")]);
});

describe("AC1 48-hour reconcile", () => {
  it("queues the last 48 minute-aligned hours for every drained type and records it in sync_state", async () => {
    expect(RECONCILE_TYPES).toEqual(TYPES);
    expect(await enqueueReconcile(env.DB, NOW)).toBe(10);
    expect(await pending()).toEqual([...TYPES].sort().map((t) => ({ data_type: t, start_ts: START, end_ts: END, operation: "UPSERT", received_at: NOW, attempts: 0 })));
    expect(await state()).toEqual([...TYPES].sort().map((t) => ({ data_type: t, synced_until: END, last_ok_at: null, last_error: null })));
  });

  it("skips types reconciled less than 20 hours ago, so a repeated cron does not queue twice", async () => {
    await enqueueReconcile(env.DB, NOW);
    await env.DB.prepare("DELETE FROM sync_pending").run();
    expect(await enqueueReconcile(env.DB, NOW + 19 * 3600)).toBe(0);
    expect(await pending()).toEqual([]);
    await env.DB.prepare("UPDATE sync_state SET synced_until = ? WHERE data_type = 'sleep'").bind(END - 21 * 3600).run();
    expect(await enqueueReconcile(env.DB, NOW + 60)).toBe(1);
    expect((await pending()).map((r) => [r.data_type, r.start_ts, r.end_ts])).toEqual([["sleep", START + 60, END + 60]]);
  });

  it("keeps other sync_state columns and merges into an identical queued window", async () => {
    await env.DB.prepare("INSERT INTO sync_state (data_type, synced_until, last_ok_at, last_error) VALUES ('steps', 1, 5, 'boom')").run();
    await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES ('sleep', ?, ?, 'UPSERT', 1, 3)")
      .bind(START, END).run();
    await enqueueReconcile(env.DB, NOW);
    expect((await state()).find((r) => r.data_type === "steps")).toEqual({ data_type: "steps", synced_until: END, last_ok_at: 5, last_error: "boom" });
    expect((await pending()).find((r) => r.data_type === "sleep")).toEqual({ data_type: "sleep", start_ts: START, end_ts: END, operation: "UPSERT", received_at: NOW, attempts: 0 });
  });

  it("treats a NULL synced_until as never reconciled and keeps the row's other columns", async () => {
    await env.DB.prepare("INSERT INTO sync_state (data_type, synced_until, last_ok_at, last_error) VALUES ('sleep', NULL, 7, 'e')").run();
    expect(await enqueueReconcile(env.DB, NOW)).toBe(10);
    expect((await state()).find((r) => r.data_type === "sleep")).toEqual({ data_type: "sleep", synced_until: END, last_ok_at: 7, last_error: "e" });
  });

  it("leaves skipped types' state untouched and enqueues again exactly past the 20-hour boundary", async () => {
    await enqueueReconcile(env.DB, NOW);
    await env.DB.prepare("DELETE FROM sync_pending").run();
    const before = await state();
    // synced_until (END) > now - 20 h  <=>  now < END + 20 h: skipped; at now = END + 20 h it is due.
    expect(await enqueueReconcile(env.DB, END + 20 * 3600 - 1)).toBe(0);
    expect(await state()).toEqual(before);
    expect(await enqueueReconcile(env.DB, END + 20 * 3600)).toBe(10);
  });

  it("leaves other queued work unchanged", async () => {
    const rows = [["heart-rate", START, END + 60, "UPSERT", 5, 2], ["sleep", START, END, "DELETE", 6, 1], ["weight", START, END, "UPSERT", 7, 0]] as const;
    for (const r of rows) {
      await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at, attempts) VALUES (?, ?, ?, ?, ?, ?)").bind(...r).run();
    }
    await enqueueReconcile(env.DB, NOW);
    const all = await pending();
    for (const [type, start, end, op, received, attempts] of rows) {
      expect(all).toContainEqual({ data_type: type, start_ts: start, end_ts: end, operation: op, received_at: received, attempts });
    }
    expect(all).toHaveLength(13);
  });

  it("writes queue rows and sync_state atomically, whichever write fails", async () => {
    await env.DB.prepare("INSERT INTO sync_state (data_type, synced_until) VALUES ('steps', 1)").run();
    await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES ('weight', 1, 2, 'UPSERT', 3)").run();
    const before = [await pending(), await state()];
    for (const table of ["sync_state", "sync_pending"]) {
      await env.DB.prepare(`CREATE TRIGGER fail_q BEFORE INSERT ON ${table} WHEN NEW.data_type = 'sleep' BEGIN SELECT RAISE(ABORT, 'x'); END`).run();
      await expect(enqueueReconcile(env.DB, NOW)).rejects.toThrow();
      await env.DB.prepare("DROP TRIGGER fail_q").run();
      expect([await pending(), await state()]).toEqual(before);
    }
  });
});

describe("SY1 lag pull", () => {
  const LAST_SYNC = at("2026-10-21T04:00:00Z");

  it("writes the queue rows and the lag_pull marker atomically, whichever write fails, then succeeds on retry", async () => {
    for (const [table, type] of [["sync_state", "lag_pull"], ["sync_pending", "sleep"]]) {
      await env.DB.prepare(`CREATE TRIGGER fail_q BEFORE INSERT ON ${table} WHEN NEW.data_type = '${type}' BEGIN SELECT RAISE(ABORT, 'x'); END`).run();
      await expect(enqueueLagPull(env.DB, NOW, LAST_SYNC)).rejects.toThrow();
      await env.DB.prepare("DROP TRIGGER fail_q").run();
      expect([await pending(), await state()]).toEqual([[], []]);
    }
    expect(await enqueueLagPull(env.DB, NOW, LAST_SYNC)).toBe(10);
    expect(await pending()).toHaveLength(10);
    expect(await state()).toEqual([{ data_type: "lag_pull", synced_until: null, last_ok_at: NOW, last_error: null }]);
  });
});
