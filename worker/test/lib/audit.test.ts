import { afterEach, expect, it, vi } from "vitest";
import { audit } from "../../src/lib/audit";

afterEach(() => vi.restoreAllMocks());

it("logs one {kind, name, ok, ms} line per audited call, without args or error text", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
  const db = { prepare: () => ({ bind: () => ({ run: () => Promise.resolve({}) }) }) } as unknown as D1Database;

  audit(ctx, db, { kind: "tool", name: "health_query", args: { secret: "x" }, started: Date.now(), error: "boom" });
  await Promise.all(pending);

  expect(log).toHaveBeenCalledTimes(1);
  const line = log.mock.calls[0][0] as Record<string, unknown>;
  expect(Object.keys(line).sort()).toEqual(["kind", "ms", "name", "ok"]);
  expect(line).toMatchObject({ kind: "tool", name: "health_query", ok: false });
  expect(typeof line["ms"]).toBe("number");
});
