import { round } from "../compare";
import { dependentRiskDiff, dependentWelch, mean } from "../stats";
import { anomalyFlags, baseline, computeBaselines } from "./baseline";
import { behaviorExcluded, METRICS, MOODS, NIGHT_ANCHORED, PHRASES } from "./catalog";
import { analysisLogStatement, finalizeFamily, publicRow, rankRows, shapeResponse } from "./compare";
import type { RowDraft } from "./compare";
import type { BehaviorId, ChangeBehaviorId, Envelope, EvalOptions, FamilyResult, MetricId, MoodId, Origin, PeriodsOriginArgs } from "./types";
import { loadDayTable, originRange, rangeFromOrigin, resolveRange } from "./units";
import type { DayTable } from "./units";

const LOGGED: readonly BehaviorId[] = ["cigarettes", "caffeine", "alcohol", "mood_negative", "mood_tired", "water", "melatonin", "protein", "creatine"];
// Scale floors (ROPE) for behaviour CUSUM baselines: cigarettes, mg caffeine, g alcohol, ml water.
const BEHAVIOR_ROPE: Record<ChangeBehaviorId, number> = { cigarettes: 1, caffeine: 40, alcohol: 10, water: 250 };
const CHANGE_BEHAVIORS = Object.keys(BEHAVIOR_ROPE) as ChangeBehaviorId[];
const isChangeBehavior = (id: string): id is ChangeBehaviorId => id in BEHAVIOR_ROPE;
const DAY = 86400000;
const dayNumber = (date: string): number => Date.parse(date + "T00:00:00Z") / DAY;

export interface CusumChange {
  metric: MetricId | ChangeBehaviorId; start: string; alarm: string; direction: "up" | "down"; shift: number;
  observed_days: number; calendar_days: number; label: "cambio"; phrase: string;
}
export function cusum(dates: string[], z: (number | null)[], values: (number | null)[], median: (number | null)[]): Omit<CusumChange, "metric" | "label" | "phrase">[] {
  const changes: Omit<CusumChange, "metric" | "label" | "phrase">[] = [];
  let plus = 0, minus = 0, plusStart = -1, minusStart = -1, previous = -1;
  for (let i = 0; i < dates.length; i++) {
    const score = z[i];
    if (score === null || !Number.isFinite(score)) continue;
    // Eight or more missing days reset the accumulators.
    if (previous >= 0 && dayNumber(dates[i]) - dayNumber(dates[previous]) > 8) {
      plus = minus = 0;
      plusStart = minusStart = -1;
    }
    if (plusStart < 0) plusStart = i;
    if (minusStart < 0) minusStart = i;
    plus = Math.max(0, plus + score - 0.5);
    minus = Math.max(0, minus - score - 0.5);
    // A zero day is not part of the change: the next observed day starts it.
    if (plus === 0) plusStart = -1;
    if (minus === 0) minusStart = -1;
    previous = i;
    if (plus <= 4 && minus <= 4) continue;
    const start = plus > 4 ? plusStart : minusStart;
    const deviations: number[] = [];
    for (let j = start; j <= i; j++) {
      const value = values[j], centre = median[j];
      if (z[j] !== null && Number.isFinite(z[j]) && value !== null && Number.isFinite(value) && centre !== null && Number.isFinite(centre)) deviations.push(value - centre);
    }
    changes.push({ start: dates[start], alarm: dates[i], direction: plus > 4 ? "up" : "down",
      shift: round(mean(deviations)) ?? 0, observed_days: deviations.length, calendar_days: dayNumber(dates[i]) - dayNumber(dates[start]) + 1 });
    plus = minus = 0;
    plusStart = minusStart = -1;
  }
  return changes;
}

export interface Streak { behavior: BehaviorId; state: "present" | "absent"; start: string; end: string; days: number; current: boolean }
export function streaks(t: DayTable, b: BehaviorId): Streak[] {
  const result: Streak[] = [];
  for (let i = t.start; i <= t.end;) {
    const value = t.behavior[b][i];
    if (value === null || !Number.isFinite(value)) { i++; continue; }
    const present = value > 0;
    let start = i;
    while (i <= t.end) {
      const next = t.behavior[b][i];
      if (next === null || !Number.isFinite(next) || (next > 0) !== present) break;
      i++;
    }
    const current = i - 1 === t.end;
    if (current) {
      while (start > 0) {
        const previous = t.behavior[b][start - 1];
        if (previous === null || !Number.isFinite(previous) || (previous > 0) !== present) break;
        start--;
      }
    }
    const days = i - start;
    if (current || days >= 3) result.push({ behavior: b, state: present ? "present" : "absent", start: t.dates[start], end: t.dates[i - 1], days, current });
  }
  return result;
}

export function validatePeriodsArgs(args: unknown, deps: { nowSec: number; tz: string }): PeriodsOriginArgs {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new RangeError("Periods arguments must be an object.");
  const input = args as Record<string, unknown>;
  if (Object.keys(input).some(key => !["start", "end", "window_days", "behaviors", "metrics"].includes(key))) throw new RangeError("Unknown periods argument.");
  for (const key of ["start", "end"] as const) if (key in input && typeof input[key] !== "string") throw new RangeError(`${key} must be a date string.`);
  if ("window_days" in input && ("start" in input || "end" in input)) throw new RangeError("Use window_days or start/end, never both.");
  const range = "window_days" in input ? { window_days: input.window_days as number } : originRange(input, deps.nowSec, deps.tz);
  rangeFromOrigin(range, deps.nowSec, deps.tz);
  const selected: Pick<PeriodsOriginArgs, "behaviors" | "metrics"> = {};
  for (const key of ["behaviors", "metrics"] as const) {
    if (!(key in input)) continue;
    const values = input[key];
    const allowed: readonly string[] = key === "behaviors" ? LOGGED : [...Object.keys(METRICS).filter(m => m !== "hr_delta"), ...CHANGE_BEHAVIORS];
    if (!Array.isArray(values) || values.some((v: unknown) => typeof v !== "string" || !allowed.includes(v))) throw new RangeError(`Invalid periods ${key}.`);
    Object.assign(selected, { [key]: [...new Set(values)] });
  }
  return { ...range, ...selected };
}

function moodWeeks(t: DayTable) {
  const weeks = new Map<string, { week: string; start: string; end: string; taps: Record<MoodId, number> }>();
  const ids = Object.values(MOODS).flat();
  for (let i = t.start; i <= t.end; i++) {
    if (!ids.some(m => t.moodTaps[m][i] > 0)) continue;
    const date = new Date(t.dates[i] + "T00:00:00Z");
    const weekday = (date.getUTCDay() + 6) % 7;
    const monday = new Date(date.getTime() - weekday * DAY).toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 3 - weekday);
    const year = date.getUTCFullYear();
    const week = `${String(year)}-W${String(Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7)).padStart(2, "0")}`;
    const row = weeks.get(week) ?? { week, start: monday, end: new Date(Date.parse(monday) + 6 * DAY).toISOString().slice(0, 10), taps: Object.fromEntries(ids.map(m => [m, 0])) as Record<MoodId, number> };
    for (const m of ids) row.taps[m] += t.moodTaps[m][i];
    weeks.set(week, row);
  }
  const rows = [...weeks.values()].map(row => {
    const sum = (moods: MoodId[]) => moods.reduce((n, m) => n + row.taps[m], 0);
    const pos = sum(MOODS.positive), neg = sum(MOODS.negative), tired = sum(MOODS.tired), total = pos + neg + tired;
    return { ...row, total, positive_share: pos + neg ? pos / (pos + neg) : null, tired_share: total ? tired / total : null };
  });
  return rows.map((row, i) => {
    const prior = rows.slice(0, i).filter(w => w.total >= 5).slice(-4);
    const average = (key: "positive_share" | "tired_share") => mean(prior.flatMap(w => w[key] === null ? [] : [w[key]]));
    const positive = average("positive_share"), tired = average("tired_share");
    const current = row.start <= t.dates[t.end] && row.end >= t.dates[t.end];
    return { ...row, positive_share: round(row.positive_share), tired_share: round(row.tired_share), current,
      comparison: current ? { weeks: prior.length, positive_share: round(positive), tired_share: round(tired),
        positive_diff: round(row.positive_share === null || positive === null ? null : row.positive_share - positive),
        tired_diff: round(row.tired_share === null || tired === null ? null : row.tired_share - tired) } : null };
  }).reverse().slice(0, 8);
}

export async function evaluatePeriods(db: D1Database, origin: Extract<Origin, { tool: "health_periods" }>, opts: EvalOptions): Promise<FamilyResult> {
  const range = opts.range ? resolveRange(opts.range, opts.nowSec, opts.tz) : rangeFromOrigin(origin.args, opts.nowSec, opts.tz);
  const t = await loadDayTable(db, range, opts.nowSec);
  const baselines = computeBaselines(t), flags = anomalyFlags(baselines, t.dates.length);
  const selectedMetrics = origin.args.metrics?.filter((m): m is MetricId => !isChangeBehavior(m));
  const allStreaks = (origin.args.behaviors ?? LOGGED).flatMap(b => streaks(t, b));
  const excluded = { exposure_unknown: 0, outcome_missing: 0, anomaly: 0 };
  const drafts: RowDraft[] = [];
  for (const streak of allStreaks.filter(s => s.current && s.days >= 3)) {
    const start = t.idx(streak.start);
    for (const metric of selectedMetrics ?? Object.keys(t.metric) as (keyof DayTable["metric"])[]) {
      if (metric === "hr_delta" || behaviorExcluded(streak.behavior, metric)) continue;
      const key = { kind: "period" as const, behavior: streak.behavior, timing: "streak", metric };
      if (opts.only && (opts.only.kind !== key.kind || opts.only.behavior !== key.behavior || opts.only.timing !== key.timing || opts.only.metric !== key.metric || opts.only.exposure || opts.only.planned_id)) continue;
      const a: (number | null)[] = t.dates.map(() => null), b = [...a], outcome = [...a];
      const groupIdx: RowDraft["groupIdx"] = { a: [], b: [] };
      const counts = { exposure_unknown: 0, outcome_missing: 0, anomaly: 0 };
      let hasData = false;
      for (let i = Math.max(0, start - 28); i <= t.end; i++) {
        const exposure = t.behavior[streak.behavior][i];
        if (exposure === null) { counts.exposure_unknown++; continue; }
        const inA = i >= start;
        if (!inA && (exposure > 0) === (streak.state === "present")) continue;
        const j = i + Number(NIGHT_ANCHORED.includes(metric));
        const value = t.metric[metric][j];
        if (value === null || !Number.isFinite(value)) { counts.outcome_missing++; continue; }
        hasData = true;
        if (flags[i] || flags[j]) { counts.anomaly++; continue; }
        (inA ? a : b)[i] = value;
        outcome[i] = value;
        groupIdx[inA ? "a" : "b"].push(i);
      }
      if (!hasData) continue;
      for (const reason of Object.keys(excluded) as (keyof typeof excluded)[]) excluded[reason] += counts[reason];
      const meta = METRICS[metric];
      const stats = meta.binary ? dependentRiskDiff(a as (0 | 1 | null)[], b as (0 | 1 | null)[]) : dependentWelch(a, b);
      drafts.push({ key, stats, rope: meta.rope, binary: meta.binary, low_confidence: meta.lowConfidence, outcome, groupIdx });
    }
  }
  // One Benjamini-Hochberg family over every streak's rows.
  const rows = finalizeFamily(drafts, t, origin).rows;
  for (const row of rows) {
    if (row.label === "sin_datos" || row.reason === "few_days") {
      const missing = (row.label === "sin_datos" ? 3 : 8) - Math.min(row.n_a, row.n_b);
      row.needed = `faltan ${String(missing)} días ${row.n_a <= row.n_b ? "durante la racha" : "con el comportamiento opuesto antes de la racha"}`;
    }
  }
  const changes: CusumChange[] = [];
  for (const metric of selectedMetrics ?? Object.keys(t.metric) as (keyof DayTable["metric"])[]) {
    const bl = baselines[metric];
    if (metric === "hr_delta" || !bl) continue;
    const displayed = <T>(values: T[]) => values.slice(t.start, t.end + 1);
    changes.push(...cusum(displayed(t.dates), displayed(bl.z), displayed(t.metric[metric]), displayed(bl.median))
      .map(c => ({ ...c, metric, label: "cambio" as const, phrase: PHRASES.cambio })));
  }
  const behaviorChanges: CusumChange[] = [];
  for (const b of origin.args.metrics?.filter(isChangeBehavior) ?? CHANGE_BEHAVIORS) {
    const bl = baseline(t.behavior[b], BEHAVIOR_ROPE[b]);
    const displayed = <T>(values: T[]) => values.slice(t.start, t.end + 1);
    behaviorChanges.push(...cusum(displayed(t.dates), displayed(bl.z), displayed(t.behavior[b]), displayed(bl.median))
      .map(c => ({ ...c, metric: b, label: "cambio" as const, phrase: PHRASES.cambio })));
  }
  const anomalies = t.dates.flatMap((date, i) => i < t.start || i > t.end || !flags[i] ? [] : [{ date,
    metrics: ["rhr", "skin_temp_dev", "resp_rate"].flatMap(m => {
      const metric = m as MetricId, z = baselines[metric]?.z[i];
      return z !== null && z !== undefined && z >= 3 ? [{ metric, value: round(t.metric[metric as keyof DayTable["metric"]][i]), z: round(z) }] : [];
    }) }]).reverse().slice(0, 10);
  return { rows, resolved: { start: range.start, end: range.end }, tests: rows.length, excluded, tests_last_24h: t.tests_last_24h + rows.length,
    extra: { streaks: allStreaks.sort((a, b) => Number(b.current) - Number(a.current) || b.end.localeCompare(a.end) || a.behavior.localeCompare(b.behavior)).slice(0, 10),
      changes: changes.sort((a, b) => b.alarm.localeCompare(a.alarm) || a.metric.localeCompare(b.metric)).slice(0, 10), mood_weeks: moodWeeks(t), anomalies,
      behavior_changes: behaviorChanges.sort((a, b) => b.alarm.localeCompare(a.alarm) || a.metric.localeCompare(b.metric)).slice(0, 10) } };
}

export async function healthPeriods(db: D1Database, args: unknown, deps: { nowSec: number; tz: string }, ctx: ExecutionContext): Promise<Record<string, unknown> & Envelope> {
  const origin: Extract<Origin, { tool: "health_periods" }> = { tool: "health_periods", args: validatePeriodsArgs(args, deps) };
  const family = await evaluatePeriods(db, origin, deps);
  ctx.waitUntil(Promise.resolve().then(() => analysisLogStatement(db, origin.tool, family.tests, deps.nowSec * 1000).run())
    .catch((cause: unknown) => { console.error("analysis_log health_periods", cause instanceof Error ? cause.name : "UnknownError"); }));
  const { behavior_changes, ...legacy } = family.extra;
  const body: Record<string, unknown> = { ...legacy, rows: rankRows(family.rows).slice(0, 40).map(publicRow) };
  const result = shapeResponse(body, ["rows", "anomalies", "changes", "mood_weeks", "streaks"],
    { range: family.resolved, excluded: family.excluded, tests: family.tests, tests_last_24h: family.tests_last_24h });
  // behavior_changes takes only the room left after the legacy response is sized, and is omitted when even [] does not fit.
  const items = [...behavior_changes as CusumChange[]];
  const withChanges = () => ({ ...result, behavior_changes: items });
  while (items.length && JSON.stringify(withChanges()).length > 20000) items.pop();
  return JSON.stringify(withChanges()).length <= 20000 ? withChanges() : result;
}
