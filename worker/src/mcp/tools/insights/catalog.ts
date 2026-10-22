import type { BeforeBedId, BehaviorId, BehaviorTiming, CalibrationCaps, Expected, ExposureMetric, Label, MetricId, MetricTiming, MoodId } from "./types";

export const BEFORE_BED_HOURS: Record<BeforeBedId, number> = { cigarettes: 2, caffeine: 6, alcohol: 3, mood_negative: 4, workout: 3, melatonin: 3 };
export const MOODS: { positive: MoodId[]; negative: MoodId[]; tired: MoodId[] } = {
  positive: ["mood_genial", "mood_bien", "mood_tranquilo"],
  negative: ["mood_estresado", "mood_ansioso", "mood_triste", "mood_enfadado"],
  tired: ["mood_cansado"],
};
export const NIGHT_METRICS: readonly MetricId[] = [
  "sleep_min", "deep_min", "rem_min", "light_min", "awake_min", "deep_pct", "rem_pct", "efficiency", "latency_min", "awakenings", "bedtime",
];
export const RECOVERY_METRICS: readonly MetricId[] = ["rhr", "hrv", "spo2_avg", "skin_temp_dev", "resp_rate"];
export const NIGHT_ANCHORED: readonly MetricId[] = [...NIGHT_METRICS, "hrv", "spo2_avg", "skin_temp_dev", "resp_rate"];
export const METRICS: Record<MetricId, { anchor: "night" | "wake" | "day" | "event"; rope: number; binary: boolean; lowConfidence: boolean; contrastOnly: boolean; unit: string }> = {
  sleep_min: { anchor: "night", rope: 15, binary: false, lowConfidence: false, contrastOnly: false, unit: "min" },
  deep_min: { anchor: "night", rope: 5, binary: false, lowConfidence: false, contrastOnly: false, unit: "min" },
  rem_min: { anchor: "night", rope: 5, binary: false, lowConfidence: false, contrastOnly: false, unit: "min" },
  light_min: { anchor: "night", rope: 5, binary: false, lowConfidence: false, contrastOnly: false, unit: "min" },
  awake_min: { anchor: "night", rope: 5, binary: false, lowConfidence: false, contrastOnly: false, unit: "min" },
  deep_pct: { anchor: "night", rope: 2, binary: false, lowConfidence: false, contrastOnly: false, unit: "pts" },
  rem_pct: { anchor: "night", rope: 2, binary: false, lowConfidence: false, contrastOnly: false, unit: "pts" },
  efficiency: { anchor: "night", rope: 2, binary: false, lowConfidence: false, contrastOnly: false, unit: "pts" },
  latency_min: { anchor: "night", rope: 5, binary: false, lowConfidence: true, contrastOnly: false, unit: "min" },
  awakenings: { anchor: "night", rope: 1, binary: false, lowConfidence: true, contrastOnly: false, unit: "count" },
  bedtime: { anchor: "night", rope: 15, binary: false, lowConfidence: false, contrastOnly: false, unit: "min after 18:00" },
  rhr: { anchor: "wake", rope: 1, binary: false, lowConfidence: false, contrastOnly: false, unit: "bpm" },
  hrv: { anchor: "wake", rope: 0.05, binary: false, lowConfidence: false, contrastOnly: false, unit: "ln ms" },
  spo2_avg: { anchor: "wake", rope: 0.5, binary: false, lowConfidence: false, contrastOnly: false, unit: "%" },
  skin_temp_dev: { anchor: "wake", rope: 0.2, binary: false, lowConfidence: false, contrastOnly: false, unit: "°C" },
  resp_rate: { anchor: "wake", rope: 0.5, binary: false, lowConfidence: false, contrastOnly: false, unit: "rpm" },
  steps: { anchor: "day", rope: 1000, binary: false, lowConfidence: false, contrastOnly: false, unit: "steps" },
  workout_min: { anchor: "day", rope: 10, binary: false, lowConfidence: false, contrastOnly: false, unit: "min" },
  mood_positive: { anchor: "day", rope: 0.15, binary: true, lowConfidence: false, contrastOnly: false, unit: "risk difference" },
  mood_negative: { anchor: "day", rope: 0.15, binary: true, lowConfidence: false, contrastOnly: false, unit: "risk difference" },
  mood_tired: { anchor: "day", rope: 0.15, binary: true, lowConfidence: false, contrastOnly: false, unit: "risk difference" },
  ...Object.fromEntries(Object.values(MOODS).flat().map(m => [m, { anchor: "day" as const, rope: 0.15, binary: true, lowConfidence: false, contrastOnly: true, unit: "risk difference" }] )) as Record<MoodId, { anchor: "day"; rope: number; binary: boolean; lowConfidence: boolean; contrastOnly: boolean; unit: string }>,
  hr_delta: { anchor: "event", rope: 2, binary: false, lowConfidence: false, contrastOnly: false, unit: "bpm" },
};
const MOOD_METRICS: readonly MetricId[] = ["mood_positive", "mood_negative", "mood_tired"];
const DAY_METRICS: readonly MetricId[] = ["steps", "workout_min", ...MOOD_METRICS];
export const BEHAVIOR_OUTCOMES: Record<BehaviorTiming, readonly MetricId[]> = {
  following_night: [...NIGHT_METRICS, ...RECOVERY_METRICS],
  before_bed: [...NIGHT_METRICS, ...RECOVERY_METRICS],
  next_day: DAY_METRICS,
  same_day: MOOD_METRICS,
};
export function behaviorExcluded(b: BehaviorId, m: MetricId): boolean {
  return (b === "short_sleep" && NIGHT_METRICS.includes(m))
    || (b === "steps" && m === "steps") || (b === "workout" && m === "workout_min")
    || (b === "mood_negative" && (m === "mood_negative" || m === "mood_positive" || MOODS.negative.includes(m as MoodId)))
    || (b === "mood_tired" && (m === "mood_tired" || m === "mood_cansado"));
}
const BEHAVIORS: readonly BehaviorId[] = ["cigarettes", "caffeine", "alcohol", "mood_negative", "mood_tired", "workout", "steps", "short_sleep", "water", "melatonin", "protein", "creatine"];
export const SCAN_PAIRS: readonly { behavior: BehaviorId; timing: BehaviorTiming; metric: MetricId }[] =
  (Object.keys(BEHAVIOR_OUTCOMES) as BehaviorTiming[]).flatMap(timing =>
    (timing === "before_bed" ? Object.keys(BEFORE_BED_HOURS) as BeforeBedId[] : BEHAVIORS)
      .flatMap(behavior => BEHAVIOR_OUTCOMES[timing].filter(metric => !behaviorExcluded(behavior, metric)).map(metric => ({ behavior, timing, metric }))));
export const METRIC_TIMINGS: Record<MetricTiming, { exposures: readonly ExposureMetric[]; outcomes: readonly MetricId[]; offset: 0 | 1 }> = {
  after_waking: { exposures: ["bedtime", "sleep_min", "hrv"], outcomes: DAY_METRICS, offset: 0 },
  next_night: { exposures: ["bedtime", "sleep_min", "hrv"], outcomes: [...NIGHT_ANCHORED, "rhr"], offset: 1 },
  following_night: { exposures: ["steps", "workout_min"], outcomes: [...NIGHT_ANCHORED, "rhr"], offset: 1 },
  that_night: { exposures: ["bedtime"], outcomes: ["deep_pct", "hrv", "rhr"], offset: 0 },
};
export function refusedMetricPair(e: ExposureMetric, t: MetricTiming, o: MetricId): string | null {
  if (e === o) return "A metric cannot be compared with itself (persistence).";
  if (e === "hrv" && o === "rhr") return "HRV and RHR share the same signal.";
  if (e === "bedtime" && ["sleep_min", "deep_min", "rem_min", "light_min", "efficiency", "awake_min", "latency_min"].includes(o)) return "Bedtime and this outcome share arithmetic.";
  if ((e === "steps" && o === "workout_min") || (e === "workout_min" && o === "steps")) return "Steps and workout minutes are coupled.";
  if (e === "sleep_min" && ["deep_min", "rem_min", "light_min", "awake_min", "deep_pct", "rem_pct"].includes(o)) return "Sleep duration and stage minutes or shares are coupled.";
  const rule = METRIC_TIMINGS[t];
  if (!rule.exposures.includes(e) || !rule.outcomes.includes(o)) return "Pair outside the allowed metric timing table; same-night and backward pairs are refused.";
  return null;
}
export const PLANNED: readonly { id: string; exposure: ExposureMetric; side: "high" | "low"; timing: MetricTiming; outcome: MetricId; expected: Expected }[] = [
  { id: "M1", exposure: "bedtime", side: "high", timing: "that_night", outcome: "rhr", expected: "+" },
  { id: "M2", exposure: "bedtime", side: "high", timing: "that_night", outcome: "deep_pct", expected: "none" },
  { id: "M3", exposure: "sleep_min", side: "low", timing: "after_waking", outcome: "steps", expected: "+" },
  { id: "M4", exposure: "sleep_min", side: "low", timing: "after_waking", outcome: "mood_tired", expected: "+" },
  { id: "M5", exposure: "steps", side: "high", timing: "following_night", outcome: "sleep_min", expected: "0" },
  { id: "M6", exposure: "workout_min", side: "high", timing: "following_night", outcome: "hrv", expected: "none" },
  { id: "M7", exposure: "hrv", side: "low", timing: "next_night", outcome: "sleep_min", expected: "none" },
  { id: "M8", exposure: "sleep_min", side: "low", timing: "next_night", outcome: "hrv", expected: "-" },
];
export const SCAN_Z = 0.5;
export const METRIC_MIN_PAIRS = 30;
export const LEG_MIN = 8;
export const BH_Q = 0.10;
export const CALIBRATION_CAPS: CalibrationCaps = { binary: false, acute: false, metricContinuous: false, metricBinary: false };
export const PHRASES: Record<Label, string> = {
  sólido: "va asociado a … y se ha confirmado con datos nuevos (n)",
  probable: "parece que … ; aún no comprobado con datos nuevos",
  indicio: "hay un indicio … ; puede ser casualidad; faltan …",
  sin_diferencia: "por ahora no se ve diferencia clara",
  sin_datos: "aún no hay datos: faltan …",
  cambio: "desde el … tu … ha cambiado …; es un candidato, falta comprobarlo",
};
export const BANNED = /\b(causa|causes|sin efecto|no effect)\b/i;
export const RANGE = { defaultDays: 120, maxDays: 180, before: 43, after: 1 } as const;
export const NEEDED_TEXT: { behavior: Record<BehaviorId, string>; night: string; day: string } = {
  behavior: { water: "días con agua", melatonin: "días con melatonina", protein: "días con proteína", creatine: "días con creatina", cigarettes: "días con cigarro", caffeine: "días con cafeína", alcohol: "días con alcohol", mood_negative: "días con ánimo negativo", mood_tired: "días con cansancio", workout: "días con entrenamiento", steps: "días con pasos", short_sleep: "días con sueño corto" },
  night: "noches", day: "días",
};
