import { dateTimeFormat } from "../../../lib/time";
import { BEFORE_BED_HOURS, METRICS, MOODS, RANGE } from "./catalog";
import type { BeforeBedId, BehaviorId, MetricId, MoodId, RangeArgs } from "./types";

const DAY = 86400000;
const addDays = (date: string, days: number): string => new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0,10);
export interface ResolvedRange { start: string; end: string; fetchStart: string; fetchEnd: string; window_days: number | null }
export function lastCompletedBday(nowSec: number, tz: string): string {
  const parts = dateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowSec * 1000));
  const part = (key: string) => parts.find(p => p.type === key)?.value ?? "";
  return addDays(part("year") + "-" + part("month") + "-" + part("day"), Number(part("hour")) >= 5 ? -1 : -2);
}
function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z")) || new Date(date + "T00:00:00Z").toISOString().slice(0,10) !== date)
    throw new RangeError("Dates must be real calendar dates in YYYY-MM-DD format.");
}
export function resolveRange(args: { start?: string; end?: string }, nowSec: number, tz: string): ResolvedRange {
  const last = lastCompletedBday(nowSec,tz);
  const end = args.end ?? last;
  validateDate(end);
  const start = args.start ?? addDays(end,1-RANGE.defaultDays);
  validateDate(start);
  const days = (Date.parse(end)-Date.parse(start))/DAY+1;
  if (days < 1 || days > RANGE.maxDays) throw new RangeError("Range must contain 1 to 180 days.");
  if (end > last) throw new RangeError("Range ends after the last completed behaviour day.");
  return {start,end,fetchStart:addDays(start,-RANGE.before),fetchEnd:addDays(end,RANGE.after),window_days:args.start === undefined && args.end === undefined ? RANGE.defaultDays : null};
}
export function originRange(args: { start?: string; end?: string }, nowSec: number, tz: string): RangeArgs {
  const r=resolveRange(args,nowSec,tz);
  return r.window_days === null ? {start:r.start,end:r.end} : {window_days:r.window_days};
}
export function rangeFromOrigin(r: RangeArgs, nowSec: number, tz: string): ResolvedRange {
  if (!("window_days" in r)) return resolveRange(r,nowSec,tz);
  if (!Number.isInteger(r.window_days) || r.window_days < 1 || r.window_days > RANGE.maxDays) throw new RangeError("window_days must be an integer from 1 to 180.");
  const end=lastCompletedBday(nowSec,tz);
  return {...resolveRange({start:addDays(end,1-r.window_days),end},nowSec,tz),window_days:r.window_days};
}
export interface DayTable {
  dates: string[]; idx: (date: string) => number; start: number; end: number; weekend: boolean[];
  behavior: Record<BehaviorId, (number | null)[]>;
  beforeBed: Record<BeforeBedId, (0 | 1 | null)[]>;
  metric: Record<Exclude<MetricId, "hr_delta">, (number | null)[]>;
  moodTaps: Record<MoodId, number[]>;
  first: Record<typeof TRACKERS[number], { ts: number; bday: string } | null>;
  tests_last_24h: number;
}
const MOOD_IDS = Object.values(MOODS).flat();
const MOOD_GROUPS = Object.entries(MOODS) as [keyof typeof MOODS,MoodId[]][];
const BED_IDS = Object.keys(BEFORE_BED_HOURS) as BeforeBedId[];
const AMOUNT_IDS = ["cigarettes","caffeine","alcohol","water","melatonin","protein","creatine"] as const;
const TRACKERS = [...AMOUNT_IDS,"mood"] as const;
const BEHAVIORS: BehaviorId[] = ["cigarettes","caffeine","alcohol","mood_negative","mood_tired","workout","steps","short_sleep","water","melatonin","protein","creatine"];
const quoteList = (ids: string[]) => ids.map(id=> "'" + id + "'").join(",");
const negative = quoteList(MOODS.negative);
const moods = quoteList(MOOD_IDS);
const BDAY = "date(ts + tz_offset_min * 60 - 18000, 'unixepoch')";
const SQL = `
WITH RECURSIVE dates(local_date) AS (
  SELECT ?1 UNION ALL SELECT date(local_date, '+1 day') FROM dates WHERE local_date < ?2
), sleeps AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY local_date ORDER BY minutes_in_bed DESC NULLS LAST, end_ts DESC, source_id DESC
  ) AS rank FROM sleep_session WHERE is_nap = 0 AND local_date BETWEEN ?1 AND ?2
), live AS (
  SELECT *, ${BDAY} AS bday FROM event WHERE deleted_at IS NULL
), taps AS (
  SELECT bday, COUNT(*) AS active,
    ${AMOUNT_IDS.map(id=>`SUM(CASE WHEN tracker_id = '${id}' THEN value ELSE 0 END) AS ${id}`).join(",")},
    ${MOOD_IDS.map(id=>`SUM(tracker_id = '${id}') AS ${id}`).join(",")}
  FROM live WHERE local_date BETWEEN date(?1, '-1 day') AND date(?2, '+1 day')
    AND bday BETWEEN date(?1, '-1 day') AND ?2 GROUP BY bday
), starts AS (
  SELECT *, CASE WHEN tracker_id IN (${moods}) THEN 'mood' ELSE tracker_id END AS tracker,
    ${BDAY} AS bday FROM event
), firsts AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY tracker ORDER BY ts, id) AS rank FROM starts
), first_values AS (
  SELECT ${TRACKERS.flatMap(id=>[
    `MAX(CASE WHEN tracker = '${id}' AND rank = 1 THEN ts END) AS first_${id}_ts`,
    `MAX(CASE WHEN tracker = '${id}' AND rank = 1 THEN bday END) AS first_${id}_bday`,
  ]).join(",")} FROM firsts
)
SELECT d.local_date, f.*, COALESCE(a.active, 0) AS active, COALESCE(prev.active, 0) AS previous_active,
  ${[...AMOUNT_IDS,...MOOD_IDS].map(id=>`COALESCE(a.${id}, 0) AS ${id}`).join(",")},
  ds.rhr, ds.ln_rmssd AS hrv, ds.spo2_avg, ds.skin_temp_dev, ds.resp_rate,
  ds.steps, ds.workout_min, ds.hr_wear_min,
  s.start_ts AS bed, s.minutes_asleep AS sleep_min, s.deep_min, s.rem_min, s.light_min, s.awake_min,
  s.efficiency, s.latency_min,
  ((CAST(strftime('%H', s.start_ts + s.tz_offset_min * 60, 'unixepoch') AS INTEGER) * 60
    + CAST(strftime('%M', s.start_ts + s.tz_offset_min * 60, 'unixepoch') AS INTEGER) - 1080 + 1440) % 1440) AS bedtime,
  CASE WHEN EXISTS (SELECT 1 FROM sleep_stage st WHERE st.session_id = s.source_id)
    THEN (SELECT COUNT(*) FROM sleep_stage st WHERE st.session_id = s.source_id AND st.stage = 'AWAKE'
      AND st.start_ts > s.start_ts AND st.end_ts < s.end_ts) END AS awakenings,
  ${(Object.keys(BEFORE_BED_HOURS) as BeforeBedId[]).filter(id=>id!=="workout").map(id=>`
    EXISTS (SELECT 1 FROM live e WHERE e.tracker_id ${id==="mood_negative" ? "IN ("+negative+")" : "= '"+id+"'"} AND e.ts >= s.start_ts - ${String(BEFORE_BED_HOURS[id]*3600)} AND e.ts < s.start_ts) AS window_${id}`).join(",")},
  EXISTS (SELECT 1 FROM live e WHERE e.tracker_id IN (${moods}) AND e.ts >= s.start_ts - ${String(BEFORE_BED_HOURS.mood_negative*3600)} AND e.ts < s.start_ts) AS window_mood_taps,
  EXISTS (SELECT 1 FROM workout w WHERE w.end_ts >= s.start_ts - ${String(BEFORE_BED_HOURS.workout*3600)} AND w.end_ts < s.start_ts) AS workout_late,
  EXISTS (SELECT 1 FROM workout w WHERE w.local_date = date(d.local_date, '-1 day') AND w.end_ts < s.start_ts - ${String(BEFORE_BED_HOURS.workout*3600)}) AS workout_early,
  (SELECT COALESCE(SUM(tests), 0) FROM analysis_log WHERE ts >= ?3 * 1000 - 86400000) AS tests_last_24h
FROM dates d CROSS JOIN first_values f
LEFT JOIN daily_summary ds ON ds.local_date = d.local_date
LEFT JOIN sleeps s ON s.local_date = d.local_date AND s.rank = 1
LEFT JOIN taps a ON a.bday = d.local_date
LEFT JOIN taps prev ON prev.bday = date(d.local_date, '-1 day')
ORDER BY d.local_date
`;
function numberAt(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
interface Row { local_date: string; [key: string]: string | number | null }
export async function loadDayTable(db: D1Database, range: ResolvedRange, nowSec: number): Promise<DayTable> {
  const {results:rows}=await db.prepare(SQL).bind(range.fetchStart,range.fetchEnd,nowSec).all<Row>();
  return shapeDayTable(rows, range);
}

export function shapeDayTable(rows: Row[], range: ResolvedRange): DayTable {
  const dates=rows.map(r=>r.local_date);
  const indices=new Map(dates.map((d,i)=>[d,i]));
  const t:DayTable = {
    dates, idx:date=>indices.get(date) ?? -1, start:indices.get(range.start) ?? -1, end:indices.get(range.end) ?? -1,
    weekend:dates.map(d=>[0,6].includes(new Date(d+"T00:00:00Z").getUTCDay())),
    behavior:Object.fromEntries(BEHAVIORS.map(b=>[b,[] as (number|null)[]])) as DayTable["behavior"],
    beforeBed:Object.fromEntries(Object.keys(BEFORE_BED_HOURS).map(b=>[b,[] as (0|1|null)[]])) as DayTable["beforeBed"],
    metric:Object.fromEntries(Object.keys(METRICS).filter(m=>m!=="hr_delta").map(m=>[m,[] as (number|null)[]])) as DayTable["metric"],
    moodTaps:Object.fromEntries(MOOD_IDS.map(m=>[m,[] as number[]])) as DayTable["moodTaps"],
    first:{cigarettes:null,caffeine:null,alcohol:null,water:null,melatonin:null,protein:null,creatine:null,mood:null},tests_last_24h:0,
  };
  for (const id of TRACKERS) {
    const row=rows[0], ts=row["first_"+id+"_ts"], bday=row["first_"+id+"_bday"];
    if (typeof ts==="number" && typeof bday==="string") t.first[id]={ts,bday};
  }
  for (const m of Object.keys(t.metric) as (keyof DayTable["metric"])[]) {
    const values = t.metric[m];
    for (const row of rows) {
      const value = row[m];
      values.push(typeof value === "number" && Number.isFinite(value) ? value : null);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const day=row.local_date;
    const known=(id:typeof TRACKERS[number])=>t.first[id] !== null && day > t.first[id].bday && (numberAt(row, "active") ?? 0)>0;
    const asleep=numberAt(row, "sleep_min");
    const deep = t.metric.deep_min[i], rem = t.metric.rem_min[i];
    t.metric.deep_pct[i] = asleep && deep !== null ? 100 * deep / asleep : null;
    t.metric.rem_pct[i] = asleep && rem !== null ? 100 * rem / asleep : null;
    const wear=numberAt(row, "hr_wear_min");
    const worn=wear===null ? null : wear>=600;
    t.metric.steps[i] = worn ? t.metric.steps[i] : null;
    t.metric.workout_min[i] = worn ? t.metric.workout_min[i] ?? 0 : null;
    for (const id of AMOUNT_IDS) t.behavior[id].push(known(id) ? numberAt(row, id) ?? 0 : null);
    const moodCount=MOOD_IDS.reduce((sum,id)=>sum+(numberAt(row, id) ?? 0),0);
    const moodKnown=known("mood") && moodCount>0;
    for (const id of MOOD_IDS) { t.moodTaps[id].push(numberAt(row, id) ?? 0); t.metric[id][i] = moodKnown ? Number((numberAt(row, id) ?? 0)>0) : null; }
    for (const [group,ids] of MOOD_GROUPS) {
      const value=moodKnown ? Number(ids.some(id=>(numberAt(row, id) ?? 0)>0)) : null;
      t.metric[`mood_${group}`][i] = value;
    }
    t.behavior.mood_negative.push(t.metric.mood_negative[i]);
    t.behavior.mood_tired.push(t.metric.mood_tired[i]);
    t.behavior.steps.push(t.metric.steps[i]);
    t.behavior.workout.push((numberAt(row, "workout_min") ?? 0)>0 ? 1 : worn ? 0 : null);
    t.behavior.short_sleep.push(asleep===null ? null : Number(asleep<360));
    for (const id of BED_IDS) {
      const bed=numberAt(row, "bed");
      let value:0|1|null=null;
      if (bed!==null) {
        if (id==="workout") value=numberAt(row, "workout_late") ? 1 : numberAt(row, "workout_early") ? 0 : null;
        else {
          const first=t.first[id==="mood_negative" ? "mood" : id];
          if (first && bed-BEFORE_BED_HOURS[id]*3600>=first.ts && numberAt(row, "previous_active") && (id!=="mood_negative" || numberAt(row, "window_mood_taps")))
            value=numberAt(row, "window_"+id) ? 1 : 0;
        }
      }
      t.beforeBed[id].push(value);
    }
    t.tests_last_24h=numberAt(row, "tests_last_24h") ?? 0;
  }
  return t;
}
