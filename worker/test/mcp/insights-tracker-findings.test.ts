import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createEvaluator } from "../../src/mcp/tools/insights/evaluator";
import { healthFindings, parseRowRef } from "../../src/mcp/tools/insights/findings";
import type { FamilyRow, StoredRef } from "../../src/mcp/tools/insights/types";

const trackers = [["water","ml",375], ["melatonin","mg",2.5], ["protein","g",22], ["creatine","g",3]] as const;
const nowSec = Date.parse("2026-10-22T10:00:00Z") / 1000;
const deps = { nowSec, tz: "Europe/Madrid" };
const range = { start: "2026-10-01", end: "2026-10-21" };
const finding = (body: Record<string, unknown>) => body.finding as { id: number; ref: StoredRef; result: FamilyRow };
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value");
  return value;
}
const date = (day: number) => `2026-10-${String(day).padStart(2,"0")}`;
const present = (day: number) => day >= 19 || day % 2 === 0;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const [id,unit,dose] of trackers)
    await env.DB.prepare("INSERT OR IGNORE INTO tracker (id,name,value_type,unit,default_value,created_at) VALUES (?,?,'amount',?,?,1)")
      .bind(id,id,unit,dose).run();
});
beforeEach(async () => {
  await env.DB.batch(["finding_check","finding","analysis_log","event","sleep_session","daily_summary"].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  for (let day = 0; day <= 22; day++) {
    const dayDate = day === 0 ? "2026-09-30" : date(day);
    const ts = Date.parse(dayDate+"T12:00:00Z") / 1000;
    const statements = [env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES (?,'caffeine',?,120,?,107,'import',1)")
      .bind(`active-${String(day)}`,ts,dayDate)];
    for (const [id,,dose] of trackers) if (day === 0 || present(day))
      statements.push(env.DB.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES (?,?,?,120,?,?,'import',1)")
        .bind(`${id}-${String(day)}`,id,ts,dayDate,dose));
    statements.push(env.DB.prepare("INSERT INTO daily_summary (local_date,rhr,computed_at) VALUES (?,?,1)")
      .bind(dayDate,60+(day%3)*0.2));
    statements.push(env.DB.prepare("INSERT INTO sleep_session (source_id,start_ts,end_ts,tz_offset_min,local_date,minutes_asleep,minutes_in_bed,deep_min,updated_at) VALUES (?,?,?,120,?,420,480,?,1)")
      .bind(`sleep-${String(day)}`,ts-12*3600,ts-5*3600,dayDate,60+(present(day-1) ? 10 : 0)));
    await env.DB.batch(statements);
  }
});

it.each(trackers)("evaluates %s contrasts/periods and saves/replays generated refs for all three tools", async (behavior) => {
  const evaluator = createEvaluator(env.DB,deps);
  const condition = (op: string) => ({ behavior,op,value:0 });
  const origins = [
    { tool:"health_scan",args:{...range,behaviors:[behavior],metrics:["deep_min"],timings:["following_night"]} },
    { tool:"health_contrast",args:{...range,a:{where:[condition(">")]},b:{where:[condition("=")]},metrics:["deep_min"],timing:"following_night"} },
    { tool:"health_periods",args:{...range,behaviors:[behavior],metrics:["deep_min"]} },
  ];
  for (const input of origins) {
    const origin = evaluator.validateOrigin(input);
    const family = await evaluator.family(origin,{});
    expect(family.rows).toHaveLength(1);
    const row = family.rows[0];
    expect(row.n_a).toBeGreaterThanOrEqual(3);
    expect(row.n_b).toBeGreaterThanOrEqual(3);
    expect(row.diff).toBeGreaterThan(8);
    expect(row.ref).not.toBeNull();
    expect(parseRowRef(row.ref,evaluator)).toEqual(row.ref);
    expect(await evaluator.single({ ...required(row.ref), mode:"historical",resolved:range },range)).toEqual(row);
    const saved = finding(await healthFindings(env.DB,{action:"save",statement:`${behavior} observation`,ref:row.ref},{nowMs:nowSec*1000,evaluator}));
    expect(saved.ref.mode).toBe(input.tool === "health_scan" ? "prospective" : "historical");
    expect(saved.result).toMatchObject({diff:row.diff,p:row.p,q:row.q});
    expect((await evaluator.family(saved.ref.origin,{range:saved.ref.resolved})).rows).toEqual(family.rows);
    const result = await healthFindings(env.DB,{action:"recheck",id:saved.id},{nowMs:nowSec*1000+1,evaluator});
    if (saved.ref.mode === "historical") expect(result).toMatchObject({verdict:"reproduced",diff_new:row.diff});
    else expect(result.verdict).toBe("not_enough_data");
    const stored = await env.DB.prepare("SELECT result FROM finding_check WHERE finding_id=?").bind(saved.id).first<{result:string}>();
    expect(stored).not.toBeNull();
    if (saved.ref.mode === "historical") expect(JSON.parse(required(stored).result)).toEqual(row);
  }
});

it.each(trackers)("rechecks %s scan and contrast findings against new days using the real evaluator", async (behavior) => {
  const savedSec = Date.parse("2026-10-12T10:00:00Z")/1000;
  const evaluator = createEvaluator(env.DB,{...deps,nowSec:savedSec});
  const freshEvaluator = createEvaluator(env.DB,deps);
  for (const tool of ["health_scan","health_contrast"] as const) {
    const args = tool === "health_scan" ? {window_days:10,behaviors:[behavior],metrics:["deep_min"],timings:["following_night"]}
      : {window_days:10,a:{where:[{behavior,op:">",value:0}]},b:{where:[{behavior,op:"=",value:0}]},metrics:["deep_min"],timing:"following_night"};
    const origin = evaluator.validateOrigin({tool,args});
    const row = (await evaluator.family(origin,{})).rows[0];
    const saved = finding(await healthFindings(env.DB,{action:"save",statement:behavior,ref:row.ref},{nowMs:savedSec*1000,evaluator}));
    expect(saved.ref.mode).toBe("prospective");
    const newRange = required(freshEvaluator.newDataRange(savedSec*1000));
    expect(newRange).toEqual({start:"2026-10-13",end:"2026-10-21"});
    const expected = await freshEvaluator.single(saved.ref,newRange);
    expect(expected).toMatchObject({n_a:6,n_b:3});
    const result = await healthFindings(env.DB,{action:"recheck",id:saved.id},{nowMs:nowSec*1000,evaluator:freshEvaluator});
    expect(result.diff_new).toBe(required(expected).diff);
    const stored = await env.DB.prepare("SELECT result FROM finding_check WHERE finding_id=?").bind(saved.id).first<{result:string}>();
    expect(JSON.parse(required(stored).result)).toEqual(expected);
  }
});
