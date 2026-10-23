import { round } from "../compare";
import { benjaminiHochberg, dependentGroups, labelOf, oneSampleDependent } from "../stats";
import { CALIBRATION_CAPS, METRICS, NEEDED_TEXT, PHRASES } from "./catalog";
import type { BehaviorId, BehaviorTiming, CalibrationCaps, Cutpoints, Envelope, FamilyRow, GroupStats, InsightRow, LabelOutcome, MetricId, Origin, RowKey } from "./types";
import type { AcuteDays } from "./event";
import type { DayTable } from "./units";

export interface RowDraft {
  key: RowKey; stats: GroupStats; rope: number; binary: boolean; low_confidence: boolean;
  groupIdx: { a: number[]; b: number[] }; outcome: (number | null)[];
  excluded?: Record<string, number>;
  extra?: Partial<InsightRow>; labelWith?: (q: number | null) => LabelOutcome;
}

export function tertiles(values: number[]): Cutpoints {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
  const quantile = (p: number): number => {
    if (!sorted.length) return 0;
    const index = (sorted.length-1)*p, lo = Math.floor(index);
    return sorted[lo] + (sorted[Math.ceil(index)]-sorted[lo])*(index-lo);
  };
  return {lo:quantile(1/3),hi:quantile(2/3)};
}

// Prepared-calendar equivalence is checked by the complete-family tests in insights-scan.test.ts.
export function groupedBehaviorDraft(t: DayTable, flags: boolean[], key: { kind: "behavior"; behavior: BehaviorId; timing: BehaviorTiming; metric: MetricId }, groups: Int8Array, unknown: number, middle: number, outcome: (number | null)[], residuals?: Float64Array): RowDraft {
  const meta = METRICS[key.metric];
  const offset = key.timing === "same_day" ? 0 : 1;
  const groupIdx = { a: [] as number[], b: [] as number[] };
  const kept = new Int8Array(groups.length);
  const excluded = { exposure_unknown: unknown, outcome_missing: 0, anomaly: 0, both_groups: 0, middle_band: middle, incomplete_pair: 0, no_control: 0 };
  for (let i = t.start; i <= t.end; i++) {
    const group = groups[i];
    if (!group) continue;
    const value = outcome[i] ?? null;
    if (value === null || !Number.isFinite(value)) { excluded.outcome_missing++; continue; }
    if (flags[i] || flags[i + offset]) { excluded.anomaly++; continue; }
    kept[i] = group;
    groupIdx[group === 1 ? "a" : "b"].push(i);
  }
  const stats = dependentGroups(outcome, kept, t.start, t.end, meta.binary, residuals);
  return { key, stats, rope: meta.rope, binary: meta.binary, low_confidence: meta.lowConfidence, groupIdx, outcome, excluded };
}


export function acuteDraft(a: AcuteDays): RowDraft {
  const days = a.dates.map(date=>Date.parse(`${date}T00:00:00Z`)/86400000);
  const start = days[0] ?? 0;
  const calendar: (number|null)[] = Array<number|null>(days.length ? days[days.length-1]-start+1 : 0).fill(null);
  days.forEach((day,i)=>{ calendar[day-start]=a.d[i]; });
  const s = oneSampleDependent(calendar);
  return {
    key:{kind:"acute",behavior:a.tracker,timing:"acute",metric:"hr_delta"},
    stats:{n_a:s.N,n_b:s.N,mean_a:s.diff,mean_b:null,diff:s.diff,ci95:s.ci95,p:s.p,df:s.df,phi:s.phi,n_eff_a:s.n_eff,n_eff_b:s.n_eff},
    rope:METRICS.hr_delta.rope,binary:false,low_confidence:false,groupIdx:{a:[],b:[]},outcome:[],
    extra:{n_a:s.N,n_b:a.controls},excluded:{...a.excluded},
  };
}

export function consistentBlocks(t: DayTable, d: RowDraft, blockAt?: Int8Array): { same: number; of: number } | null {
  if (d.stats.diff === null || d.key.kind === "acute") return null;
  const sums = [0, 0, 0, 0, 0, 0, 0, 0], ns = [0, 0, 0, 0, 0, 0, 0, 0];
  const blocks = Math.min(4, Math.floor((t.end - t.start + 1) / 28));
  for (let group = 0; group < 2; group++) {
    const indices = group === 0 ? d.groupIdx.a : d.groupIdx.b;
    for (const i of indices) {
      const block = blockAt ? blockAt[i] : Math.floor((t.end - i) / 28), x = d.outcome[i], slot = block * 2 + group;
      if (block >= 0 && block < blocks && x !== null && Number.isFinite(x)) { sums[slot] += x; ns[slot]++; }
    }
  }
  let same = 0, of = 0;
  for (let i = 0; i < blocks * 2; i += 2) {
    if (ns[i] < 3 || ns[i + 1] < 3) continue;
    of++;
    const diff = sums[i] / ns[i] - sums[i + 1] / ns[i + 1];
    if (Math.sign(diff) === Math.sign(d.stats.diff) && Math.abs(diff) >= d.rope / 2) same++;
  }
  return of ? { same, of } : null;
}

function neededText(d: RowDraft, result: LabelOutcome): string | null {
  if (result.needed) return result.needed;
  const s = d.stats;
  if (result.reason === "few_effective_days")
    return `más días repartidos en el tiempo (faltan ${String(Math.max(0,Math.ceil(2-Math.min(s.n_eff_a,s.n_eff_b))))} días efectivos)`;
  if (result.reason !== "few_days" && result.label !== "sin_datos") return null;
  const count = (result.label === "sin_datos" ? 3 : 8)-Math.min(s.n_a,s.n_b);
  const nights = d.key.timing === "following_night" || d.key.timing === "before_bed";
  if (d.key.behavior === "steps")
    return `faltan ${String(count)} ${nights ? NEEDED_TEXT.night : NEEDED_TEXT.day} en el tercil ${s.n_a<=s.n_b ? "superior" : "inferior"} de pasos`;
  const behavior = d.key.behavior ? NEEDED_TEXT.behavior[d.key.behavior].replace(/^días con /,"") : "la exposición";
  return `faltan ${String(count)} ${nights ? NEEDED_TEXT.night : NEEDED_TEXT.day} ${s.n_a<=s.n_b ? "con" : "sin"} ${behavior}${d.key.timing === "before_bed" ? " antes de dormir" : ""}`;
}

export function finalizeFamily(drafts: RowDraft[], t: DayTable, origin: Origin, cutpoints?: Cutpoints, caps: CalibrationCaps = CALIBRATION_CAPS): { rows: FamilyRow[]; tests: number } {
  const qs = benjaminiHochberg(drafts.map(d=>d.stats.n_a<3 || d.stats.n_b<3 ? null : d.stats.p));
  const blocks = new Map<RowDraft["groupIdx"], { outcome: RowDraft["outcome"]; rope: number; diff: number | null; value: FamilyRow["consistent_blocks"] }>();
  const blockAt = new Int8Array(t.dates.length).fill(-1);
  for (let i = Math.max(t.start, t.end - 111); i <= t.end; i++) blockAt[i] = Math.floor((t.end - i) / 28);
  const rows = drafts.map((d,i): FamilyRow => {
    const s = d.stats, insufficient = s.n_a<3 || s.n_b<3;
    const q = qs[i];
    let result: LabelOutcome = d.labelWith ? d.labelWith(q) : {...labelOf({n_a:s.n_a,n_b:s.n_b,diff:s.diff,ci95:s.ci95,q,rope:d.rope}),needed:null};
    if (insufficient) result = {...result,label:"sin_datos",reason:null,needed:null};
    if ((d.binary || d.key.kind === "acute") && result.label === "sólido") result = {...result,label:"probable"};
    if (result.label === "probable" && ((d.binary && caps.binary) || (d.key.kind === "acute" && caps.acute)))
      result = {...result,label:"indicio",reason:"uncertain",needed:null};
    const diff = insufficient ? null : s.diff;
    // Zero-centred or non-positive references make a percentage meaningless.
    const pct = diff === null || d.key.metric === "skin_temp_dev" || s.mean_b === null || s.mean_b <= 0 ? null : d.key.metric === "hrv" ? 100*Math.expm1(diff) : 100*diff/s.mean_b;
    const frozen = d.key.behavior === "steps" ? cutpoints ?? tertiles(t.behavior.steps.slice(t.start,t.end+1).filter((x): x is number=>x!==null)) : undefined;
    const cached = blocks.get(d.groupIdx);
    const consistent = cached?.rope === d.rope && cached.outcome === d.outcome && cached.diff === s.diff ? cached.value : consistentBlocks(t, d, blockAt);
    if (!cached) blocks.set(d.groupIdx, { outcome: d.outcome, rope: d.rope, diff: s.diff, value: consistent });
    const ref: FamilyRow["ref"] = { v: 1, origin, key: d.key };
    if (frozen) ref.cutpoints = frozen;
    const row: FamilyRow = {
      ref,
      timing:d.key.timing,metric:d.key.metric,
      n_a:d.extra?.n_a ?? s.n_a,n_b:d.extra?.n_b ?? s.n_b,
      mean_a:round(insufficient ? null : s.mean_a),mean_b:round(insufficient ? null : s.mean_b),diff:round(diff),
      ci95:insufficient || s.ci95 === null ? null : [round(s.ci95[0]),round(s.ci95[1])],pct:round(pct),
      p:insufficient || s.p === null ? null : Math.round(s.p*10000)/10000,q:q===null ? null : Math.round(q*10000)/10000,
      label:result.label,reason:result.reason,phrase:PHRASES[result.label],needed:neededText(d,result),low_confidence:d.low_confidence,
      consistent_blocks:consistent,binary:d.binary,rope:d.rope,kind:d.key.kind,
    };
    if (d.key.behavior) row.behavior = d.key.behavior;
    if (d.key.exposure) row.exposure = d.key.exposure;
    if (d.extra) return Object.assign({}, d.extra, row, result.matches_expected === undefined ? {} : { matches_expected: result.matches_expected });
    if (result.matches_expected !== undefined) row.matches_expected = result.matches_expected;
    return row;
  });
  return {rows,tests:drafts.length};
}

export function rankRows(rows: FamilyRow[]): FamilyRow[] {
  const order = {sólido:0,probable:0,indicio:1,sin_diferencia:2,sin_datos:3,cambio:4};
  return [...rows].sort((a,b)=>order[a.label]-order[b.label] || Math.abs(b.diff ?? 0)/b.rope-Math.abs(a.diff ?? 0)/a.rope || (a.metric<b.metric ? -1 : a.metric>b.metric ? 1 : 0));
}

export function publicRow(r: FamilyRow): InsightRow {
  const row: InsightRow & Partial<FamilyRow> = {...r};
  delete row.binary;
  delete row.rope;
  delete row.kind;
  return row;
}

export function shapeResponse<T extends object>(body: T, lists: (keyof T)[], env: Omit<Envelope,"truncated">): T & Envelope {
  const result = {...body,...env,truncated:false};
  for (const key of lists) {
    const value = body[key];
    if (!Array.isArray(value)) continue;
    const items = [...value];
    Object.assign(result,{[key]:items});
    while (items.length && JSON.stringify(result).length>20000) { items.pop(); result.truncated=true; }
  }
  return result;
}

export function analysisLogStatement(db: D1Database, tool: string, tests: number, nowMs: number): D1PreparedStatement {
  return db.prepare("INSERT INTO analysis_log (ts, tool, tests) VALUES (?, ?, ?)").bind(nowMs,tool,tests);
}
