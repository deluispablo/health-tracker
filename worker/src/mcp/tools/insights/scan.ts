import { anomalyFlags, baseline, type Baseline } from "./baseline";
import { BEHAVIOR_OUTCOMES, METRICS, METRIC_TIMINGS, PLANNED, SCAN_PAIRS } from "./catalog";
import { acuteDraft, analysisLogStatement, finalizeFamily, groupedBehaviorDraft, publicRow, rankRows, shapeResponse, tertiles, type RowDraft } from "./compare";
import { acuteDays, loadAcuteInput, type AcuteDays } from "./event";
import { evaluateMetricPair, finalizeMetricLabel } from "./metric";
import type { BehaviorId, Envelope, EvalOptions, FamilyResult, MetricId, Origin, RowKey, ScanOriginArgs } from "./types";
import { loadDayTable, originRange, rangeFromOrigin, resolveRange, type DayTable } from "./units";

type ScanOrigin = Extract<Origin, { tool: "health_scan" }>;
const TRACKERS = ["cigarettes", "caffeine", "alcohol"] as const;
const BEHAVIORS = [...new Set(SCAN_PAIRS.map(p => p.behavior))];
const BEHAVIOR_KEYS = SCAN_PAIRS.map(p => ({ kind: "behavior" as const, ...p }));
const TIMINGS = [...Object.keys(BEHAVIOR_OUTCOMES), ...Object.keys(METRIC_TIMINGS), "acute"];

export function validateScanArgs(args: unknown, nowSec: number, tz: string): { origin: ScanOrigin; limit: number } {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new RangeError("args must be an object.");
  const input = args as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["start", "end", "behaviors", "metrics", "timings", "limit"].includes(key)) throw new RangeError(`Unknown field: ${key}.`);
  }
  const limit = input.limit === undefined ? 10 : input.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new RangeError("limit must be an integer from 1 to 10.");
  for (const field of ["start", "end"] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== "string") throw new RangeError(`${field} must be a calendar date.`);
      try { resolveRange({ start: input[field], end: input[field] }, nowSec, tz); }
      catch { throw new RangeError(`${field} must be a real date no later than the last completed behaviour day.`); }
    }
  }
  let range: ReturnType<typeof originRange>;
  try { range = originRange(input, nowSec, tz); }
  catch (error) { throw new RangeError(`start/end: ${error instanceof Error ? error.message : "Invalid range."}`); }
  const normalized: ScanOriginArgs = { ...range };
  for (const [field, allowed] of [
    ["behaviors", BEHAVIORS],
    ["metrics", Object.keys(METRICS).filter(m => !METRICS[m as MetricId].contrastOnly)],
    ["timings", TIMINGS],
  ] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0 || value.some((v: unknown) => typeof v !== "string" || !(allowed as readonly string[]).includes(v)))
      throw new RangeError(`${field} must be a nonempty array of valid ids.`);
    Object.assign(normalized, { [field]: [...new Set(value as string[])] });
  }
  return { origin: { tool: "health_scan", args: normalized }, limit };
}

function sameKey(a: RowKey, b: RowKey): boolean {
  return a.kind === b.kind && a.behavior === b.behavior && a.timing === b.timing && a.metric === b.metric
    && a.planned_id === b.planned_id && a.exposure?.metric === b.exposure?.metric && a.exposure?.side === b.exposure?.side;
}

export function computeScan(t: DayTable, acute: AcuteDays[] | null, origin: ScanOrigin, opts: EvalOptions): FamilyResult {
  const args = origin.args;
  const accepts = (key: RowKey): boolean => (!opts.only || sameKey(key, opts.only))
    && (!args.metrics || args.metrics.includes(key.metric)) && (!args.timings || args.timings.includes(key.timing))
    && (!key.behavior || !args.behaviors || args.behaviors.includes(key.behavior));
  const behaviorKeys = BEHAVIOR_KEYS.filter(accepts);
  const planned = PLANNED.filter(p => accepts({ kind: "metric", exposure: { metric: p.exposure, side: p.side }, planned_id: p.id, timing: p.timing, metric: p.outcome }));
  const bl: Partial<Record<MetricId, Baseline>> = {};
  const required = new Set<MetricId>(["rhr", "skin_temp_dev", "resp_rate"]);
  for (const p of planned) {
    required.add(p.exposure);
    if (!METRICS[p.outcome].binary) required.add(p.outcome);
    if (p.timing === "that_night") required.add("sleep_min");
  }
  for (const m of required) if (m !== "hr_delta") bl[m] = baseline(t.metric[m], METRICS[m].rope);
  const flags = anomalyFlags(bl, t.dates.length);
  const cuts = opts.cutpoints ?? tertiles(t.behavior.steps.slice(t.start, t.end + 1).filter((x): x is number => x !== null));
  const drafts: RowDraft[] = [];
  const excluded: Record<string, number> = {};
  const addExcluded = (counts: Record<string, number>) => {
    for (const key in counts) excluded[key] = (excluded[key] ?? 0) + counts[key];
  };
  const outcomes = new Map<string, (number | null)[]>();
  const uniqueOutcomes: (number | null)[][] = [];
  const outcomeFor = (metric: MetricId, offset: number): (number | null)[] => {
    const cacheKey = `${metric}:${String(offset)}`;
    const cached = outcomes.get(cacheKey);
    if (cached) return cached;
    const raw = t.metric[metric as keyof DayTable["metric"]];
    let outcome = offset ? raw.slice(1).concat(null) : raw;
    // Binary metrics often share calendars; reuse their computation within this request.
    const same = uniqueOutcomes.find(values => {
      if (values.length !== outcome.length) return false;
      for (let i = 0; i < values.length; i++) if (values[i] !== outcome[i]) return false;
      return true;
    });
    if (same) outcome = same;
    else uniqueOutcomes.push(outcome);
    outcomes.set(cacheKey, outcome);
    return outcome;
  };
  const memberships = new Map<string, { groups: Int8Array; unknown: number; middle: number }>();
  const calendars: Int8Array[] = [];
  const comparisons = new Map<Int8Array, Map<string, Map<(number | null)[], RowDraft>>>();
  const residuals = new Float64Array(t.end - t.start + 1);
  for (const key of behaviorKeys) {
    const offset = key.timing === "same_day" ? 0 : 1;
    const outcome = outcomeFor(key.metric, offset);
    const window = key.timing === "before_bed", membershipKey = `${key.behavior}:${String(window)}`;
    let membership = memberships.get(membershipKey);
    if (!membership) {
      membership = { groups: new Int8Array(t.dates.length), unknown: 0, middle: 0 };
      const exposure = window ? t.beforeBed[key.behavior as keyof DayTable["beforeBed"]] : t.behavior[key.behavior];
      for (let i = t.start; i <= t.end; i++) {
        const x = exposure[i + Number(window)] ?? null;
        if (x === null) { membership.unknown++; continue; }
        const a = key.behavior === "steps" ? x > cuts.hi : x > 0, b = key.behavior === "steps" ? x < cuts.lo : x === 0;
        if (a || b) membership.groups[i] = a ? 1 : -1;
        else if (key.behavior === "steps") membership.middle++;
      }
      const candidate = membership.groups;
      const existing = calendars.find(groups => {
        for (let i = t.start; i <= t.end; i++) if (groups[i] !== candidate[i]) return false;
        return true;
      });
      if (existing) membership.groups = existing;
      else calendars.push(membership.groups);
      memberships.set(membershipKey, membership);
    }
    let partitions = comparisons.get(membership.groups);
    if (!partitions) { partitions = new Map(); comparisons.set(membership.groups, partitions); }
    const partition = `${String(offset)}:${String(METRICS[key.metric].binary)}`;
    let cached = partitions.get(partition);
    if (!cached) { cached = new Map(); partitions.set(partition, cached); }
    const previous = cached.get(outcome);
    const draft = previous ? { ...previous, key, rope: METRICS[key.metric].rope, low_confidence: METRICS[key.metric].lowConfidence, excluded: { ...previous.excluded, exposure_unknown: membership.unknown, middle_band: membership.middle } }
      : groupedBehaviorDraft(t, flags, key, membership.groups, membership.unknown, membership.middle, outcome, residuals);
    if (!previous) cached.set(outcome, draft);
    drafts.push(draft); addExcluded(draft.excluded ?? {});
  }
  for (const tracker of TRACKERS) {
    const key: RowKey = { kind: "acute", behavior: tracker, timing: "acute", metric: "hr_delta" };
    if (!accepts(key)) continue;
    const days = acute?.find(a => a.tracker === tracker) ?? { tracker, dates: [], d: [], eventDays: 0, events: 0, controls: 0,
      excluded: { overlap: 0, workout: 0, sleep: 0, coverage: 0, dst: 0, no_control: 0, future: 0 } };
    const d = acuteDraft(days); drafts.push(d); addExcluded(days.excluded);
  }
  for (const p of planned) {
    const s = evaluateMetricPair(t, bl, flags, p, { includeAnomalies: false });
    const meta = METRICS[p.outcome], offset = METRIC_TIMINGS[p.timing].offset;
    drafts.push({ key: { kind: "metric", exposure: { metric: p.exposure, side: p.side }, planned_id: p.id, timing: p.timing, metric: p.outcome },
      stats: s, rope: meta.rope, binary: s.binary, low_confidence: meta.lowConfidence, groupIdx: s.groupIdx,
      outcome: outcomeFor(p.outcome, offset),
      extra: { planned_id: p.id, expected: p.expected, adjusted_for: s.adjusted_for, sensitivity: s.sensitivity },
      labelWith: q => finalizeMetricLabel(s, q, meta.rope, p.expected) });
    addExcluded(s.excluded);
  }
  const skipped: BehaviorId[] = [];
  for (const b of BEHAVIORS) {
    if (args.behaviors && !args.behaviors.includes(b)) continue;
    let a = 0, n = 0;
    for (let i = t.start; i <= t.end; i++) {
      const x = t.behavior[b][i];
      if (x === null) continue;
      if (b === "steps" ? x > cuts.hi : x > 0) a++;
      if (b === "steps" ? x < cuts.lo : x === 0) n++;
    }
    if (a < 3 || n < 3) skipped.push(b);
  }
  const resolved = { start: t.dates[t.start], end: t.dates[t.end] };
  const final = finalizeFamily(drafts, t, origin, cuts);
  return { ...final, resolved, excluded, tests_last_24h: t.tests_last_24h, extra: { skipped } };
}

export async function evaluateScan(db: D1Database, origin: ScanOrigin, opts: EvalOptions): Promise<FamilyResult> {
  const range = opts.range ? resolveRange(opts.range, opts.nowSec, opts.tz) : rangeFromOrigin(origin.args, opts.nowSec, opts.tz);
  const t = await loadDayTable(db, range, opts.nowSec);
  const acute = !opts.only || opts.only.kind === "acute"
    ? acuteDays(await loadAcuteInput(db, { ...range, nowSec: opts.nowSec, tz: opts.tz }), range) : null;
  return computeScan(t, acute, origin, opts);
}

export async function healthScan(db: D1Database, args: unknown, deps: { nowSec: number; tz: string }, ctx: ExecutionContext): Promise<Record<string, unknown> & Envelope> {
  const { origin, limit } = validateScanArgs(args, deps.nowSec, deps.tz);
  const family = await evaluateScan(db, origin, deps);
  const result = shapeResponse({ rows: rankRows(family.rows).slice(0, limit).map(publicRow), skipped: family.extra.skipped }, ["rows", "skipped"],
    { range: family.resolved, excluded: family.excluded, tests: family.tests, tests_last_24h: family.tests_last_24h + family.tests });
  result.truncated ||= family.rows.length > limit;
  ctx.waitUntil(Promise.resolve().then(() => analysisLogStatement(db, "health_scan", family.tests, deps.nowSec * 1000).run())
    .catch((cause: unknown) => { console.error("analysis_log health_scan", cause instanceof Error ? cause.name : "UnknownError"); }));
  return { ...result };
}
