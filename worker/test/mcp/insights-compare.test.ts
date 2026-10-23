import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it, vi } from "vitest";
import { acuteDraft, analysisLogStatement, behaviorDraft, consistentBlocks, finalizeFamily, publicRow, rankRows, shapeResponse, tertiles } from "../../src/mcp/tools/insights/compare";
import type { RowDraft } from "../../src/mcp/tools/insights/compare";
import { BEFORE_BED_HOURS, CALIBRATION_CAPS, METRICS, PHRASES } from "../../src/mcp/tools/insights/catalog";
import type { BehaviorId, MetricId, Origin } from "../../src/mcp/tools/insights/types";
import type { DayTable } from "../../src/mcp/tools/insights/units";
import { anomalyFlags, computeBaselines } from "../../src/mcp/tools/insights/baseline";
import { loadDayTable, resolveRange } from "../../src/mcp/tools/insights/units";
import { acuteDays } from "../../src/mcp/tools/insights/event";
import type { AcuteInput } from "../../src/mcp/tools/insights/event";
import { FIXTURE, candidateTimes, seedInsightsFixture } from "../fixtures/insights";

const acuteExcluded = {overlap:0,workout:0,sleep:0,coverage:0,dst:0,no_control:0,future:0};
const origin: Origin = { tool: "health_scan", args: { window_days: 120 } };
function table(n = 114): DayTable {
  const dates = Array.from({length:n}, (_,i)=>new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10));
  return {
    dates, idx: d=>dates.indexOf(d), start:0, end:n-2, weekend:dates.map(()=>false),
    behavior:Object.fromEntries(["cigarettes","caffeine","alcohol","mood_negative","mood_tired","workout","steps","short_sleep","water","melatonin","protein","creatine"].map(b=>[b,dates.map((_,i)=>i%2)])) as DayTable["behavior"],
    beforeBed:Object.fromEntries(Object.keys(BEFORE_BED_HOURS).map(b=>[b,dates.map((_,i)=>i%2)])) as DayTable["beforeBed"],
    metric:Object.fromEntries(Object.keys(METRICS).filter(m=>m!=="hr_delta").map(m=>[m,dates.map((_,i)=>100+i)])) as DayTable["metric"],
    moodTaps:{} as DayTable["moodTaps"], first:{cigarettes:null,caffeine:null,alcohol:null,water:null,melatonin:null,protein:null,creatine:null,mood:null}, tests_last_24h:0,
  };
}
function draft(p: number | null = 0.02): RowDraft {
  return {key:{kind:"behavior",behavior:"cigarettes",timing:"following_night",metric:"deep_min"},
    stats:{n_a:20,n_b:20,mean_a:30,mean_b:20,diff:10,ci95:[6,14],p,df:20,phi:0.2,n_eff_a:12,n_eff_b:12},
    rope:5,binary:false,low_confidence:false,groupIdx:{a:[],b:[]},outcome:[]};
}
const make = (t:DayTable, behavior:BehaviorId="cigarettes", timing:"following_night"|"before_bed"|"same_day"|"next_day"="following_night", metric:MetricId="deep_min") => behaviorDraft(t,[],{behavior,timing,metric},{includeAnomalies:false});

it("tertile ties go to the middle group",()=>{
  expect(tertiles([9,0,3,3,3,6,9])).toEqual({lo:3,hi:6});
  const t=table(8); t.behavior.steps=[0,3,3,3,6,9,9,null];
  const {draft:d,excluded}=make(t,"steps");
  expect(d.groupIdx).toEqual({a:[5,6],b:[0]}); expect(excluded.middle_band).toBe(4);
});
it("frozen cutpoints are used unchanged",()=>{
  const t=table(8), cutpoints={lo:2,hi:4}; t.behavior.steps=[0,1,2,3,4,5,6,null];
  const {draft:d}=behaviorDraft(t,[],{behavior:"steps",timing:"following_night",metric:"deep_min"},{includeAnomalies:false,cutpoints});
  expect(d.groupIdx).toEqual({a:[5,6],b:[0,1]}); expect(cutpoints).toEqual({lo:2,hi:4});
});
it("following_night pairs D with the night waking on D+1 across a missing day",()=>{
  const t=table(9); t.metric.deep_min[2]=null;
  const {draft:d,excluded}=make(t);
  expect(d.outcome[1]).toBeNull(); expect(d.outcome[2]).toBe(103); expect(d.outcome[7]).toBe(108);
  expect(excluded.outcome_missing).toBe(1);
});
it("before_bed rows use the night's window and its wake-date recovery",()=>{
  const t=table(9); t.behavior.cigarettes.fill(null); t.beforeBed.cigarettes=[null,1,0,1,0,1,0,1,0];
  const {draft:d}=make(t,"cigarettes","before_bed","hrv");
  expect(d.groupIdx).toEqual({a:[0,2,4,6],b:[1,3,5,7]}); expect(d.outcome[0]).toBe(101);
});
it("same_day only pairs mood",()=>{
  const t=table(); t.metric.mood_positive=t.dates.map((_,i)=>i%2);
  expect(make(t,"cigarettes","same_day","mood_positive").draft.outcome[1]).toBe(1);
  expect(()=>make(t,"cigarettes","same_day","deep_min")).toThrow(RangeError);
  expect(()=>make(t,"short_sleep")).toThrow(RangeError);
});
it("no row with a group under 3 has a numeric diff",()=>{
  const t=table(5); const r=finalizeFamily([make(t).draft],t,origin).rows[0];
  for (const field of ["mean_a","mean_b","diff","ci95","p","q"] as const) expect(r[field]).toBeNull();
  expect(r.label).toBe("sin_datos");
});
it("anomalous exposure and outcome dates are dropped and counted",()=>{
  const t=table(12), flags=t.dates.map((_,i)=>i===3);
  const key={behavior:"cigarettes" as const,timing:"following_night" as const,metric:"deep_min" as const};
  const result=behaviorDraft(t,flags,key,{includeAnomalies:false});
  expect(result.excluded.anomaly).toBe(2); expect(result.draft.groupIdx.a).not.toContain(3); expect(result.draft.groupIdx.b).not.toContain(2);
  expect(behaviorDraft(t,flags,key,{includeAnomalies:true}).excluded.anomaly).toBe(0);
});
it("counts unknown exposures and overlapping explicit groups",()=>{
  const t=table(10); t.behavior.cigarettes[0]=null;
  const groups={a:t.dates.map(()=>true),b:t.dates.map((_,i)=>i===1)};
  const result=behaviorDraft(t,[],{behavior:"cigarettes",timing:"next_day",metric:"steps"},{includeAnomalies:false,groups});
  expect(result.excluded.exposure_unknown).toBe(1); expect(result.excluded.both_groups).toBe(1); expect(result.draft.groupIdx.a).toEqual([2,3,4,5,6,7,8]);
});
it("BH over non-null p only; tests counts every draft",()=>{
  const r=finalizeFamily([draft(0.02),draft(0.8),draft(null)],table(),origin);
  expect(r.tests).toBe(3); expect(r.rows.map(r=>r.q)).toEqual([0.04,0.8,null]);
});
it("a p 0.02 row in a 30-test family can be indicio after BH",()=>{
  const r=finalizeFamily([draft(),...Array.from({length:29},()=>draft(0.9))],table(),origin).rows[0];
  expect(r.q).toBe(0.6); expect(r.label).toBe("indicio");
});
it("needed text for 4 missing before-bed cigarette nights",()=>{
  const d=draft(); d.key.timing="before_bed"; d.stats.n_a=4;
  expect(finalizeFamily([d],table(),origin).rows[0].needed).toBe("faltan 4 noches con cigarro antes de dormir");
  d.stats.n_a=10; d.stats.n_b=4;
  expect(finalizeFamily([d],table(),origin).rows[0].needed).toBe("faltan 4 noches sin cigarro antes de dormir");
  d.stats.n_a=2;
  expect(finalizeFamily([d],table(),origin).rows[0].needed).toBe("faltan 1 noches con cigarro antes de dormir");
});
it("reports missing effective days",()=>{
  const d=draft(); d.stats.ci95=null; d.stats.n_eff_a=1.2;
  expect(finalizeFamily([d],table(),origin).rows[0].needed).toBe("más días repartidos en el tiempo (faltan 1 días efectivos)");
});
it("consistent_blocks counts only whole blocks with at least 3 days per group",()=>{
  const t=table(114),d=draft(); d.groupIdx={a:[],b:[]}; d.outcome=t.dates.map(()=>null);
  for(let i=1;i<=112;i++) { if(i<29 && i%2===0) continue; const a=i%2===1; d.groupIdx[a?"a":"b"].push(i); d.outcome[i]=a?30:20; }
  expect(consistentBlocks(t,d)).toEqual({same:3,of:3});
  t.start=86; expect(consistentBlocks(t,d)).toBeNull();
});
it("acute gate binds on event days",()=>{
  const d=acuteDraft({tracker:"cigarettes",dates:table(7).dates,d:Array<number>(7).fill(8),eventDays:7,events:10,controls:50,excluded:acuteExcluded});
  const r=finalizeFamily([d],table(),origin).rows[0];
  expect(r).toMatchObject({n_a:7,n_b:50,label:"indicio",reason:"few_days",diff:8});
});
it("binary and acute caps change emitted labels",()=>{
  for(const kind of ["binary","acute"] as const) {
    const d=draft(0); d.binary=kind==="binary"; if(kind==="acute") d.key.kind="acute";
    expect(finalizeFamily([d],table(),origin).rows[0].label).toBe("probable");
    expect(finalizeFamily([d],table(),origin,undefined,{...CALIBRATION_CAPS,[kind]:true}).rows[0]).toMatchObject({label:"indicio",reason:"uncertain"});
  }
});
it("uses metric label callbacks after BH and preserves extra fields",()=>{
  const d=draft(); d.key={kind:"metric",exposure:{metric:"bedtime",side:"high"},timing:"that_night",metric:"hrv"};
  d.labelWith=q=>({label:q===0.04?"indicio":"probable",reason:"not_robust",needed:null,matches_expected:true});
  d.extra={adjusted_for:["weekend"],planned_id:"M1"};
  const r=finalizeFamily([d,draft(0.8)],table(),origin).rows[0];
  expect(r).toMatchObject({label:"indicio",reason:"not_robust",adjusted_for:["weekend"],matches_expected:true});
  expect(r.pct).toBeCloseTo(100*(Math.exp(10)-1),2); expect(r.phrase).toBe(PHRASES.indicio);
});
it("ranking follows label, relative magnitude, then metric id and strips internal fields",()=>{
  const rows=finalizeFamily([draft(),draft(),draft(),draft()],table(),origin).rows;
  rows[0].label="sin_datos"; rows[1].metric="rhr"; rows[2].metric="hrv"; rows[3].diff=20;
  expect(rankRows(rows)).toEqual([rows[3],rows[2],rows[1],rows[0]]);
  expect(publicRow(rows[0])).not.toHaveProperty("rope"); expect(publicRow(rows[0])).not.toHaveProperty("kind"); expect(publicRow(rows[0])).not.toHaveProperty("binary");
});
it("shapeResponse truncates deterministically with long refs and preserves q and tests",()=>{
  const longOrigin:Origin={tool:"health_contrast",args:{window_days:180,timing:"following_night",a:{where:Array.from({length:10},()=>({behavior:"cigarettes",op:">",value:2}))},b:{where:Array.from({length:10},()=>({behavior:"cigarettes",op:"=",value:0}))}}};
  const rows=finalizeFamily(Array.from({length:40},()=>draft()),table(),longOrigin).rows.map(publicRow);
  const body={rows,anomalies:[{date:"2026-01-01"}]}, envelope={range:null,excluded:{},tests:40,tests_last_24h:50};
  const r=shapeResponse(body,["rows","anomalies"],envelope);
  expect(r.truncated).toBe(true); expect(JSON.stringify(r).length).toBeLessThanOrEqual(20000);
  expect(r.rows.length).toBeGreaterThan(0); expect(r.rows.every(row=>row.q===0.02)).toBe(true); expect(r.tests).toBe(40);
  expect(shapeResponse(body,["rows","anomalies"],envelope)).toEqual(r); expect(body.rows).toHaveLength(40); expect(r.anomalies).toHaveLength(1);
});
beforeAll(async()=>{
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS analysis_log (ts INTEGER NOT NULL, tool TEXT NOT NULL, tests INTEGER NOT NULL)").run();
});
it("analysisLogStatement inserts one row in ms",async()=>{
  await env.DB.prepare("DELETE FROM analysis_log").run();
  await analysisLogStatement(env.DB,"health_scan",30,1234567890000).run();
  expect(await env.DB.prepare("SELECT * FROM analysis_log").all()).toMatchObject({results:[{ts:1234567890000,tool:"health_scan",tests:30}]});
});
it("finds the planted before-bed deep sleep difference with anomaly exclusion",async()=>{
  await seedInsightsFixture(env.DB);
  const t=await loadDayTable(env.DB,resolveRange({start:FIXTURE.start,end:FIXTURE.end},FIXTURE.now,FIXTURE.tz),FIXTURE.now);
  const flags=anomalyFlags(computeBaselines(t),t.dates.length);
  const {draft:d}=behaviorDraft(t,flags,{behavior:"cigarettes",timing:"before_bed",metric:"deep_min"},{includeAnomalies:false});
  expect(d.stats.diff).toBeCloseTo(-9,0); expect(finalizeFamily([d],t,origin).rows[0].label).toBe("probable");
});
it("returns null statistics for empty inputs and keeps the envelope on empty lists",()=>{
  const t=table(10); t.behavior.cigarettes.fill(null);
  const result=make(t);
  expect(result.excluded.exposure_unknown).toBe(9);
  const row=finalizeFamily([result.draft],t,origin).rows[0];
  expect(row).toMatchObject({label:"sin_datos",diff:null,p:null,q:null,pct:null});
  expect(finalizeFamily([],t,origin)).toEqual({rows:[],tests:0});
  expect(shapeResponse({rows:[]},["rows"],{range:null,excluded:{},tests:0,tests_last_24h:null})).toEqual({rows:[],range:null,excluded:{},tests:0,tests_last_24h:null,truncated:false});
});
it("freezes displayed-range cutpoints in step refs and ignores padding values",()=>{
  const t=table(10); t.start=2; t.end=7; t.behavior.steps=[-100,-100,0,1,2,3,4,5,100,100];
  const d=make(t,"steps").draft;
  expect(finalizeFamily([d],t,origin).rows[0].ref?.cutpoints).toEqual(tertiles([0,1,2,3,4,5]));
  const cuts={lo:0.5,hi:3.5};
  expect(finalizeFamily([d],t,origin,cuts).rows[0].ref?.cutpoints).toEqual(cuts);
  expect(finalizeFamily([draft()],t,origin,cuts).rows[0].ref).not.toHaveProperty("cutpoints");
});
it("emits the HRV exponential percentage and null percentages for zero references",()=>{
  const d=draft(0); d.key.metric="hrv"; d.stats.diff=Math.log(0.88);
  expect(finalizeFamily([d],table(),origin).rows[0].pct).toBe(-12);
  d.key.metric="deep_min"; d.stats.mean_b=0;
  expect(finalizeFamily([d],table(),origin).rows[0].pct).toBeNull();
  d.stats.mean_b=null;
  expect(finalizeFamily([d],table(),origin).rows[0].pct).toBeNull();
});
it("rounds output after label decisions",()=>{
  const d=draft(0.10001); d.stats.diff=5.00049; d.stats.ci95=[0.00001,10.12345]; d.stats.mean_a=25.12345;
  const row=finalizeFamily([d],table(),origin).rows[0];
  expect(row).toMatchObject({label:"indicio",reason:"uncertain",q:0.1,p:0.1,diff:5,ci95:[0,10.123],mean_a:25.123});
});
it("counts blocks with opposite or too-small differences without marking them consistent",()=>{
  const t=table(57), d=draft(); d.outcome=t.dates.map((_,i)=>i<28 ? i%2 ? 20:30 : i%2 ? 21:20);
  d.groupIdx={a:[],b:[]};
  for(let i=0;i<=t.end;i++) d.groupIdx[i%2?"a":"b"].push(i);
  expect(consistentBlocks(t,d)).toEqual({same:0,of:2});
});
it("acute small-sample gates use retained days even with many event windows",()=>{
  const d=acuteDraft({tracker:"cigarettes",dates:table(3).dates,d:[8,null,8],eventDays:2,events:40,controls:50,excluded:acuteExcluded});
  expect(finalizeFamily([d],table(),origin).rows[0]).toMatchObject({n_a:2,n_b:50,label:"sin_datos",mean_a:null,mean_b:null,diff:null,ci95:null,p:null,q:null});
});
it("trims lists in the supplied order",()=>{
  const result=shapeResponse({rows:["x".repeat(20000)],changes:[1,2]},["rows","changes"],{range:null,excluded:{},tests:1,tests_last_24h:1});
  expect(result.rows).toEqual([]); expect(result.changes).toEqual([1,2]); expect(result.truncated).toBe(true);
});

it("pairs dense calendar indices without date conversions or index lookups",()=>{
  const t=table(182);
  const parse=vi.spyOn(Date,"parse"), iso=vi.spyOn(Date.prototype,"toISOString"), idx=vi.spyOn(t,"idx");
  try {
    for (const timing of ["following_night","before_bed","next_day","same_day"] as const) {
      const d=make(t,"cigarettes",timing,timing==="same_day" ? "mood_positive" : timing==="next_day" ? "steps" : "hrv").draft;
      expect(d.outcome[180]).toBe(timing==="same_day" ? 280 : 281);
    }
    expect(parse).not.toHaveBeenCalled(); expect(iso).not.toHaveBeenCalled(); expect(idx).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
it("expands sparse acuteDays output into calendar gaps before inference",()=>{
  const start=Date.parse("2026-09-01T00:00:00Z")/1000;
  const taps=Array.from({length:14},(_,i)=>({tracker:"cigarettes" as const,ts:start+i*2*86400+12*3600,tz_offset_min:0}));
  const effects=new Map(taps.map((tap,i)=>[tap.ts,i<7 ? 1 : 7]));
  const input:AcuteInput={taps,sleeps:[],workouts:[],nowSec:start+29*86400,
    windows:new Map(candidateTimes(taps).map(ts=>[ts,{tz_offset_min:0,base_mean:60,base_n:15,
      resp:{cigarettes:{mean:60+(effects.get(ts) ?? 0),n:15},caffeine:{mean:60,n:90},alcohol:{mean:60,n:60}}}]))};
  const acute=acuteDays(input,{start:"2026-09-01",end:"2026-09-28"})[0];
  expect(acute.dates).toHaveLength(14); expect(acute.dates[1]).toBe("2026-09-03");
  expect(acute.d).toEqual([...Array<number>(7).fill(1),...Array<number>(7).fill(7)]);
  const d=acuteDraft(acute);
  expect(d.stats).toMatchObject({n_a:14,n_b:14,diff:4,phi:0.2});
  expect(d.stats.ci95?.[0]).toBeCloseTo(1.650,3); expect(d.stats.ci95?.[1]).toBeCloseTo(6.350,3);
  expect(d.stats.p).toBeCloseTo(0.0044,4);
  expect(finalizeFamily([d],table(),origin).rows[0]).toMatchObject({label:"probable",p:0.0044});
});
it("carries acute exclusion counts on the draft for envelope aggregation",()=>{
  const start=Date.parse("2026-09-01T12:00:00Z")/1000;
  const input:AcuteInput={taps:[{tracker:"cigarettes",ts:start,tz_offset_min:0}],sleeps:[],workouts:[],nowSec:start+86400,
    windows:new Map([[start,{tz_offset_min:0,base_mean:60,base_n:15,
      resp:{cigarettes:{mean:68,n:15},caffeine:{mean:60,n:90},alcohol:{mean:60,n:60}}}]])};
  const acute=acuteDays(input,{start:"2026-09-01",end:"2026-09-01"})[0];
  expect(acute.excluded.no_control).toBe(1); expect(acute.excluded.coverage).toBeGreaterThan(0);
  expect(acuteDraft(acute)).toHaveProperty("excluded",acute.excluded);
});
it.each(["a","b"] as const)("keeps metric matches_expected null when group %s has fewer than three days",group=>{
  const d=draft(); d.key={kind:"metric",exposure:{metric:"bedtime",side:"high"},timing:"that_night",metric:"hrv"};
  d.stats[group==="a" ? "n_a" : "n_b"]=2;
  d.labelWith=()=>({label:"sin_datos",reason:null,needed:null,matches_expected:null});
  const row=finalizeFamily([d],table(),origin).rows[0];
  expect(row).toHaveProperty("matches_expected",null);
  expect(JSON.parse(JSON.stringify(publicRow(row)))).toHaveProperty("matches_expected",null);
});
it("describes missing step days by top and bottom tertile",()=>{
  const d=draft(); d.key.behavior="steps"; d.stats.n_a=4;
  expect(finalizeFamily([d],table(),origin).rows[0].needed).toBe("faltan 4 noches en el tercil superior de pasos");
  d.stats.n_a=10; d.stats.n_b=4;
  expect(finalizeFamily([d],table(),origin).rows[0].needed).toBe("faltan 4 noches en el tercil inferior de pasos");
  d.key.timing="next_day"; d.stats.n_b=2;
  expect(finalizeFamily([d],table(),origin).rows[0].needed).toBe("faltan 1 días en el tercil inferior de pasos");
});

it("keeps empty acuteDays output as a sin_datos row",()=>{
  const input:AcuteInput={taps:[],sleeps:[],workouts:[],windows:new Map(),nowSec:Date.parse("2026-09-29T00:00:00Z")/1000};
  const acute=acuteDays(input,{start:"2026-09-01",end:"2026-09-28"})[0];
  const d=acuteDraft(acute);
  expect(d.stats).toMatchObject({n_a:0,n_b:0,diff:null,p:null,ci95:null});
  expect(finalizeFamily([d],table(),origin).rows[0]).toMatchObject({label:"sin_datos",n_a:0,n_b:0,diff:null});
});
