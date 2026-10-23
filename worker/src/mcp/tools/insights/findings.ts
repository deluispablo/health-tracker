import { z } from "zod";
import type { FamilyRow, FindingsEvaluator, RowKey, RowRef, StoredRef } from "./types";

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function sorted(input: unknown, depth: number): unknown {
    if (depth > 20) throw new RangeError("ref is too deeply nested");
    if (input === null || typeof input !== "object") {
      if (typeof input === "number" && !Number.isFinite(input)) throw new RangeError("ref must contain finite numbers");
      if (["function", "symbol", "bigint"].includes(typeof input)) throw new RangeError("ref must contain JSON values");
      return input;
    }
    if (ancestors.has(input)) throw new RangeError("recursive ref is not allowed");
    ancestors.add(input);
    const result: unknown = Array.isArray(input) ? input.map((item: unknown) => sorted(item, depth + 1))
      : Object.fromEntries(Object.keys(input).sort().map((key) => [key, sorted((input as Record<string, unknown>)[key], depth + 1)]));
    ancestors.delete(input);
    return result;
  }
  if (value === undefined) throw new RangeError("ref must contain JSON values");
  return JSON.stringify(sorted(value, 0));
}

const behavior = z.enum(["cigarettes", "caffeine", "alcohol", "mood_negative", "mood_tired", "workout", "steps", "short_sleep", "water", "melatonin", "protein", "creatine"]);
const exposureMetric = z.enum(["bedtime", "sleep_min", "hrv", "steps", "workout_min"]);
const metric = z.enum(["sleep_min", "deep_min", "rem_min", "light_min", "awake_min", "deep_pct", "rem_pct", "efficiency", "latency_min",
  "awakenings", "bedtime", "rhr", "hrv", "spo2_avg", "skin_temp_dev", "resp_rate", "steps", "workout_min", "mood_positive", "mood_negative",
  "mood_tired", "mood_genial", "mood_bien", "mood_tranquilo", "mood_cansado", "mood_estresado", "mood_ansioso", "mood_triste", "mood_enfadado", "hr_delta"]);
const keySchema = z.strictObject({
  kind: z.enum(["behavior", "acute", "period", "metric"]), behavior: behavior.optional(),
  exposure: z.strictObject({ metric: exposureMetric, side: z.enum(["high", "low", "filter"]) }).optional(),
  planned_id: z.string().min(1).optional(), timing: z.string().min(1), metric,
}) satisfies z.ZodType<RowKey>;
const refSchema = z.strictObject({
  v: z.literal(1), origin: z.strictObject({ tool: z.enum(["health_scan", "health_contrast", "health_periods"]), args: z.record(z.string(), z.unknown()) }),
  key: keySchema, cutpoints: z.strictObject({ lo: z.number(), hi: z.number() }).optional(),
});

export function parseRowRef(input: unknown, evaluator: FindingsEvaluator): RowRef {
  canonicalJson(input);
  const parsed = refSchema.safeParse(input);
  if (!parsed.success) throw new RangeError("invalid ref shape: " + parsed.error.message);
  const ref = parsed.data;
  const allowed = ref.origin.tool === "health_contrast" ? ["start", "end", "window_days", "a", "b", "metrics", "timing"]
    : ref.origin.tool === "health_scan" ? ["start", "end", "window_days", "behaviors", "metrics", "timings"]
      : ["start", "end", "window_days", "behaviors", "metrics"];
  if (Object.keys(ref.origin.args).some((key) => !allowed.includes(key))) throw new RangeError("invalid origin args");
  return { v: 1, origin: evaluator.validateOrigin(ref.origin), key: ref.key, ...(ref.cutpoints ? { cutpoints: ref.cutpoints } : {}) };
}

export function deriveMode(ref: RowRef): "prospective" | "historical" {
  if (ref.key.kind === "acute" || ref.origin.tool === "health_periods") return "historical";
  if (ref.origin.tool === "health_contrast") {
    const args = ref.origin.args;
    if ("start" in args || "end" in args || args.a.from !== undefined || args.a.to !== undefined || args.b.from !== undefined || args.b.to !== undefined) return "historical";
  }
  return "prospective";
}

export async function refHash(ref: StoredRef): Promise<string> {
  const json = canonicalJson({ origin: ref.origin, key: ref.key, cutpoints: ref.cutpoints,
    ...(ref.mode === "historical" ? { resolved: ref.resolved } : {}) });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type Verdict = "not_enough_data" | "reversed" | "confirmed" | "holds" | "weakened";

export function prospectiveVerdict(saved: { label: string; diff: number | null }, fresh: FamilyRow): Verdict {
  if (saved.diff === null || fresh.n_a < 3 || fresh.n_b < 3) return "not_enough_data";
  if (fresh.diff === null) return "weakened";
  const sameSign = Math.sign(saved.diff) === Math.sign(fresh.diff);
  if (saved.diff * fresh.diff < 0 && fresh.ci95 !== null && (fresh.ci95[0] > 0 || fresh.ci95[1] < 0)) return "reversed";
  if (saved.label === "probable" && fresh.label === "probable" && fresh.n_a >= 8 && fresh.n_b >= 8 && sameSign) return "confirmed";
  if (sameSign && Math.abs(fresh.diff) >= fresh.rope / 2) return "holds";
  return "weakened";
}

export function historicalVerdict(saved: FamilyRow, fresh: FamilyRow | null): "reproduced" | "changed" {
  return fresh !== null && saved.diff !== null && fresh.diff !== null && saved.label === fresh.label
    && Math.sign(saved.diff) === Math.sign(fresh.diff) && Math.abs(fresh.diff - saved.diff) <= fresh.rope / 2 ? "reproduced" : "changed";
}

export interface FindingsBody { [k: string]: unknown; tests_last_24h: number }

interface FindingRecord {
  id: number; saved_at: number; statement: string; ref: string; ref_hash: string; result: string; status: "active" | "retired";
  last_verdict?: string | null; confirmed?: number; tests_last_24h: number;
}
const testCount = "(SELECT COALESCE(SUM(tests), 0) FROM analysis_log WHERE ts >= ?) AS tests_last_24h";
const history = `(SELECT verdict FROM finding_check WHERE finding_id = f.id ORDER BY checked_at DESC LIMIT 1) AS last_verdict,
  EXISTS(SELECT 1 FROM finding_check WHERE finding_id = f.id AND verdict = 'confirmed') AS confirmed`;

function display(record: FindingRecord, verdict = record.last_verdict ?? null, confirmed = record.confirmed === 1) {
  const result = JSON.parse(record.result) as FamilyRow;
  const publicResult = Object.fromEntries(Object.entries(result).filter(([key]) => !["binary", "rope", "kind"].includes(key)));
  const solid = result.label === "probable" && !result.binary && result.kind !== "acute" && confirmed && (verdict === "confirmed" || verdict === "holds");
  return { id: record.id, saved_at: record.saved_at, statement: record.statement, statement_untrusted: true,
    ref: JSON.parse(record.ref) as StoredRef, result: solid ? { ...publicResult, label: "sólido", phrase: "va asociado a … y se ha confirmado con datos nuevos (n)" } : publicResult,
    status: record.status, last_verdict: verdict };
}

function byKey(rows: FamilyRow[], key: RowKey): FamilyRow | null {
  const json = canonicalJson(key);
  return rows.find((row) => row.ref !== null && canonicalJson(row.ref.key) === json) ?? null;
}

export async function healthFindings(db: D1Database, args: { action: string; id?: number; statement?: string; ref?: unknown },
  deps: { nowMs: number; evaluator: FindingsEvaluator }): Promise<FindingsBody> {
  const { nowMs, evaluator } = deps;
  const since = nowMs - 86400000;
  if (args.action === "list") {
    const { results } = await db.prepare(`SELECT f.*, ${testCount} FROM (SELECT 1) LEFT JOIN (
      SELECT f.*, ${history} FROM finding f WHERE status = 'active' ORDER BY saved_at DESC, id DESC LIMIT 20
    ) f ON 1 ORDER BY f.saved_at DESC, f.id DESC`).bind(since).all<Omit<FindingRecord, "id"> & { id: number | null }>();
    return { findings: results.flatMap((record) => record.id === null ? [] : [display({ ...record, id: record.id })]), tests_last_24h: results[0].tests_last_24h };
  }
  if (args.action === "save") {
    if (typeof args.statement !== "string") throw new RangeError("statement is required");
    const statement = args.statement.trim();
    const length = Array.from(statement).length;
    if (length < 1 || length > 500) throw new RangeError("statement must contain 1–500 code points");
    const ref = parseRowRef(args.ref, evaluator);
    const family = await evaluator.family(ref.origin, {});
    const row = byKey(family.rows, ref.key);
    if (row === null) throw new RangeError("row not in origin family");
    if (canonicalJson(ref.cutpoints ?? null) !== canonicalJson(row.ref?.cutpoints ?? null)) throw new RangeError("cutpoints differ from origin family");
    const stored: StoredRef = { ...ref, resolved: family.resolved, mode: deriveMode(ref) };
    const record = await db.prepare(`INSERT INTO finding (saved_at, statement, ref, ref_hash, result) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(ref_hash) DO UPDATE SET status = 'active' RETURNING *, ${testCount},
      (SELECT verdict FROM finding_check WHERE finding_id = finding.id ORDER BY checked_at DESC LIMIT 1) AS last_verdict,
      EXISTS(SELECT 1 FROM finding_check WHERE finding_id = finding.id AND verdict = 'confirmed') AS confirmed`)
      .bind(nowMs, statement, canonicalJson(stored), await refHash(stored), JSON.stringify(row), since).first<FindingRecord>();
    if (record === null) throw new Error("finding insert returned no row");
    return { finding: display(record), tests_last_24h: record.tests_last_24h };
  }
  if (args.action !== "retire" && args.action !== "recheck") throw new RangeError("unknown findings action");
  const id = args.id;
  if (id === undefined || !Number.isSafeInteger(id) || id < 1) throw new RangeError("id must be a positive integer");
  if (args.action === "retire") {
    const record = await db.prepare(`UPDATE finding SET status = 'retired' WHERE id = ? RETURNING id, ${testCount}`)
      .bind(id, since).first<{ id: number; tests_last_24h: number }>();
    if (record === null) throw new RangeError("unknown finding id");
    return record;
  }
  const record = await db.prepare(`SELECT f.*, ${history}, ${testCount} FROM finding f WHERE id = ?`)
    .bind(since, id).first<FindingRecord>();
  if (record === null) throw new RangeError("unknown finding id");
  const ref = JSON.parse(record.ref) as StoredRef;
  const saved = JSON.parse(record.result) as FamilyRow;
  let fresh: FamilyRow | null = null;
  let verdict: Verdict | "reproduced" | "changed";
  if (ref.mode === "historical") {
    fresh = byKey((await evaluator.family(ref.origin, { range: ref.resolved, nowSec: Math.floor(record.saved_at / 1000) })).rows, ref.key);
    verdict = historicalVerdict(saved, fresh);
  } else {
    const range = evaluator.newDataRange(record.saved_at);
    if (range !== null) fresh = await evaluator.single(ref, range);
    verdict = fresh === null ? "not_enough_data" : prospectiveVerdict(saved, fresh);
  }
  const insert = (checkedAt: number) => db.prepare("INSERT INTO finding_check (finding_id, checked_at, verdict, result) VALUES (?, ?, ?, ?)")
    .bind(id, checkedAt, verdict, JSON.stringify(fresh)).run();
  try {
    await insert(nowMs);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed: finding_check.finding_id, finding_check.checked_at")) throw error;
    await insert(nowMs + 1);
  }
  return { finding: display(record, verdict, record.confirmed === 1 || verdict === "confirmed"), verdict,
    diff_saved: saved.diff, diff_new: fresh?.diff ?? null, tests_last_24h: record.tests_last_24h };
}
