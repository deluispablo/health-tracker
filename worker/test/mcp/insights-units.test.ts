import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { lastCompletedBday, loadDayTable, originRange, rangeFromOrigin, resolveRange } from "../../src/mcp/tools/insights/units";
import { anomalyFlags, computeBaselines } from "../../src/mcp/tools/insights/baseline";
import { FIXTURE, seedInsightsFixture } from "../fixtures/insights";

const now = Date.parse("2026-10-22T08:00:00Z") / 1000;
const tz = "Europe/Madrid";
const range = () => resolveRange({start:"2026-10-01",end:"2026-10-21"},now,tz);
async function event(id:string, tracker:string, at:string, deleted = false, offset = 120) {
  const ts = Date.parse(at)/1000;
  await env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at,deleted_at) VALUES (?,?,?,?,?,1,'import',1,?)")
    .bind(id,tracker,ts,offset,new Date((ts+offset*60)*1000).toISOString().slice(0,10),deleted ? 1 : null).run();
}
async function sleep(id:string, wake:string, start = wake+"T00:00:00Z", bed = 480, end = wake+"T07:00:00Z", nap = 0, offset = 120, asleep = 420) {
  await env.DB.prepare("INSERT INTO sleep_session (source_id,start_ts,end_ts,tz_offset_min,local_date,is_nap,minutes_asleep,minutes_in_bed,deep_min,rem_min,updated_at) VALUES (?,?,?,?,?,?,?,?,60,90,1)")
    .bind(id,Date.parse(start)/1000,Date.parse(end)/1000,offset,wake,nap,asleep,bed).run();
}
async function summary(day:string,wear:number|null,workout:number|null = null) {
  await env.DB.prepare("INSERT INTO daily_summary (local_date,steps,hr_wear_min,workout_min,ln_rmssd,computed_at) VALUES (?,5000,?,?,4,1)").bind(day,wear,workout).run();
}
beforeAll(async () => {
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS analysis_log (ts INTEGER NOT NULL, tool TEXT NOT NULL, tests INTEGER NOT NULL)").run();
});
beforeEach(async () => {
  await env.DB.batch(["sleep_stage","sleep_session","event","daily_summary","workout","metric_minute","analysis_log"].map(t => env.DB.prepare(`DELETE FROM ${t}`)));
});
it("resolves completed bdays around 05:00 in Madrid", () => {
  expect(lastCompletedBday(now,tz)).toBe("2026-10-21");
  expect(lastCompletedBday(Date.parse("2026-10-22T02:59:00Z")/1000,tz)).toBe("2026-10-20");
  expect(lastCompletedBday(Date.parse("2026-10-22T03:00:00Z")/1000,tz)).toBe("2026-10-21");
});
it("resolves defaults, fetch bounds, strict dates and bounded ranges", () => {
  expect(resolveRange({},now,tz)).toEqual({start:"2026-06-24",end:"2026-10-21",fetchStart:"2026-05-12",fetchEnd:"2026-10-22",window_days:120});
  for (const args of [{start:"2026-04-24",end:"2026-10-21"},{end:"2026-10-22"},{start:"2026-02-30"},{start:"2026-10-21",end:"2026-10-20"}]) expect(() => resolveRange(args,now,tz)).toThrow(RangeError);
});
it("round-trips a relative window after advancing three days", () => {
  const origin = originRange({},now,tz);
  expect(origin).toEqual({window_days:120});
  expect(rangeFromOrigin(origin,now+3*86400,tz)).toMatchObject({start:"2026-06-27",end:"2026-10-24",window_days:120});
  expect(originRange({start:"2026-10-01",end:"2026-10-03"},now,tz)).toEqual({start:"2026-10-01",end:"2026-10-03"});
  for (const window_days of [0,181,1.5,NaN]) expect(() => rangeFromOrigin({window_days},now,tz)).toThrow(RangeError);
});
it("keeps a dense calendar, 224 rows at 180 days, and an empty database", async () => {
  const t = await loadDayTable(env.DB,rangeFromOrigin({window_days:180},now,tz),now);
  expect(t.dates).toHaveLength(224);
  expect(t.end-t.start+1).toBe(180);
  expect(t.idx("1900-01-01")).toBe(-1);
  expect(t.metric.rhr.every(x=>x===null)).toBe(true);
  expect(t.behavior.cigarettes.every(x=>x===null)).toBe(true);
});
it("keeps a missing day between populated days so lags pair by date", async () => {
  await summary("2026-10-02",600);
  await summary("2026-10-04",600);
  await event("first","cigarettes","2026-09-30T10:00:00Z");
  await event("x","cigarettes","2026-10-02T10:00:00Z");
  await event("x-plus-two","cigarettes","2026-10-04T10:00:00Z");
  const t=await loadDayTable(env.DB,range(),now);
  const x=t.idx("2026-10-02"), missing=t.idx("2026-10-03"), next=t.idx("2026-10-04");
  expect(next-x).toBe(2);
  expect(missing).toBe(x+1);
  expect(t.metric.steps[x]).toBe(5000);
  expect(t.metric.steps[next]).toBe(5000);
  expect(t.behavior.cigarettes[x]).toBe(1);
  expect(t.behavior.cigarettes[next]).toBe(1);
  for (const values of [...Object.values(t.metric),...Object.values(t.behavior),...Object.values(t.beforeBed)])
    expect(values[missing]).toBeNull();
});
it("includes a cigarette across midnight in the before-bed window", async () => {
  await event("first","cigarettes","2026-09-30T10:00:00Z");
  await event("late","cigarettes","2026-10-02T21:30:00Z"); // 23:30 local
  await sleep("s","2026-10-03","2026-10-02T23:00:00Z"); // 01:00 local
  const t=await loadDayTable(env.DB,range(),now);
  expect(t.beforeBed.cigarettes[t.idx("2026-10-03")]).toBe(1);
});
it("includes deleted first events, excludes partial bdays, and nulls inactive days", async () => {
  await event("first","cigarettes","2026-10-01T10:00:00Z",true);
  await event("mood","mood_bien","2026-10-02T10:00:00Z");
  await event("next","mood_cansado","2026-10-03T10:00:00Z");
  const t = await loadDayTable(env.DB,range(),now);
  expect(t.first.cigarettes?.bday).toBe("2026-10-01");
  expect(t.behavior.cigarettes[t.idx("2026-10-01")]).toBeNull();
  expect(t.behavior.cigarettes[t.idx("2026-10-02")]).toBe(0);
  expect(t.behavior.cigarettes[t.idx("2026-10-04")]).toBeNull();
  expect(t.metric.mood_positive[t.idx("2026-10-02")]).toBeNull();
  expect(t.metric.mood_positive[t.idx("2026-10-03")]).toBe(0);
  expect(t.behavior.mood_tired[t.idx("2026-10-03")]).toBe(1);
  expect(t.moodTaps.mood_bien[t.idx("2026-10-02")]).toBe(1);
});
it("assigns a drink at 01:30 to the previous bday", async () => {
  await event("first","alcohol","2026-09-30T10:00:00Z");
  await event("drink","alcohol","2026-10-02T23:30:00Z");
  const t=await loadDayTable(env.DB,range(),now);
  expect(t.behavior.alcohol[t.idx("2026-10-02")]).toBe(1);
  expect(t.behavior.alcohol[t.idx("2026-10-03")]).toBeNull();
});
it("deleted before-bed cigarette leaves the window absent", async () => {
  await event("first","cigarettes","2026-09-30T10:00:00Z");
  await event("active","mood_bien","2026-10-02T10:00:00Z");
  await event("late","cigarettes","2026-10-02T23:30:00Z");
  await sleep("s","2026-10-03");
  let t=await loadDayTable(env.DB,range(),now);
  expect(t.beforeBed.cigarettes[t.idx("2026-10-03")]).toBe(1);
  await env.DB.prepare("UPDATE event SET deleted_at=1 WHERE id='late'").run();
  t=await loadDayTable(env.DB,range(),now);
  expect(t.beforeBed.cigarettes[t.idx("2026-10-03")]).toBe(0);
});
it("nulls a window starting before tracking and a mood window without taps", async () => {
  await event("first","cigarettes","2026-10-02T23:30:00Z");
  await event("mood","mood_bien","2026-09-30T10:00:00Z");
  await sleep("s","2026-10-03");
  const t=await loadDayTable(env.DB,range(),now);
  expect(t.beforeBed.cigarettes[t.idx("2026-10-03")]).toBeNull();
  expect(t.beforeBed.mood_negative[t.idx("2026-10-03")]).toBeNull();
});
it("ignores naps, resolves ties like rollup, counts only inner AWAKE stages", async () => {
  await sleep("a","2026-10-03");
  await sleep("z","2026-10-03","2026-10-02T23:00:00Z");
  await sleep("nap","2026-10-03",undefined,900,undefined,1);
  const start=Date.parse("2026-10-02T23:00:00Z")/1000, end=Date.parse("2026-10-03T07:00:00Z")/1000;
  for (const [a,b,stage] of [[start,start+60,"AWAKE"],[start+60,start+120,"AWAKE"],[end-60,end,"AWAKE"],[start+120,start+180,"DEEP"]] as const)
    await env.DB.prepare("INSERT INTO sleep_stage VALUES (?,?,?,?)").bind("z",a,b,stage).run();
  const t=await loadDayTable(env.DB,range(),now);
  expect(t.metric.bedtime[t.idx("2026-10-03")]).toBe(420);
  expect(t.metric.awakenings[t.idx("2026-10-03")]).toBe(1);
  await sleep("no-stages","2026-10-04");
  expect((await loadDayTable(env.DB,range(),now)).metric.awakenings[t.idx("2026-10-04")]).toBeNull();
});
it("uses the stored offset for bedtime on the DST transition", async () => {
  await sleep("dst","2026-10-25","2026-10-24T23:00:00Z",480,"2026-10-25T07:00:00Z",0,60);
  const r=resolveRange({start:"2026-10-25",end:"2026-10-25"},now+7*86400,tz);
  const t=await loadDayTable(env.DB,r,now);
  expect(t.metric.bedtime[t.start]).toBe(360);
});
it("applies wear and zero-denominator gates", async () => {
  await summary("2026-10-02",599,30);
  await summary("2026-10-03",600);
  await sleep("zero","2026-10-03",undefined,480,undefined,0,120,0);
  const t=await loadDayTable(env.DB,range(),now);
  const a=t.idx("2026-10-02"),b=t.idx("2026-10-03");
  expect([t.metric.steps[a],t.metric.workout_min[a],t.behavior.workout[a]]).toEqual([null,null,1]);
  expect([t.metric.steps[b],t.metric.workout_min[b],t.behavior.workout[b]]).toEqual([5000,0,0]);
  expect(t.metric.deep_pct[b]).toBeNull();
  expect(t.metric.hrv[b]).toBe(4);
  expect(t.behavior.short_sleep[b]).toBe(1);
});
it.each([null,0,599,600])("requires confirmed wear for steps and workout absence: %s", async wear => {
  await summary("2026-10-02",wear);
  await summary("2026-10-03",wear,30);
  const t=await loadDayTable(env.DB,range(),now);
  const absent=t.idx("2026-10-02"),present=t.idx("2026-10-03");
  expect([t.metric.steps[absent],t.behavior.steps[absent],t.metric.workout_min[absent],t.behavior.workout[absent]])
    .toEqual(wear===600 ? [5000,5000,0,0] : [null,null,null,null]);
  expect([t.metric.steps[present],t.behavior.steps[present],t.metric.workout_min[present],t.behavior.workout[present]])
    .toEqual(wear===600 ? [5000,5000,30,1] : [null,null,null,1]);
});
it("uses workout ending times for late versus earlier-only windows", async () => {
  await sleep("s","2026-10-03");
  const insert=async(id:string,end:string)=> {
    const ts=Date.parse(end)/1000;
    await env.DB.prepare("INSERT INTO workout (source_id,type,start_ts,end_ts,tz_offset_min,local_date,duration_min,updated_at) VALUES (?,'run',?,?,120,'2026-10-02',30,1)").bind(id,ts-1800,ts).run();
  };
  await insert("early","2026-10-02T15:00:00Z");
  let t=await loadDayTable(env.DB,range(),now);
  expect(t.beforeBed.workout[t.idx("2026-10-03")]).toBe(0);
  await insert("late","2026-10-02T23:00:00Z");
  t=await loadDayTable(env.DB,range(),now);
  expect(t.beforeBed.workout[t.idx("2026-10-03")]).toBe(1);
  expect(t.beforeBed.workout[t.idx("2026-10-04")]).toBeNull();
});
it("sums only the last 24 hours and executes exactly one statement with three bindings", async () => {
  for (const [ts,tests] of [[now*1000-86400001,99],[now*1000-86400000,4],[now*1000,7]])
    await env.DB.prepare("INSERT INTO analysis_log VALUES (?,'scan',?)").bind(ts,tests).run();
  let prepares=0,executions=0;
  const db={prepare:(sql:string)=>{
    prepares++;
    return {bind:(...bindings:unknown[])=>{
      expect(bindings).toEqual([range().fetchStart,range().fetchEnd,now]);
      return {all:()=>{ executions++; return env.DB.prepare(sql).bind(...bindings).all(); }};
    }};
  }} as unknown as D1Database;
  const t=await loadDayTable(db,range(),now);
  expect(t.tests_last_24h).toBe(11);
  expect([prepares,executions]).toEqual([1,1]);
});
it("seeds a deterministic fixture with roughly 15 percent missing days and optional extension", async () => {
  await seedInsightsFixture(env.DB);
  const r={...resolveRange({start:FIXTURE.start,end:FIXTURE.end},FIXTURE.now,FIXTURE.tz),fetchEnd:FIXTURE.end};
  const first=await loadDayTable(env.DB,r,FIXTURE.now);
  const missing=first.metric.rhr.slice(first.start,first.end+1).filter(v=>v===null).length;
  expect(missing/180).toBeGreaterThan(0.08);
  expect(missing/180).toBeLessThan(0.22);
  await env.DB.batch(["sleep_stage","sleep_session","event","daily_summary","workout","metric_minute"].map(t=>env.DB.prepare(`DELETE FROM ${t}`)));
  await seedInsightsFixture(env.DB,{extendDays:3});
  expect(JSON.stringify(await loadDayTable(env.DB,r,FIXTURE.now))).toBe(JSON.stringify(first));
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_summary WHERE local_date > ?").bind(FIXTURE.end).first<{n:number}>();
  expect(count?.n).toBeGreaterThan(0);
},30000);
it.each(["main","common_cause"] as const)("keeps %s fixture timestamps before now, including extensions, with varying efficiency", async variant => {
  for (const extra of [0,3]) {
    await seedInsightsFixture(env.DB,{variant,extendDays:extra});
    const cutoff=FIXTURE.now+extra*86400;
    const latest=await env.DB.prepare(`SELECT MAX(
      (SELECT MAX(ts) FROM event), (SELECT MAX(created_at)/1000 FROM event),
      (SELECT MAX(end_ts) FROM sleep_session), (SELECT MAX(end_ts) FROM sleep_stage),
      (SELECT MAX(end_ts) FROM workout), (SELECT MAX(ts) FROM metric_minute)
    ) AS ts`).first<{ts:number}>();
    expect(latest?.ts).toBeLessThan(cutoff);
    const efficiencies=await env.DB.prepare("SELECT COUNT(DISTINCT efficiency) AS n FROM sleep_session").first<{n:number}>();
    expect(efficiencies?.n).toBeGreaterThan(100);
    const last=await env.DB.prepare("SELECT MAX(local_date) AS day FROM daily_summary").first<{day:string}>();
    expect(last !== null && last.day <= new Date(Date.parse(FIXTURE.end)+extra*86400000).toISOString().slice(0,10)).toBe(true);
    await env.DB.batch(["sleep_stage","sleep_session","event","daily_summary","workout","metric_minute"].map(t=>env.DB.prepare(`DELETE FROM ${t}`)));
  }
},30000);
it("preserves the planted day and night effects and a complete nine-day absence streak", async () => {
  await seedInsightsFixture(env.DB);
  const t=await loadDayTable(env.DB,resolveRange({start:FIXTURE.start,end:FIXTURE.end},FIXTURE.now,FIXTURE.tz),FIXTURE.now);
  const mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/x.length;
  const groups=(exposure:(i:number)=>number|null,outcome:(i:number)=>number|null)=>{
    const a:number[]=[],b:number[]=[];
    for(let i=t.start;i<=t.end;i++) {
      const x=exposure(i), y=outcome(i);
      if(x===null || y===null) continue;
      (x>0 ? a : b).push(y);
    }
    return mean(a)-mean(b);
  };
  const deep=groups(i=>t.beforeBed.cigarettes[i],i=>t.metric.deep_min[i]);
  expect(deep).toBeGreaterThan(-11.25);
  expect(deep).toBeLessThan(-6.75);
  const hrv=groups(i=>t.behavior.alcohol[i],i=>t.metric.hrv[i+1]);
  expect(100*Math.expm1(hrv)).toBeCloseTo(-12,0);
  const workout=groups(i=>t.behavior.workout[i],i=>t.metric.sleep_min[i+1]);
  expect(workout).toBeGreaterThan(22.5);
  expect(workout).toBeLessThan(37.5);
  expect(t.behavior.cigarettes.slice(t.end-8,t.end+1)).toEqual(Array<number>(9).fill(0));
  expect(t.behavior.cigarettes[t.end-9]).toBeGreaterThan(0);
  const streakRhr=mean(t.metric.rhr.slice(t.end-6,t.end+1).filter((x):x is number=>x!==null));
  const beforeRhr=mean(t.metric.rhr.slice(t.end-36,t.end-8).filter((x):x is number=>x!==null));
  expect(streakRhr-beforeRhr).toBeGreaterThan(-5);
  expect(streakRhr-beforeRhr).toBeLessThan(-3);
  for(let i=t.end-7;i<=t.end-5;i++) expect(t.moodTaps.mood_enfadado[i]).toBe(1);
  expect(groups(i=>t.metric.bedtime[i]===null || t.dates[i]>="2026-09-22" || FIXTURE.planted.illnessDays.includes(t.dates[i]) ? null : Number((t.metric.bedtime[i] ?? 0)>400),i=>t.metric.rhr[i])).toBeCloseTo(2,0);
  const b=computeBaselines(t);
  const flags=anomalyFlags(b,t.dates.length);
  for(const day of FIXTURE.planted.illnessDays) expect(flags[t.idx(day)]).toBe(true);
},30000);
it("plants the cigarette minute response on enough recent smoking days", async () => {
  await seedInsightsFixture(env.DB);
  const {results}=await env.DB.prepare(`
    SELECT e.local_date,
      AVG(CASE WHEN m.ts >= e.ts THEN m.value END) - AVG(CASE WHEN m.ts < e.ts THEN m.value END) AS delta
    FROM event e JOIN metric_minute m ON m.metric='hr' AND m.source='gh' AND m.ts>=e.ts-900 AND m.ts<e.ts+900
    WHERE e.tracker_id='cigarettes' AND e.ts>=unixepoch('2026-09-03') AND e.ts<unixepoch('2026-10-01')
      AND strftime('%H',e.ts+e.tz_offset_min*60,'unixepoch')='10'
    GROUP BY e.local_date
  `).all<{local_date:string;delta:number}>();
  expect(results.length).toBeGreaterThanOrEqual(10);
  for(const row of results) expect(row.delta).toBeCloseTo(8,0);
},30000);
it("keeps the common-cause variant free of a direct bedtime effect", async () => {
  await seedInsightsFixture(env.DB,{variant:"common_cause"});
  const t=await loadDayTable(env.DB,resolveRange({start:FIXTURE.start,end:FIXTURE.end},FIXTURE.now,FIXTURE.tz),FIXTURE.now);
  const late:number[]=[],early:number[]=[],alcohol:number[]=[],sober:number[]=[];
  for(let i=t.start+1;i<=t.end;i++) {
    const rhr=t.metric.rhr[i], bed=t.metric.bedtime[i], drink=t.behavior.alcohol[i-1];
    if(rhr===null || bed===null || drink===null || t.dates[i]>="2026-09-22" || FIXTURE.planted.illnessDays.includes(t.dates[i])) continue;
    (drink>0 ? alcohol : sober).push(rhr);
    if(drink===0) (bed>420 ? late : early).push(rhr);
  }
  const mean=(xs:number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
  expect(Math.min(late.length,early.length)).toBeGreaterThanOrEqual(8);
  expect(Math.abs(mean(late)-mean(early))).toBeLessThan(0.5);
  expect(mean(alcohol)-mean(sober)).toBeCloseTo(2.5,0);
},30000);

it("keeps behaviour-date boundary taps when bounding stored local dates", async () => {
  const r = range();
  const previous = new Date(Date.parse(r.fetchStart) - 86400000).toISOString().slice(0,10);
  const next = new Date(Date.parse(r.fetchEnd) + 86400000).toISOString().slice(0,10);
  await event("old-first","cigarettes","2020-01-01T12:00:00Z",true);
  for (const [id, at, offset] of [
    ["previous",previous+"T12:00:00Z",0],
    ["lower-early",r.fetchStart+"T04:59:59Z",0],
    ["lower-start",r.fetchStart+"T05:00:00Z",0],
    ["upper-early",next+"T04:59:59Z",0],
    ["upper-after",next+"T05:00:00Z",0],
    ["east",r.fetchEnd+"T14:59:59Z",840],
    ["west",next+"T16:59:59Z",-720],
  ] as const) await event(id,"cigarettes",at,false,offset);
  let query = "";
  const t = await loadDayTable({prepare:(sql:string)=>{
    query=sql;
    return env.DB.prepare(sql);
  }} as D1Database,r,now);
  const unbounded = query.replace("local_date BETWEEN date(?1, '-1 day') AND date(?2, '+1 day')\n    AND ", "");
  expect(unbounded).not.toBe(query);
  const bindings = [r.fetchStart,r.fetchEnd,now];
  expect((await env.DB.prepare(query).bind(...bindings).all()).results)
    .toEqual((await env.DB.prepare(unbounded).bind(...bindings).all()).results);
  expect(t.first.cigarettes?.bday).toBe("2020-01-01");
  expect(t.behavior.cigarettes[0]).toBe(1);
  expect(t.behavior.cigarettes[t.dates.length-1]).toBe(3);
});
