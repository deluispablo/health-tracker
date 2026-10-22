import { z } from "zod";
import { dependentRiskDiff, dependentWelch } from "../stats";
import { anomalyFlags, baseline, type Baseline } from "./baseline";
import { BEHAVIOR_OUTCOMES, BEFORE_BED_HOURS, METRICS, METRIC_TIMINGS, behaviorExcluded, refusedMetricPair } from "./catalog";
import { analysisLogStatement, finalizeFamily, publicRow, rankRows, shapeResponse, type RowDraft } from "./compare";
import { evaluateMetricPair, finalizeMetricLabel } from "./metric";
import { canonicalJson } from "./findings";
import type { BeforeBedId, BehaviorTiming, Condition, Envelope, EvalOptions, ExposureMetric, FamilyResult, Filter, MetricId, MetricTiming, Origin } from "./types";
import { loadDayTable, originRange, rangeFromOrigin, resolveRange } from "./units";

const metricLimit = Object.keys(METRICS).length;
const behavior = z.enum(["cigarettes", "caffeine", "alcohol", "mood_negative", "mood_tired", "workout", "steps", "short_sleep"]);
const exposure = z.enum(["bedtime", "sleep_min", "hrv", "steps", "workout_min"]);
const condition = z.strictObject({ behavior: behavior.optional(), metric: exposure.optional(), op: z.enum([">", ">=", "=", "<", "<="]),
  value: z.number(), scale: z.enum(["value", "z"]).optional(), timing: z.enum(["day", "before_bed"]).optional() });
const filter = z.strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional(), weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  where: z.array(condition).max(4, "where allows at most 4 conditions per filter").optional(), include_anomalies: z.boolean().optional() });
const schema = z.strictObject({ start: z.string().optional(), end: z.string().optional(), window_days: z.number().optional(), a: filter, b: filter,
  metrics: z.array(z.string()).min(1).optional(), timing: z.enum(["following_night", "before_bed", "next_day", "same_day", "after_waking", "next_night", "that_night"]).optional() });
type ContrastOrigin = Extract<Origin, { tool: "health_contrast" }>;
const conditions = (args: { a: Filter; b: Filter }): Condition[] => [...args.a.where ?? [], ...args.b.where ?? []];
function allowedMetric(m: MetricId, timing: BehaviorTiming | MetricTiming, clauses: Condition[], e?: ExposureMetric): string | null {
  if (e) return refusedMetricPair(e, timing as MetricTiming, m);
  const excluded = clauses.find(c => c.behavior && behaviorExcluded(c.behavior, m));
  if (excluded) return `Excluded behavior pair: ${String(excluded.behavior)}, ${m}.`;
  const outcomes = BEHAVIOR_OUTCOMES[timing as BehaviorTiming];
  return outcomes.includes(m) || (METRICS[m].contrastOnly && (timing === "same_day" || timing === "next_day"))
    ? null : `Outcome ${m} is outside the behavior timing table; acute outcomes require event comparisons.`;
}

export function validateContrastArgs(args: unknown, nowSec: number, tz: string): ContrastOrigin {
  // Reject oversized arrays before schema validation walks their elements.
  if (args && typeof args === "object") {
    for (const name of ["a", "b"] as const) {
      const f = (args as Record<string, unknown>)[name];
      if (f && typeof f === "object") {
        if ("where" in f && Array.isArray(f.where) && f.where.length > 4)
          throw new RangeError("where allows at most 4 conditions per filter.");
        if ("weekdays" in f && Array.isArray(f.weekdays) && f.weekdays.length > 7)
          throw new RangeError("weekdays allows at most 7 distinct values per filter.");
      }
    }
    if ("metrics" in args && Array.isArray(args.metrics) && args.metrics.length > metricLimit)
      throw new RangeError(`metrics allows at most ${String(metricLimit)} distinct values.`);
  }
  // Small bounded filters do not benefit from compiling a validator on the cold path.
  const parsed = schema.safeParse(args, { jitless: true });
  if (!parsed.success) throw new RangeError("Invalid contrast arguments: " + parsed.error.message);
  const data = parsed.data;
  if (data.metrics && new Set(data.metrics).size !== data.metrics.length) throw new RangeError("metrics must not contain duplicates.");
  if (data.window_days !== undefined && (data.start !== undefined || data.end !== undefined)) throw new RangeError("window_days cannot be mixed with an explicit range.");
  const range = data.window_days === undefined ? originRange(data, nowSec, tz) : { window_days: data.window_days };
  if (data.window_days !== undefined) rangeFromOrigin(range, nowSec, tz);
  for (const f of [data.a, data.b]) {
    if (f.weekdays && new Set(f.weekdays).size !== f.weekdays.length) throw new RangeError("weekdays must not contain duplicates.");
    if (f.from !== undefined && f.to !== undefined && f.from > f.to) throw new RangeError("Filter from date must not follow its to date.");
  }
  const clauses = conditions(data);
  for (const c of clauses) {
    if (Number(c.behavior !== undefined) + Number(c.metric !== undefined) !== 1) throw new RangeError("Each condition requires exactly one behavior or metric.");
    if (c.behavior && c.scale === "z") throw new RangeError("The z scale is metric only.");
    if (c.timing === "before_bed" && (data.timing !== "before_bed" || !c.behavior || !(c.behavior in BEFORE_BED_HOURS)))
      throw new RangeError("A before_bed condition requires top-level before_bed and a supported window behavior.");
  }
  const e = clauses.find(c => c.metric)?.metric;
  if (e && clauses.some(c => c.behavior)) throw new RangeError("Cannot mix behavior and metric conditions.");
  if (e && clauses.some(c => c.metric !== e)) throw new RangeError("All conditions must use one exposure metric.");
  if (e && data.timing === undefined) throw new RangeError("Metric top-level timing is required.");
  const timing = data.timing ?? "following_night";
  if (e ? (!(timing in METRIC_TIMINGS) || !METRIC_TIMINGS[timing as MetricTiming].exposures.includes(e)) : !(timing in BEHAVIOR_OUTCOMES))
    throw new RangeError("Exposure is outside the allowed timing table.");
  const metrics = data.metrics?.map(m => {
    if (!Object.hasOwn(METRICS, m)) throw new RangeError(`Unknown metric: ${m}.`);
    const refusal = allowedMetric(m as MetricId, timing, clauses, e);
    if (refusal) throw new RangeError(refusal);
    return m as MetricId;
  });
  return { tool: "health_contrast", args: { ...range, a: data.a, b: data.b, timing, ...(metrics ? { metrics } : {}) } };
}

function matches(value: number | null | undefined, c: Condition): boolean {
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  switch (c.op) {
    case ">": return value > c.value;
    case ">=": return value >= c.value;
    case "=": return value === c.value;
    case "<": return value < c.value;
    case "<=": return value <= c.value;
  }
}

export async function evaluateContrast(db: D1Database, origin: ContrastOrigin, opts: EvalOptions): Promise<FamilyResult> {
  const { args } = origin;
  const range = opts.range ? resolveRange(opts.range, opts.nowSec, opts.tz) : rangeFromOrigin(args, opts.nowSec, opts.tz);
  const t = await loadDayTable(db, range, opts.nowSec);
  const clauses = conditions(args), e = clauses.find(c => c.metric)?.metric;
  const includeAnomalies = args.a.include_anomalies === true && args.b.include_anomalies === true;
  const bl: Partial<Record<MetricId, Baseline>> = {};
  const prepareBaseline = (m: Exclude<MetricId, "hr_delta">) => {
    if (!bl[m] && !METRICS[m].binary) bl[m] = baseline(t.metric[m], METRICS[m].rope);
  };
  // Filters and models need only their own baselines, plus the anomaly sentinels.
  if (!includeAnomalies) for (const m of ["rhr", "skin_temp_dev", "resp_rate"] as const) prepareBaseline(m);
  for (const c of clauses) if (c.metric && c.scale === "z") prepareBaseline(c.metric);
  const anomalies = anomalyFlags(bl, t.dates.length);
  const unknown = new Set<number>();
  const select = (f: Filter) => t.dates.map((date, i) => {
    if (i < t.start || i > t.end || date < (f.from ?? range.start) || date > (f.to ?? range.end)
      || (f.weekdays && !f.weekdays.includes(new Date(date + "T00:00:00Z").getUTCDay() || 7))) return false;
    let selected = true;
    for (const c of f.where ?? []) {
      const value = c.metric ? c.scale === "z" ? bl[c.metric]?.z[i] : t.metric[c.metric][i]
        : c.behavior ? c.timing === "before_bed" ? t.beforeBed[c.behavior as BeforeBedId][i + 1] : t.behavior[c.behavior][i] : null;
      if (value === null || value === undefined || !Number.isFinite(value)) unknown.add(i);
      if (!matches(value, c)) selected = false;
    }
    return selected;
  });
  const groups = { a: select(args.a), b: select(args.b) };
  const excluded: Record<string, number> = { both_groups: 0, exposure_unknown: unknown.size };
  for (let i = t.start; i <= t.end; i++) {
    if (groups.a[i] && groups.b[i]) { groups.a[i] = false; groups.b[i] = false; excluded.both_groups++; }
  }
  const offset = e ? METRIC_TIMINGS[args.timing as MetricTiming].offset : args.timing === "same_day" ? 0 : 1;
  const metrics = args.metrics ?? (Object.keys(METRICS) as MetricId[]).filter(m => !allowedMetric(m, args.timing, clauses, e)
    && m !== "hr_delta" && t.metric[m].slice(t.start + offset, t.end + offset + 1).some(v => v !== null));
  const drafts: RowDraft[] = [];
  for (const m of metrics) {
    const key = { kind: e ? "metric" as const : "behavior" as const, ...(e ? { exposure: { metric: e, side: "filter" as const } } : {}), timing: args.timing, metric: m };
    if (opts.only && canonicalJson(opts.only) !== canonicalJson(key)) continue;
    const meta = METRICS[m];
    let draft: RowDraft;
    if (e) {
      if (m !== "hr_delta") prepareBaseline(m);
      if (args.timing === "that_night") prepareBaseline("sleep_min");
      const s = evaluateMetricPair(t, bl, anomalies, { exposure: e, side: "filter", timing: args.timing as MetricTiming, outcome: m },
        { includeAnomalies, groups: { a: i => groups.a[i], b: i => groups.b[i] } });
      draft = { key, stats: s, rope: meta.rope, binary: meta.binary, low_confidence: meta.lowConfidence, groupIdx: s.groupIdx,
        outcome: t.dates.map((_, i) => m === "hr_delta" ? null : t.metric[m][i + offset] ?? null), excluded: s.excluded,
        extra: { planned_id: null, expected: null, adjusted_for: s.adjusted_for, sensitivity: s.sensitivity }, labelWith: q => finalizeMetricLabel(s, q, meta.rope, null) };
    } else {
      const outcome: (number | null)[] = t.dates.map(() => null), a = [...outcome], b = [...outcome];
      const groupIdx: RowDraft["groupIdx"] = { a: [], b: [] };
      const dropped = { outcome_missing: 0, anomaly: 0 };
      for (let i = t.start; i <= t.end; i++) {
        if (!groups.a[i] && !groups.b[i]) continue;
        const j = i + offset, value = m === "hr_delta" ? null : t.metric[m][j];
        if (value === null || !Number.isFinite(value)) { dropped.outcome_missing++; continue; }
        if (!includeAnomalies && (anomalies[i] || anomalies[j])) { dropped.anomaly++; continue; }
        outcome[i] = value;
        (groups.a[i] ? a : b)[i] = value;
        groupIdx[groups.a[i] ? "a" : "b"].push(i);
      }
      draft = { key, stats: meta.binary ? dependentRiskDiff(a as (0 | 1 | null)[], b as (0 | 1 | null)[]) : dependentWelch(a, b),
        rope: meta.rope, binary: meta.binary, low_confidence: meta.lowConfidence, groupIdx, outcome, excluded: dropped };
    }
    for (const [name, n] of Object.entries(draft.excluded ?? {})) excluded[name] = (excluded[name] ?? 0) + n;
    drafts.push(draft);
  }
  const family = finalizeFamily(drafts, t, origin);
  return { ...family, resolved: { start: range.start, end: range.end }, excluded, tests_last_24h: t.tests_last_24h, extra: {} };
}

export async function healthContrast(db: D1Database, args: unknown, deps: { nowSec: number; tz: string }): Promise<Record<string, unknown> & Envelope> {
  const origin = validateContrastArgs(args, deps.nowSec, deps.tz);
  const family = await evaluateContrast(db, origin, deps);
  await analysisLogStatement(db, origin.tool, family.tests, deps.nowSec * 1000).run();
  return { ...shapeResponse({ rows: rankRows(family.rows).map(publicRow) }, ["rows"], { range: family.resolved, excluded: family.excluded,
    tests: family.tests, tests_last_24h: family.tests_last_24h + family.tests }) };
}
