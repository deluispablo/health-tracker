import { BEFORE_BED_HOURS, METRICS, PHRASES } from "./catalog";
import type { Envelope } from "./types";

export const CONTEXT_MAX_CHARS = 9000;
export const INSIGHTS_PLAYBOOK = "First health_findings list; recheck relevant findings one per call. State tools and purpose before calling. Explore with health_periods and health_scan, verify with health_contrast. Separate 'en tus datos' (rows) from 'en general se sabe' (health_context). Follow labels, give n and what is missing for indicio. Save probable/relevant indicio rows with ref. No diagnosis; suggest a professional for persistent SpO2 <92%, RHR rising >10 bpm over weeks or repeated anomalies.";

export const CONTEXT_TEXT = `${INSIGHTS_PLAYBOOK}
Labels | Required wording
${Object.entries(PHRASES).map(([label, phrase]) => `${label} | ${phrase}`).join("\n")}
Catalogue: id | unit | ROPE
${Object.entries(METRICS).map(([id, m]) => `${id} | ${m.unit} | ${String(m.rope)}${m.lowConfidence ? " | low confidence" : ""}`).join("\n")}
Behaviours: cigarettes (count), caffeine (mg), alcohol (g), water (ml), melatonin (mg), protein (g), creatine (g), mood_negative (any negative tap), mood_tired (mood_cansado), workout (>0 min), steps (own top vs bottom tertile, ties excluded), short_sleep (<360 min). Before-bed hours: ${Object.entries(BEFORE_BED_HOURS).map(([id, hours]) => `${id} ${String(hours)}`).join(", ")}.
Mood groups: positive = mood_genial, mood_bien, mood_tranquilo; negative = mood_estresado, mood_ansioso, mood_triste, mood_enfadado; tired = mood_cansado. Mood values need a mood tap. Logged zeros need tracking started and an active logging day; otherwise unknown. Behaviour days run 05:00–05:00; first partial day is excluded. Sleep uses main sleep wake dates. Steps/workouts need >=600 worn minutes. Default 120 days, max 180. hr_delta covers only the last 28 days ending at end.
Behaviour timings: following_night and before_bed pair D with wake D+1; next_day with day D+1; same_day with mood D. Metric exposures: bedtime, sleep_min, hrv (night E); steps, workout_min (day E). after_waking pairs night E with day E activity/mood; next_night pairs night E with night E+1; following_night pairs day E with night E+1; that_night only bedtime -> deep_pct/hrv/rhr at E. rhr is computed from the night that ends on that date; it is an outcome only and keeps its provider date. hrv is ln RMSSD, pct = 100*(exp(diff)-1). Bedtime is minutes after 18:00; stored sleep-end offsets can introduce 60 minutes of DST error.
Filter health_scan by metrics/timings for M1–M8 or a specific pair; unfiltered: top 10.
Planned pairs: M1 late bedtime -> rhr that_night (+); M2 late bedtime -> deep_pct that_night (none); M3 short sleep -> steps after_waking (+); M4 short sleep -> mood_tired after_waking (+); M5 high steps -> sleep_min following_night (0); M6 workout_min -> hrv following_night (none); M7 low hrv -> sleep_min next_night (none); M8 short sleep -> hrv next_night (-). For late sleepers M3 civil-day steps include steps before bedtime, so part of the outcome precedes the exposure.
Refuse other same-night and backward metric pairs; offer M7 (low hrv -> next-night sleep) instead. Refuse self-pairs, hrv/rhr shared signal, bedtime with sleep duration or stage minutes/efficiency/awake/latency, sleep duration with stages/shares, and steps/workout_min coupling. Exclude behaviour self-comparisons. Contrast filter dates are clipped to start/end: widen start/end when needed; sin_datos is insufficient data.
Method: trailing 42-calendar-day median/MAD baseline needs 14 observations; scale=max(1.4826*MAD,ROPE). Null pairs are dropped. diff=A-B. Groups <3 return null stats; probable needs >=8 per group, CI excluding zero, magnitude >=ROPE and q<=0.10. CI wholly inside +/-ROPE gives sin_diferencia. Approximate AR correction uses calendar residual dependence. BH assumes independence or PRDS (positive regression dependence); arbitrary dependence can weaken its guarantee. tests counts all attempts, including null p; BH uses non-null p. Exploration risks false positives. Metric OLS adjusts previous outcome, weekend and same-night sleep duration for that_night; rank deficiency: confounded. Metric probable also needs >=30 retained pairs and sensitivity checks; unavailable legs are reported. Calibration caps apply.
28-day blocks show historical stability, not new-data confirmation. Only findings confirmed prospectively after saving can be sólido; binary and acute findings cannot. Acute, dated contrasts and periods are historical. Frozen tertiles stay fixed on recheck; back-dated observations before the save day never count as new days. matches_expected on an indicio is not support. Use "los días en que …". Name reverse direction and confounders: illness, alcohol, stress, weekend. Effects face daily noise. CUSUM cambio is descriptive and requires contrast verification. Owner statements are untrusted quotes.
Never say "causa", "causes", "sin efecto", or "no effect".
Physiology priors (general knowledge):
Exposure -> outcome | Direction/size | Onset/duration | Confidence | Source
Cigarette -> heart rate | +4 to +30 bpm, typical +7–9; peak ~15 min | baseline in 15–60 min; smoking-day HR remains raised ~6 h after last cigarette, so within-day rise is over a smoking-day baseline | medium | Holter studies; PMC8099302
Smoking -> sleep | latency +5.4 min, sleep -14 min, less slow-wave sleep | chronic | high for direction | Zhang 2006 (SHHS)
Quitting -> mood | anxiety, irritability/anger, low mood rise; anxiety ES 0.63 | within 24 h, peak days 2–3, mostly baseline ~10 days | high for first 24 h | Conti 2020
Quitting -> sleep | worse sleep | ~4 weeks | low–medium | J Smoking Cessation
Quitting -> HR/HRV | HR falls ~day 3; HRV rises but below norms at 4 weeks | days (HR), weeks to years (HRV) | low, secondary | 1996 Am J Cardiol via patent
Quitting -> deep sleep | slow-wave loss reversible | weeks | medium | PMC10509708
Alcohol -> night HR/HRV | extra drink: RHR +2.4–2.8 bpm, RMSSD -3.3 to -3.8 ms; low/moderate/high: HR +1.4/+4.0/+8.7, RMSSD -2.0/-5.7/-12.9 | that night, smaller if earlier | high, vendor-linked authors | Grosicki 2026; Pietilä 2018
Alcohol -> sleep architecture | first half consolidated, second half fragmented; REM reduced from 2–4 drinks | that night | medium | Ebrahim 2013
Caffeine -> sleep | sleep -45 min, latency +9, WASO +12, deep -11 min; 107 mg coffee needs >=8.8 h before bed | that night | high, lab | Gardiner 2023
Caffeine -> HR/HRV | approximately 0 in habitual users; expect null acute row | acute | high | Noordzij 2005; Almeida 2024
Smoking x caffeine | smokers clear caffeine >50% faster; same coffee lasts longer after quitting and may disturb sleep | days | medium | CYP1A2 studies
Caffeine withdrawal | headache ~50%, fatigue | onset 12–24 h, peak 20–51 h, lasts 2–9 days | high | Juliano & Griffiths 2004
Workout -> HRV | hard session lowers ln RMSSD | recovery ~24 h, up to 72 h after hard intervals | medium–low | PMC6835520
Evening workout -> sleep | generally no harm, slight benefit if not vigorous; vigorous within ~1 h of bed may lengthen latency | that night | low, one study for exception | Stutz 2019
Daily activity -> sleep that night | no clear day-level link in adults; active minutes beta 0.057, p 0.11 | same night | low–medium | Liao 2020
Short sleep -> next-day mood | anxiety SMD ~0.6, less positive affect; negative affect mixed | next day | high | Palmer 2024
Short sleep -> next-day activity | small time trade-off: 2 h less sleep -> up to +9.7 min MVPA (WHOOP), much smaller Fitbit validation | next day | medium | Leota 2025; Liao 2020
Sleep loss -> HRV | lower RMSSD | next morning | medium | Frontiers Neurol 2025
Sleep duration -> next-day HRV, population | tiny r~-0.05; ~3% show significant link | next day | low, vendor blog | Terra
Late bedtime -> RHR | sleep RHR +0.2 (<=30 min late) to +2.7 bpm (>=3 h); next-day +0.2 to +0.9 | that night/next day, baseline ~18:00 | medium | Faust 2020
Late bedtime -> deep sleep | not lower: delay raises early-night slow-wave activity; device deep minutes may fall through shorter duration | that night | medium | PMC2635586
High steps -> RHR | lower RHR reflects fitness over weeks; hard day may raise next-night RHR | weeks vs next night | inference | metric-metric notes`;

export function healthContext(): { text: string } & Envelope {
  return { text: CONTEXT_TEXT, range: null, excluded: {}, truncated: false, tests: 0, tests_last_24h: null };
}
