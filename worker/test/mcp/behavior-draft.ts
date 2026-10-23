import { groupedBehaviorDraft, tertiles, type RowDraft } from "../../src/mcp/tools/insights/compare";
import { BEHAVIOR_OUTCOMES, BEFORE_BED_HOURS, METRICS, behaviorExcluded } from "../../src/mcp/tools/insights/catalog";
import type { BeforeBedId, BehaviorId, BehaviorTiming, Cutpoints, MetricId } from "../../src/mcp/tools/insights/types";
import type { DayTable } from "../../src/mcp/tools/insights/units";

// Test-only single-row builder: production scans build prepared calendars and call groupedBehaviorDraft.
export function behaviorDraft(t: DayTable, anomalies: boolean[], key: { behavior: BehaviorId; timing: BehaviorTiming; metric: MetricId },
  opts: { includeAnomalies: boolean; cutpoints?: Cutpoints; groups?: { a: boolean[]; b: boolean[] } }): { draft: RowDraft; excluded: Record<string, number> } {
  const {behavior,timing,metric} = key;
  const meta = METRICS[metric];
  const allowed = BEHAVIOR_OUTCOMES[timing].includes(metric) || (meta.contrastOnly && (timing === "same_day" || timing === "next_day"));
  if (!allowed || behaviorExcluded(behavior,metric)) throw new RangeError(`Excluded behavior pair: ${behavior}, ${timing}, ${metric}.`);
  if (timing === "before_bed" && !(behavior in BEFORE_BED_HOURS)) throw new RangeError(`No before-bed window for ${behavior}.`);
  const cuts = opts.cutpoints ?? (behavior === "steps" ? tertiles(t.behavior.steps.slice(t.start,t.end+1).filter((x): x is number=>x!==null)) : null);
  const excluded = {exposure_unknown:0,outcome_missing:0,anomaly:0,both_groups:0,middle_band:0,incomplete_pair:0,no_control:0};
  const groups = new Int8Array(t.dates.length);
  for (let i=t.start;i<=t.end;i++) {
    const j = i + (timing === "same_day" ? 0 : 1);
    const exposure = timing === "before_bed" ? (t.beforeBed[behavior as BeforeBedId][j] ?? null) : (t.behavior[behavior][i] ?? null);
    if (exposure === null) { excluded.exposure_unknown++; continue; }
    const inA = opts.groups ? opts.groups.a[i] : cuts ? exposure > cuts.hi : exposure > 0;
    const inB = opts.groups ? opts.groups.b[i] : cuts ? exposure < cuts.lo : exposure === 0;
    if (inA && inB) { excluded.both_groups++; continue; }
    if (!inA && !inB) { if (cuts && !opts.groups) excluded.middle_band++; continue; }
    groups[i] = inA ? 1 : -1;
  }
  const raw = metric === "hr_delta" ? t.dates.map(() => null) : t.metric[metric];
  const outcome = t.dates.map((_, i) => raw[i + Number(timing !== "same_day")] ?? null);
  const draft = groupedBehaviorDraft(t, opts.includeAnomalies ? [] : anomalies, { kind: "behavior", ...key }, groups,
    excluded.exposure_unknown, excluded.middle_band, outcome);
  Object.assign(excluded, draft.excluded, { both_groups: excluded.both_groups });
  // Preserve the sparse outcome calendar exposed by this single-row builder.
  const kept = new Set([...draft.groupIdx.a, ...draft.groupIdx.b]);
  draft.outcome = outcome.map((x, i) => kept.has(i) ? x : null);
  delete draft.excluded;
  return { draft, excluded };
}
