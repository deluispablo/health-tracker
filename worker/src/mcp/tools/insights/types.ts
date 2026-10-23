export type Label = "sólido" | "probable" | "indicio" | "sin_diferencia" | "sin_datos" | "cambio";
export type Reason = "few_days" | "few_effective_days" | "uncertain" | "small_effect" | "not_robust" | "confounded";
export type Expected = "+" | "-" | "0" | "none";
export type BehaviorId = "water" | "melatonin" | "protein" | "creatine" | "cigarettes" | "caffeine" | "alcohol" | "mood_negative" | "mood_tired" | "workout" | "steps" | "short_sleep";
export type BeforeBedId = "melatonin" | "cigarettes" | "caffeine" | "alcohol" | "mood_negative" | "workout";
export type MoodId = "mood_genial" | "mood_bien" | "mood_tranquilo" | "mood_cansado" | "mood_estresado" | "mood_ansioso" | "mood_triste" | "mood_enfadado";
export type MetricId = "sleep_min" | "deep_min" | "rem_min" | "light_min" | "awake_min" | "deep_pct" | "rem_pct" | "efficiency" | "latency_min"
  | "awakenings" | "bedtime" | "rhr" | "hrv" | "spo2_avg" | "skin_temp_dev" | "resp_rate" | "steps" | "workout_min"
  | "mood_positive" | "mood_negative" | "mood_tired" | MoodId | "hr_delta";
export type BehaviorTiming = "following_night" | "before_bed" | "next_day" | "same_day";
export type ExposureMetric = "bedtime" | "sleep_min" | "hrv" | "steps" | "workout_min";
export type MetricTiming = "after_waking" | "next_night" | "following_night" | "that_night";
export type AcuteTracker = "cigarettes" | "caffeine" | "alcohol";
export type ChangeBehaviorId = AcuteTracker | "water";
export type Interval = [number, number];

export interface Inference { diff: number | null; ci95: Interval | null; p: number | null; df: number | null; phi: number; n_eff_a: number; n_eff_b: number }
export interface GroupStats extends Inference { n_a: number; n_b: number; mean_a: number | null; mean_b: number | null }
export interface Leg { status: "robust" | "not_robust" | "unavailable"; diff: number | null; n_a: number; n_b: number }
export interface MetricPair { exposure: ExposureMetric; side: "high" | "low" | "filter"; timing: MetricTiming; outcome: MetricId; planned_id?: string; expected?: Expected }
export interface MetricStats extends GroupStats { binary: boolean; adjusted_for: string[]; reason: "confounded" | null;
  sensitivity: { alcohol: Leg; weekdays?: Leg }; excluded: Record<string, number>; groupIdx: { a: number[]; b: number[] } }
export interface LabelOutcome { label: Label; reason: Reason | null; needed: string | null; matches_expected?: boolean | null }
export interface CalibrationCaps { binary: boolean; acute: boolean; metricContinuous: boolean; metricBinary: boolean }

export interface Condition { behavior?: BehaviorId; metric?: ExposureMetric; op: ">" | ">=" | "=" | "<" | "<="; value: number; scale?: "value" | "z"; timing?: "day" | "before_bed" }
export interface Filter { from?: string; to?: string; weekdays?: number[]; where?: Condition[]; include_anomalies?: boolean }
export type RangeArgs = { start: string; end: string } | { window_days: number };
export type ScanOriginArgs = RangeArgs & { behaviors?: BehaviorId[]; metrics?: MetricId[]; timings?: string[] };
export type ContrastOriginArgs = RangeArgs & { a: Filter; b: Filter; metrics?: MetricId[]; timing: BehaviorTiming | MetricTiming };
export type PeriodsOriginArgs = RangeArgs & { behaviors?: BehaviorId[]; metrics?: (MetricId | ChangeBehaviorId)[] };
export type Origin = { tool: "health_scan"; args: ScanOriginArgs } | { tool: "health_contrast"; args: ContrastOriginArgs } | { tool: "health_periods"; args: PeriodsOriginArgs };
export interface RowKey { kind: "behavior" | "acute" | "period" | "metric"; behavior?: BehaviorId | AcuteTracker; exposure?: { metric: ExposureMetric; side: "high" | "low" | "filter" }; planned_id?: string; timing: string; metric: MetricId }
export interface Cutpoints { lo: number; hi: number }
export interface RowRef { v: 1; origin: Origin; key: RowKey; cutpoints?: Cutpoints }
export interface StoredRef extends RowRef { resolved: { start: string; end: string }; mode: "prospective" | "historical" }

export interface InsightRow { ref: RowRef | null; behavior?: string; exposure?: { metric: ExposureMetric; side: "high" | "low" | "filter" }; timing: string; metric: MetricId;
  n_a: number; n_b: number; mean_a: number | null; mean_b: number | null; diff: number | null; ci95: Interval | null; pct: number | null; p: number | null; q: number | null;
  label: Label; phrase: string; reason: Reason | null; needed: string | null; low_confidence: boolean; consistent_blocks: { same: number; of: number } | null;
  planned_id?: string | null; expected?: Expected | null; matches_expected?: boolean | null; adjusted_for?: string[]; sensitivity?: { alcohol: Leg; weekdays?: Leg } }
export interface FamilyRow extends InsightRow { binary: boolean; rope: number; kind: RowKey["kind"] } // internal; public output strips binary/rope/kind
export interface EvalOptions { nowSec: number; tz: string; range?: { start: string; end: string }; cutpoints?: Cutpoints; only?: RowKey }
export interface FamilyResult { rows: FamilyRow[]; resolved: { start: string; end: string }; tests: number; excluded: Record<string, number>;
  tests_last_24h: number; extra: Record<string, unknown> } // rows = full family, before ranking/truncation; extra = skipped, streaks, changes, mood_weeks, anomalies
export interface Envelope { range: { start: string; end: string } | null; excluded: Record<string, number>; truncated: boolean; tests: number; tests_last_24h: number | null }
export interface FindingsEvaluator {
  validateOrigin(origin: unknown): Origin;                                                    // RangeError on any invalid origin
  family(origin: Origin, opts: { range?: { start: string; end: string } }): Promise<FamilyResult>; // full family, no analysis_log write
  single(ref: StoredRef, range: { start: string; end: string }): Promise<FamilyRow | null>;   // only the saved row, family of 1 (q = p), frozen cutpoints; null when the key cannot be evaluated on that range
  newDataRange(savedAtMs: number): { start: string; end: string } | null;                     // bday after saved_at's bday … last completed bday, clamped to 180 days; null when empty
}
