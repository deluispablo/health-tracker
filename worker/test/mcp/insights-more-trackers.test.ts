import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { validateContrastArgs } from "../../src/mcp/tools/insights/contrast";
import { validatePeriodsArgs } from "../../src/mcp/tools/insights/periods";
import { computeScan, validateScanArgs } from "../../src/mcp/tools/insights/scan";
import { loadDayTable, resolveRange } from "../../src/mcp/tools/insights/units";
import { FIXTURE, seedInsightsFixture } from "../fixtures/insights";

beforeAll(async () => { await applyD1Migrations(env.DB,env.TEST_MIGRATIONS); });

it("accepts water and supplements as scan behaviours", () => {
  const behaviors=["water","melatonin","protein","creatine"];
  expect(validateScanArgs({behaviors},FIXTURE.now,FIXTURE.tz).origin.args.behaviors).toEqual(behaviors);
});
it.each(["water", "melatonin", "protein", "creatine"])("accepts %s in contrast", behavior => {
  const a={where:[{behavior,op:">",value:0}]};
  expect(validateContrastArgs({a,b:{},metrics:["rhr"]},FIXTURE.now,FIXTURE.tz).args.a).toEqual(a);
  const beforeBed={a:{where:[{behavior,op:">",value:0,timing:"before_bed"}]},b:{},timing:"before_bed",metrics:["rhr"]};
  if (behavior==="melatonin") expect(() => validateContrastArgs(beforeBed,FIXTURE.now,FIXTURE.tz)).not.toThrow();
  else expect(() => validateContrastArgs(beforeBed,FIXTURE.now,FIXTURE.tz)).toThrow(/supported window behavior/);
});
it.each(["water", "melatonin", "protein", "creatine"])("accepts %s in periods", behavior => {
  expect(validatePeriodsArgs({behaviors:[behavior]},{nowSec:FIXTURE.now,tz:FIXTURE.tz}).behaviors).toEqual([behavior]);
});
it("preserves old raw scan statistics when the expanded family has observations", async () => {
  await seedInsightsFixture(env.DB);
  const opts={nowSec:FIXTURE.now,tz:FIXTURE.tz};
  const args={start:FIXTURE.start,end:FIXTURE.end};
  const t=await loadDayTable(env.DB,resolveRange(args,opts.nowSec,opts.tz),opts.nowSec);
  for (const [j,id] of (["water","melatonin","protein","creatine"] as const).entries())
    t.behavior[id]=t.dates.map((_,i)=>(i*13+j*7)%17<8 ? 2.5 : 0);
  t.beforeBed.melatonin=t.dates.map((_,i)=>i%3===0 ? 1 : 0);
  const all=computeScan(t,null,validateScanArgs(args,opts.nowSec,opts.tz).origin,opts);
  const behaviors=["cigarettes","caffeine","alcohol","mood_negative","mood_tired","workout","steps","short_sleep"];
  const existing=computeScan(t,null,validateScanArgs({...args,behaviors},opts.nowSec,opts.tz).origin,opts);
  const rows=all.rows.filter(row=>!row.behavior || behaviors.includes(row.behavior));
  expect(all.tests).toBe(376);
  expect(existing.tests).toBe(264);
  expect(rows).toHaveLength(existing.rows.length);
  const raw = (row: typeof rows[number]) => ({key:row.ref?.key,n_a:row.n_a,n_b:row.n_b,
    mean_a:row.mean_a,mean_b:row.mean_b,diff:row.diff,ci95:row.ci95,pct:row.pct,p:row.p,
    consistent_blocks:row.consistent_blocks,sensitivity:row.sensitivity,adjusted_for:row.adjusted_for});
  expect(rows.map(raw)).toEqual(existing.rows.map(raw));
  expect(all.rows.filter(row=>row.behavior && !behaviors.includes(row.behavior) && row.p!==null).length).toBeGreaterThan(0);
},30000);
