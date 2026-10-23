import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, deriveMode, healthFindings, historicalVerdict, parseRowRef, prospectiveVerdict, refHash } from "../../src/mcp/tools/insights/findings";
import type { FamilyRow, FindingsEvaluator, Origin, RowRef, StoredRef } from "../../src/mcp/tools/insights/types";

const nowMs = Date.parse("2026-10-22T12:00:00Z");
const resolved = { start: "2026-06-24", end: "2026-10-21" };
const newRange = { start: "2026-10-23", end: "2027-04-20" };
const reference = (): RowRef => ({ v: 1, origin: { tool: "health_scan", args: { window_days: 120 } },
  key: { kind: "behavior", behavior: "cigarettes", timing: "following_night", metric: "rhr" } });
const row = (changes: Partial<FamilyRow> = {}): FamilyRow => ({ ref: reference(), behavior: "cigarettes", timing: "following_night", metric: "rhr",
  n_a: 10, n_b: 10, mean_a: 64, mean_b: 60, diff: 4, ci95: [2, 6], pct: 6.667, p: 0.02, q: 0.02,
  label: "probable", phrase: "parece que … ; aún no comprobado con datos nuevos", reason: null, needed: null, low_confidence: false,
  consistent_blocks: null, binary: false, rope: 2, kind: "behavior", ...changes });
function fake() {
  return {
    validateOrigin: vi.fn((value: unknown) => value as Origin),
    family: vi.fn<FindingsEvaluator["family"]>(() => Promise.resolve({ rows: [row()], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} })),
    single: vi.fn<FindingsEvaluator["single"]>(() => Promise.resolve(row())),
    newDataRange: vi.fn<FindingsEvaluator["newDataRange"]>(() => newRange),
  } satisfies FindingsEvaluator;
}
let evaluator = fake();
const call = (args: Parameters<typeof healthFindings>[1], db = env.DB) => healthFindings(db, args, { nowMs, evaluator });
const save = (ref: unknown = reference(), statement = "  My observation  ") => call({ action: "save", ref, statement });
const finding = (body: Record<string, unknown>) => body.finding as { id: number; saved_at: number; statement: string; statement_untrusted: boolean; ref: StoredRef; result: FamilyRow; last_verdict: string | null };
const checks = async () => (await env.DB.prepare("SELECT * FROM finding_check ORDER BY checked_at").all()).results;
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  evaluator = fake();
  await env.DB.batch(["finding_check", "finding", "analysis_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("finding input", () => {
  it.each(["health_findings", "health_sql", "unknown"])("rejects non-allowlisted origin tool %s", (tool) => {
    expect(() => parseRowRef({ ...reference(), origin: { tool, args: {} } }, evaluator)).toThrow(RangeError);
  });
  it("rejects recursive origin args", () => {
    const ref = reference();
    Object.assign(ref.origin.args, { ref });
    expect(() => parseRowRef(ref, evaluator)).toThrow(RangeError);
    expect(() => parseRowRef({ ...reference(), origin: { tool: "health_scan", args: { window_days: 120, origin: reference().origin } } }, evaluator)).toThrow(RangeError);
  });
  it.each(["mode", "resolved", "extra"])("rejects %s in input", (key) => {
    expect(() => parseRowRef({ ...reference(), [key]: "value" }, evaluator)).toThrow(RangeError);
  });
  it("validates exact nested shapes and delegates domain validation", () => {
    for (const ref of [null, [], { ...reference(), v: 2 }, { ...reference(), key: { ...reference().key, extra: true } },
      { ...reference(), cutpoints: { lo: 2, hi: Infinity } }, { ...reference(), key: { ...reference().key, exposure: { metric: "hrv", side: "high", extra: 1 } } }]) {
      expect(() => parseRowRef(ref, evaluator)).toThrow(RangeError);
    }
    evaluator.validateOrigin.mockImplementation(() => { throw new RangeError("invalid origin args"); });
    expect(() => parseRowRef(reference(), evaluator)).toThrow("invalid origin args");
  });
  it("rejects a ref whose key is not in the origin family", async () => {
    await expect(save({ ...reference(), key: { ...reference().key, metric: "hrv" } })).rejects.toThrow("row not in origin family");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM finding").first()).toEqual({ n: 0 });
  });
  it("rejects cutpoints that differ from the origin's", async () => {
    await expect(save({ ...reference(), cutpoints: { lo: 1, hi: 3 } })).rejects.toThrow(/cutpoints/);
    const r = row({ ref: { ...reference(), cutpoints: { lo: 2, hi: 4 } } });
    evaluator.family.mockResolvedValue({ rows: [r], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    await expect(save()).rejects.toThrow(/cutpoints/);
    expect(finding(await save(r.ref)).ref.cutpoints).toEqual({ lo: 2, hi: 4 });
  });
  it("trims statements, counts code points and returns text as untrusted", async () => {
    const f = finding(await save());
    expect(f.statement).toBe("My observation");
    expect(f.statement_untrusted).toBe(true);
    for (const statement of ["", "  ", "x".repeat(501), "🫀".repeat(501)]) await expect(save(reference(), statement)).rejects.toThrow(RangeError);
  });
  it("stores and returns a 500-code-point statement without splitting surrogate pairs", async () => {
    expect(finding(await save(reference(), "🫀".repeat(500))).statement).toBe("🫀".repeat(500));
  });
  it("keeps internal inference metadata in storage and strips it from public results", async () => {
    const result = finding(await save()).result;
    for (const key of ["binary", "rope", "kind"]) expect(result).not.toHaveProperty(key);
    const stored = await env.DB.prepare("SELECT result FROM finding").first<{ result: string }>();
    expect(JSON.parse(stored?.result ?? "null")).toMatchObject({ binary: false, rope: 2, kind: "behavior" });
  });
  it("rejects invalid actions and ids", async () => {
    await expect(call({ action: "unknown" })).rejects.toThrow(RangeError);
    for (const action of ["retire", "recheck"]) for (const id of [undefined, 0, -1, 1.5, NaN]) {
      await expect(call({ action, id })).rejects.toThrow(RangeError);
    }
    await expect(call({ action: "retire", id: 999 })).rejects.toThrow(RangeError);
    await expect(call({ action: "recheck", id: 999 })).rejects.toThrow(RangeError);
  });
});

describe("saving and hashing", () => {
  it("save keeps the family q", async () => {
    evaluator.family.mockResolvedValue({ rows: [row({ q: 0.20, label: "indicio" })], resolved, tests: 8, excluded: {}, tests_last_24h: 8, extra: {} });
    expect(finding(await save()).result).toMatchObject({ p: 0.02, q: 0.20, label: "indicio" });
    expect(evaluator.family).toHaveBeenCalledWith(reference().origin, {});
  });
  it("saving the same prospective ref twice returns the existing finding", async () => {
    const original = finding(await save());
    evaluator.family.mockResolvedValue({ rows: [row({ diff: 6 })], resolved: newRange, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    expect(finding(await save(reference(), "different"))).toEqual(original);
  });
  it("re-saving a retired finding reactivates the original record", async () => {
    const original = finding(await save());
    await call({ action: "recheck", id: original.id });
    await call({ action: "retire", id: original.id });
    expect((await call({ action: "list" })).findings).toEqual([]);
    evaluator.family.mockResolvedValue({ rows: [row({ diff: 6 })], resolved: newRange, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    const revived = finding(await save(reference(), "different"));
    expect(revived).toEqual({ ...original, status: "active", last_verdict: "confirmed",
      result: { ...original.result, label: "sólido", phrase: "va asociado a … y se ha confirmado con datos nuevos (n)" } });
    expect((await call({ action: "list" })).findings).toEqual([revived]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM finding").first()).toEqual({ n: 1 });
    expect(await checks()).toHaveLength(1);
  });
  it("historical refs over different resolved dates are separate findings", async () => {
    const ref: RowRef = { ...reference(), origin: { tool: "health_periods", args: { window_days: 120 } } };
    evaluator.family.mockResolvedValue({ rows: [row({ ref })], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    const first = finding(await save(ref));
    evaluator.family.mockResolvedValue({ rows: [row({ ref })], resolved: newRange, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    expect(finding(await save(ref)).id).not.toBe(first.id);
  });
  it("canonical JSON sorts nested keys and hashes without mode", async () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    const prospective: StoredRef = { ...reference(), resolved, mode: "prospective" };
    const historical: StoredRef = { ...prospective, mode: "historical" };
    const hex = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const { origin, key } = prospective;
    expect(await refHash(prospective)).toBe(await hex({ origin, key }));
    expect(await refHash(historical)).toBe(await hex({ origin, key, resolved }));
    expect(await refHash({ ...prospective, resolved: newRange })).toBe(await refHash(prospective));
  });
  it("derives historical mode for acute, periods and dated contrasts", () => {
    expect(deriveMode(reference())).toBe("prospective");
    expect(deriveMode({ ...reference(), key: { ...reference().key, kind: "acute" } })).toBe("historical");
    expect(deriveMode({ ...reference(), origin: { tool: "health_periods", args: { window_days: 120 } } })).toBe("historical");
    for (const args of [{ window_days: 120, a: {}, b: {}, timing: "same_day" },
      { start: resolved.start, end: resolved.end, a: {}, b: {}, timing: "same_day" },
      { window_days: 120, a: { from: resolved.start }, b: {}, timing: "same_day" },
      { window_days: 120, a: {}, b: { to: resolved.end }, timing: "same_day" }] as const) {
      expect(deriveMode({ ...reference(), origin: { tool: "health_contrast", args } })).toBe("start" in args || "from" in args.a || "to" in args.b ? "historical" : "prospective");
    }
  });
});

describe("verdicts", () => {
  it.each([
    [{ n_a: 2, diff: -4 }, "not_enough_data"],
    [{ diff: -4, ci95: [-6, -2] }, "reversed"],
    [{}, "confirmed"],
    [{ label: "indicio", diff: 1 }, "holds"],
    [{ label: "indicio", diff: 0.99 }, "weakened"],
  ] as const)("reaches prospective verdict %s -> %s", (changes, verdict) => {
    expect(prospectiveVerdict({ label: "probable", diff: 4 }, row(changes as Partial<FamilyRow>))).toBe(verdict);
  });
  it("requires eight new days per group and saved probable to confirm", () => {
    for (let n = 3; n < 8; n++) expect(prospectiveVerdict({ label: "probable", diff: 4 }, row({ n_a: n, n_b: n }))).toBe("holds");
    expect(prospectiveVerdict({ label: "indicio", diff: 4 }, row())).toBe("holds");
    expect(prospectiveVerdict({ label: "probable", diff: 4 }, row({ diff: -4, ci95: [-5, 1] }))).toBe("weakened");
    expect(prospectiveVerdict({ label: "probable", diff: 4 }, row({ diff: null }))).toBe("weakened");
  });
  it.each([null, -4, 0, 4])("a saved null diff cannot establish a prospective comparison with %s", async (diff) => {
    evaluator.family.mockResolvedValue({ rows: [row({ diff: null })], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    const { id } = finding(await save());
    evaluator.single.mockResolvedValue(row({ diff, ci95: diff === null ? null : [diff - 1, diff + 1] }));
    expect(prospectiveVerdict({ label: "probable", diff: null }, row({ diff }))).toBe("not_enough_data");
    const result = await call({ action: "recheck", id });
    expect(result).toMatchObject({ verdict: "not_enough_data", diff_saved: null, diff_new: diff });
    expect(finding(result).result.label).toBe("probable");
    expect(await checks()).toMatchObject([{ verdict: "not_enough_data", result: JSON.stringify(row({ diff, ci95: diff === null ? null : [diff - 1, diff + 1] })) }]);
  });
  it("reproduced needs the same label, sign and a diff change within rope/2", () => {
    expect(historicalVerdict(row(), row({ diff: 5 }))).toBe("reproduced");
    for (const fresh of [row({ diff: 5.01 }), row({ label: "indicio" }), row({ diff: -4 }), null]) expect(historicalVerdict(row(), fresh)).toBe("changed");
    expect(historicalVerdict(row({ diff: null, label: "sin_datos" }), row({ diff: null, label: "sin_datos" }))).toBe("changed");
  });
  it("historical findings rerun on resolved dates and return both diffs", async () => {
    const ref: RowRef = { ...reference(), origin: { tool: "health_periods", args: { window_days: 120 } } };
    evaluator.family.mockResolvedValue({ rows: [row({ ref })], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    const { id } = finding(await save(ref));
    evaluator.family.mockResolvedValue({ rows: [row({ ref, diff: 5 })], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    expect(await call({ action: "recheck", id })).toMatchObject({ verdict: "reproduced", diff_saved: 4, diff_new: 5 });
    const savedAt = (await env.DB.prepare("SELECT saved_at FROM finding WHERE id = ?").bind(id).first<{ saved_at: number }>())?.saved_at ?? NaN;
    expect(evaluator.family).toHaveBeenLastCalledWith(ref.origin, { range: resolved, nowSec: Math.floor(savedAt / 1000) });
    evaluator.family.mockResolvedValue({ rows: [], resolved, tests: 0, excluded: {}, tests_last_24h: 0, extra: {} });
    expect(await call({ action: "recheck", id })).toMatchObject({ verdict: "changed", diff_new: null });
    expect(await checks()).toHaveLength(2);
  });
  it("null new data or an unevaluable row still inserts a check", async () => {
    const { id } = finding(await save());
    evaluator.newDataRange.mockReturnValue(null);
    expect(await call({ action: "recheck", id })).toMatchObject({ verdict: "not_enough_data" });
    expect(evaluator.single).not.toHaveBeenCalled();
    evaluator.newDataRange.mockReturnValue(newRange);
    evaluator.single.mockResolvedValue(null);
    expect(await call({ action: "recheck", id })).toMatchObject({ verdict: "not_enough_data" });
    expect(await checks()).toHaveLength(2);
  });
  it("uses the evaluator's clamped 180-day range and freezes cutpoints", async () => {
    const ref = { ...reference(), cutpoints: { lo: 1, hi: 3 } };
    evaluator.family.mockResolvedValue({ rows: [row({ ref })], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    const { id } = finding(await save(ref));
    await call({ action: "recheck", id });
    expect(evaluator.newDataRange).toHaveBeenCalledWith(nowMs);
    expect(evaluator.single).toHaveBeenCalledWith({ ...ref, mode: "prospective", resolved }, newRange);
    expect((Date.parse(newRange.end) - Date.parse(newRange.start)) / 86400000 + 1).toBe(180);
  });
  it("retries a checked_at collision once with +1 ms", async () => {
    const { id } = finding(await save());
    await call({ action: "recheck", id });
    await call({ action: "recheck", id });
    expect((await checks()).map((r) => r.checked_at)).toEqual([nowMs, nowMs + 1]);
    await expect(call({ action: "recheck", id })).rejects.toThrow(/UNIQUE/);
  });
});

describe("confirmation display", () => {
  it("shows sólido after confirmed and keeps it with holds; reversed and weakened revoke it", async () => {
    const { id } = finding(await save());
    let tick = nowMs;
    const recheck = async (fresh: FamilyRow) => {
      evaluator.single.mockResolvedValue(fresh);
      return healthFindings(env.DB, { action: "recheck", id }, { nowMs: tick++, evaluator });
    };
    expect(finding(await recheck(row())).result.label).toBe("sólido");
    expect(finding(await recheck(row({ label: "indicio", diff: 1 }))).result.label).toBe("sólido");
    expect((await call({ action: "list" })).findings).toMatchObject([{ result: { label: "sólido" }, last_verdict: "holds" }]);
    expect(finding(await save()).result.label).toBe("sólido");
    const reversed = await recheck(row({ diff: -4, ci95: [-6, -2] }));
    expect(reversed.verdict).toBe("reversed");
    expect(finding(reversed).result.label).toBe("probable");
    expect((await call({ action: "list" })).findings).toMatchObject([{ result: { label: "probable" }, last_verdict: "reversed" }]);
    expect(finding(await recheck(row())).result.label).toBe("sólido");
    const weakened = await recheck(row({ label: "indicio", diff: 0.1 }));
    expect(weakened.verdict).toBe("weakened");
    expect(finding(weakened).result.label).toBe("probable");
    expect((await call({ action: "list" })).findings).toMatchObject([{ result: { label: "probable" }, last_verdict: "weakened" }]);
    expect((await env.DB.prepare("SELECT result FROM finding WHERE id = ?").bind(id).first<{ result: string }>())?.result).toContain('"label":"probable"');
  });
  it.each([{ label: "indicio" }, { binary: true }, { kind: "acute" } ] as const)("never promotes ineligible saved findings %s", async (changes) => {
    evaluator.family.mockResolvedValue({ rows: [row(changes)], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
    const { id } = finding(await save());
    const result = await call({ action: "recheck", id });
    expect(result.verdict).toBe("label" in changes && changes.label === "indicio" ? "holds" : "confirmed");
    expect(finding(result).result.label).not.toBe("sólido");
    expect((await call({ action: "list" })).findings).toMatchObject([{ result: { label: "label" in changes ? changes.label : "probable" } }]);
  });
  it("holds without prior confirmation never shows sólido", async () => {
    const { id } = finding(await save());
    evaluator.single.mockResolvedValue(row({ label: "indicio", diff: 1 }));
    const result = await call({ action: "recheck", id });
    expect(result.verdict).toBe("holds");
    expect(finding(result).result.label).toBe("probable");
    expect((await call({ action: "list" })).findings).toMatchObject([{ result: { label: "probable" }, last_verdict: "holds" }]);
  });
});

describe("SQL mechanics", () => {
  it("caps the active list at twenty and retirement hides a finding", async () => {
    for (let i = 0; i < 21; i++) {
      const ref = { ...reference(), origin: { tool: "health_scan" as const, args: { window_days: i + 20 } } };
      evaluator.family.mockResolvedValue({ rows: [row({ ref })], resolved, tests: 1, excluded: {}, tests_last_24h: 0, extra: {} });
      await save(ref);
    }
    const list = (await call({ action: "list" })).findings as { id: number }[];
    expect(list).toHaveLength(20);
    await call({ action: "retire", id: list[0].id });
    expect((await call({ action: "list" })).findings).toHaveLength(20);
    expect(((await call({ action: "list" })).findings as { id: number }[]).map((f) => f.id)).not.toContain(list[0].id);
  });
  it("uses one statement for list/retire/save, two for recheck and embeds the 24h count in the first", async () => {
    await env.DB.prepare("INSERT INTO analysis_log VALUES (?, 'health_scan', 5), (?, 'health_scan', 7), (?, 'health_scan', 99)")
      .bind(nowMs, nowMs - 86400000, nowMs - 86400001).run();
    const sql: string[] = [];
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (query: string) => { sql.push(query); return target.prepare(query); };
      throw new Error(`unexpected ${String(property)}`);
    } });
    for (const action of ["save", "list", "recheck", "retire"]) {
      sql.length = 0;
      const result = await call({ action, id: 1, ref: reference(), statement: "text" }, db);
      expect(result.tests_last_24h).toBe(12);
      expect(sql).toHaveLength(action === "recheck" ? 2 : 1);
      expect(sql[0]).toMatch(/SELECT COALESCE\(SUM\(tests\), 0\) FROM analysis_log/);
    }
  });
  it("propagates evaluator failures without inserting a check", async () => {
    const { id } = finding(await save());
    evaluator.single.mockRejectedValue(new Error("data unavailable"));
    await expect(call({ action: "recheck", id })).rejects.toThrow("data unavailable");
    expect(await checks()).toHaveLength(0);
  });
  it("does not retry unrelated check write failures", async () => {
    const { id } = finding(await save());
    await env.DB.prepare("CREATE TRIGGER fail_check BEFORE INSERT ON finding_check BEGIN SELECT RAISE(ABORT, 'check unavailable'); END").run();
    try {
      await expect(call({ action: "recheck", id })).rejects.toThrow("check unavailable");
      expect(await checks()).toHaveLength(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_check").run();
    }
  });
  it("returns an empty list and a count when no findings exist", async () => {
    expect(await call({ action: "list" })).toMatchObject({ findings: [], tests_last_24h: 0 });
  });
});
