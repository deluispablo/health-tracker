import { dependentRiskDiff, labelOf } from "../stats";
import type { Baseline } from "./baseline";
import { CALIBRATION_CAPS, LEG_MIN, METRICS, METRIC_MIN_PAIRS, METRIC_TIMINGS, NIGHT_ANCHORED, refusedMetricPair, SCAN_Z } from "./catalog";
import { olsAdjusted, type ModelPoint } from "./model";
import type { CalibrationCaps, Expected, GroupStats, LabelOutcome, Leg, MetricId, MetricPair, MetricStats } from "./types";
import type { DayTable } from "./units";

function raw(values: (number | null)[] | undefined, i: number): number | null {
  const value = values?.[i];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function evaluateMetricPair(t: DayTable, bl: Partial<Record<MetricId, Baseline>>, anomalies: boolean[], pair: MetricPair,
  opts: { includeAnomalies: boolean; groups?: { a: (i: number) => boolean; b: (i: number) => boolean } }): MetricStats {
  const refusal = refusedMetricPair(pair.exposure, pair.timing, pair.outcome);
  if (refusal) throw new RangeError(refusal);
  const binary = METRICS[pair.outcome].binary, rope = METRICS[pair.outcome].rope;
  const offset = METRIC_TIMINGS[pair.timing].offset;
  const thatNight = pair.timing === "that_night";
  const excluded: Record<string, number> = { middle_band: 0, incomplete_pair: 0, anomaly: 0 };
  const points: (ModelPoint & { rawY: number })[] = [];
  const outcome = t.metric[pair.outcome as Exclude<MetricId, "hr_delta">];
  const deviation = (m: MetricId, values: (number | null)[], i: number): number | null => {
    const value = raw(values, i), median = raw(bl[m]?.median, i);
    return value === null || median === null ? null : value - median;
  };
  for (let i = t.start; i <= t.end; i++) {
    const j = i + offset;
    // Explicit filters own exposure exclusions; only selected pairs enter the model.
    if (opts.groups && !opts.groups.a(i) && !opts.groups.b(i)) continue;
    const exposure = raw(t.metric[pair.exposure], i);
    const z = raw(bl[pair.exposure]?.z, i);
    if (exposure === null || (!opts.groups && z === null)) { excluded.incomplete_pair++; continue; }
    const a = opts.groups ? opts.groups.a(i) : pair.side === "low" ? (z ?? 0) <= -SCAN_Z : (z ?? 0) >= SCAN_Z;
    const b = opts.groups ? opts.groups.b(i) : pair.side === "low" ? (z ?? 0) >= SCAN_Z : (z ?? 0) <= -SCAN_Z;
    if (a && b) { excluded.both_groups = (excluded.both_groups || 0) + 1; continue; }
    if (!a && !b) { excluded.middle_band++; continue; }
    const rawY = raw(outcome, j);
    const y = binary ? rawY : deviation(pair.outcome, outcome, j);
    const yPrev = binary ? raw(outcome, j - 1) : deviation(pair.outcome, outcome, j - 1);
    const sleep = thatNight ? deviation("sleep_min", t.metric.sleep_min, i) : undefined;
    if (rawY === null || y === null || yPrev === null || sleep === null) { excluded.incomplete_pair++; continue; }
    if (!opts.includeAnomalies && (anomalies[i] || anomalies[j])) { excluded.anomaly++; continue; }
    points.push({ rawY, idx: i, a: a ? 1 : 0, y, yPrev, weekend: t.weekend[i] ? 1 : 0, sleep });
  }
  function fit(kept: typeof points): GroupStats & { adjusted_for: string[]; reason: "confounded" | null } {
    if (binary) {
      const a: (0 | 1 | null)[] = Array<null>(t.dates.length).fill(null), b = [...a];
      for (const p of kept) (p.a ? a : b)[p.idx] = p.y as 0 | 1;
      return { ...dependentRiskDiff(a, b), adjusted_for: [], reason: null };
    }
    let na = 0, nb = 0, sumA = 0, sumB = 0;
    for (const p of kept) {
      if (p.a) { na++; sumA += p.rawY; } else { nb++; sumB += p.rawY; }
    }
    const enough = na >= 3 && nb >= 3;
    return { ...olsAdjusted(kept, t.dates.length, thatNight), n_a: na, n_b: nb,
      mean_a: enough ? sumA / na : null, mean_b: enough ? sumB / nb : null };
  }
  const main = fit(points);
  function leg(kept: typeof points): Leg {
    const s = fit(kept);
    const result: Leg = { status: "unavailable", diff: s.diff, n_a: s.n_a, n_b: s.n_b };
    if (main.diff === null || s.n_a < LEG_MIN || s.n_b < LEG_MIN || s.reason === "confounded" || s.diff === null) return result;
    result.status = Math.sign(s.diff) !== Math.sign(main.diff) || Math.abs(s.diff) < rope / 2 ? "not_robust" : "robust";
    return result;
  }
  const exposureNight = NIGHT_ANCHORED.includes(pair.exposure), outcomeNight = NIGHT_ANCHORED.includes(pair.outcome);
  const alcohol = leg(points.filter(p => raw(t.behavior.alcohol, p.idx - Number(exposureNight)) === 0
    && raw(t.behavior.alcohol, p.idx + offset - Number(outcomeNight)) === 0));
  return { ...main, binary, excluded, groupIdx: { a: points.filter(p => p.a === 1).map(p => p.idx), b: points.filter(p => p.a === 0).map(p => p.idx) },
    sensitivity: { alcohol, ...(binary ? { weekdays: leg(points.filter(p => p.weekend === 0)) } : {}) } };
}

export function finalizeMetricLabel(s: MetricStats, q: number | null, rope: number, expected: Expected | null,
  caps: CalibrationCaps = CALIBRATION_CAPS): LabelOutcome {
  const result: LabelOutcome = { ...(s.reason === "confounded" ? { label: "indicio" as const, reason: "confounded" as const }
    : labelOf({ n_a:s.n_a, n_b:s.n_b, diff:s.diff, ci95:s.ci95, q, rope })), needed: null };
  if (result.reason === "few_days") result.needed = `faltan ${String(Math.max(0, 8 - s.n_a) + Math.max(0, 8 - s.n_b))} pares de días`;
  if (result.reason === "few_effective_days") {
    const groupMissing = Math.max(0, 2 - s.n_eff_a) + Math.max(0, 2 - s.n_eff_b);
    const modelMissing = s.binary ? 0 : Math.max(0, 4 + s.adjusted_for.length - s.n_eff_a - s.n_eff_b);
    result.needed = `más días repartidos en el tiempo (faltan ${String(Math.ceil(Math.max(groupMissing, modelMissing)))} días efectivos)`;
  }
  if (result.label === "probable") {
    if (s.n_a + s.n_b < METRIC_MIN_PAIRS) {
      result.label = "indicio"; result.reason = "few_days";
      result.needed = `faltan ${String(METRIC_MIN_PAIRS - s.n_a - s.n_b)} pares de días`;
    } else if (Object.values(s.sensitivity).some(leg => leg.status === "not_robust")) {
      result.label = "indicio"; result.reason = "not_robust";
    } else if (s.binary ? caps.binary || caps.metricBinary : caps.metricContinuous) {
      result.label = "indicio"; result.reason = "uncertain";
    }
  }
  result.matches_expected = expected === "+" ? s.diff !== null && s.diff > 0
    : expected === "-" ? s.diff !== null && s.diff < 0
    : expected === "0" ? result.label === "sin_diferencia" : null;
  return result;
}
