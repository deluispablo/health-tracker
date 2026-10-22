import type { BehaviorId, BehaviorTiming, MetricId } from "../../src/mcp/tools/insights/types";

export const FIXTURE: {
  now: number; tz: "Europe/Madrid"; start: string; end: string; seed: 20261022;
  planted: { acuteBpm: number; deepFraction: number; streakDays: number; streakRhr: number; hrvFraction: number; workoutSleepMin: number; illnessDays: readonly string[]; bedtimeRhr: number };
  nullPairs: readonly { behavior: BehaviorId; timing: BehaviorTiming; metric: MetricId }[];
} = {
  now: Date.parse("2026-10-01T08:00:00Z")/1000, tz: "Europe/Madrid", start: "2026-04-04", end: "2026-09-30", seed: 20261022,
  planted: { acuteBpm:8, deepFraction:-0.10, streakDays:9, streakRhr:-4, hrvFraction:-0.12, workoutSleepMin:30,
    illnessDays:["2026-08-10","2026-08-11","2026-08-12"], bedtimeRhr:2 },
  nullPairs: [
    {behavior:"caffeine",timing:"following_night",metric:"sleep_min"},
    {behavior:"caffeine",timing:"next_day",metric:"steps"},
    {behavior:"mood_tired",timing:"following_night",metric:"efficiency"},
    {behavior:"alcohol",timing:"following_night",metric:"rem_min"},
    {behavior:"caffeine",timing:"before_bed",metric:"rem_min"},
  ],
};
function mulberry32(seed:number):()=>number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15,1 | seed);
    t = t + Math.imul(t ^ t >>> 7,61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0)/4294967296;
  };
}
const dayAt=(i:number)=>new Date(Date.parse(FIXTURE.start+"T00:00:00Z")+i*86400000).toISOString().slice(0,10);
function offsetAt(ts:number):number {
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:FIXTURE.tz,timeZoneName:"shortOffset"}).formatToParts(new Date(ts*1000));
  const match=/GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(parts.find(p=>p.type==="timeZoneName")?.value ?? "");
  return match ? (match[1]==="-" ? -1 : 1)*(Number(match[2])*60+Number(match[3] || 0)) : 0;
}
function localTime(day:string,minute:number):number {
  const nominal=Date.parse(day+"T00:00:00Z")/1000+minute*60;
  return nominal-offsetAt(nominal)*60;
}
export async function seedInsightsFixture(db:D1Database,opts: {variant?:"main"|"common_cause";extendDays?:number} = {}):Promise<void> {
  const extra=opts.extendDays ?? 0;
  if (!Number.isInteger(extra) || extra<0) throw new RangeError("extendDays must be a nonnegative integer.");
  const random=mulberry32(FIXTURE.seed);
  const efficiencyRandom=mulberry32(FIXTURE.seed+1);
  const cutoff=localTime(dayAt(180+extra),600);
  const noise=(width:number)=>(random()-0.5)*width*2;
  // The extra fetch day supplies only sleep completed before the advanced local 10:00 now.
  const days=Array.from({length:181+extra},(_,i)=>{
    const smoking=random()<0.55;
    const lateCig=random()<0.5;
    const caffeine=random()<0.5;
    const lateCaffeine=random()<0.5;
    const alcohol=random()<0.4;
    const workout=random()<0.5;
    const lateWorkout=random()<0.5;
    // Keep the usual bedtime dominant so rolling medians stay in the same cluster.
    const late=random()<0.3;
    const tired=random()<0.3;
    const negative=random()<0.3;
    const missing=random()<0.15;
    return {smoking:i>=171 && i<180 ? false : i>=152 && i<171 ? true : smoking,
      lateCig,caffeine,lateCaffeine,alcohol,workout,lateWorkout,late,tired,negative,
      missing:i>=170 && i<180 || FIXTURE.planted.illnessDays.includes(dayAt(i)) ? false : missing,
      sleepNoise:noise(8),deepNoise:noise(1.5),remNoise:noise(5),rhrNoise:noise(0.35),
      hrvNoise:noise(0.025),steps:Math.round(7000+noise(3500)),bedNoise:noise(15),efficiency:93+(efficiencyRandom()-0.5)*6};
  });
  const insertEvent=(id:string,tracker:string,ts:number,value=1)=>{
    const offset=offsetAt(ts);
    const date=new Date((ts+offset*60)*1000).toISOString().slice(0,10);
    return db.prepare("INSERT INTO event (id,tracker_id,ts,tz_offset_min,local_date,value,origin,created_at) VALUES (?,?,?,?,?,?,'import',?)")
      .bind(id,tracker,ts,offset,date,value,ts*1000);
  };
  await db.batch(["cigarettes","caffeine","alcohol","mood_bien"].map(id=>insertEvent("start-"+id,id,localTime(dayAt(-1),720))));
  let previousLateTs:number|null=null;
  for (let i=0;i<days.length;i++) {
    const d=days[i], day=dayAt(i), previous=i>0 ? days[i-1] : null;
    if (d.missing) continue;
    const illness=FIXTURE.planted.illnessDays.includes(day);
    const late=d.late;
    const alcoholDelay=opts.variant==="common_cause" && previous?.alcohol ? 90 : 0;
    const bedtimeMinute=1440+30+(late ? 80 : -50)+alcoholDelay+Math.round(d.bedNoise);
    const bed=localTime(dayAt(i-1),bedtimeMinute);
    const sleepMin=Math.round(420+d.sleepNoise+(previous?.workout ? 30 : 0));
    const end=bed+(sleepMin+30)*60;
    const deep=90+d.deepNoise-(previous?.smoking && previous.lateCig ? 9 : 0);
    const rem=95+d.remNoise;
    const rhr=62+d.rhrNoise+(opts.variant==="common_cause" ? previous?.alcohol ? 2.5 : 0 : late ? 2 : 0)
      +(i>=173 && i<180 ? -4 : 0)+(illness ? 12 : 0);
    const hrv=Math.log(45)+d.hrvNoise+(previous?.alcohol ? Math.log(0.88) : 0);
    const offset=offsetAt(end);
    const statements:D1PreparedStatement[]=[];
    if (end<cutoff) {
      statements.push(db.prepare("INSERT INTO sleep_session (source_id,start_ts,end_ts,tz_offset_min,local_date,minutes_asleep,minutes_in_bed,efficiency,deep_min,rem_min,light_min,awake_min,latency_min,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,20,10,1)")
        .bind("sleep-"+day,bed,end,offset,day,sleepMin,sleepMin+30,d.efficiency,Math.round(deep),Math.round(rem),Math.round(sleepMin-deep-rem)));
      statements.push(db.prepare("INSERT INTO sleep_stage (session_id,start_ts,end_ts,stage) VALUES (?,?,?,'AWAKE')")
        .bind("sleep-"+day,bed+7200,bed+7320));
    }
    if (i===180+extra) {
      if (statements.length) await db.batch(statements);
      continue;
    }
    const mood=i>=172 && i<=174 ? "mood_enfadado" : d.negative ? "mood_estresado" : "mood_bien";
    statements.push(insertEvent("mood-"+day,mood,localTime(day,780)));
    if (d.tired) statements.push(insertEvent("tired-"+day,"mood_cansado",localTime(day,800)));
    const next=days[i+1] as (typeof days)[number] | undefined;
    const nextLate=next?.late ?? false;
    const nextDelay=opts.variant==="common_cause" && d.alcohol ? 90 : 0;
    const nextBed=localTime(day,1440+30+(nextLate ? 80 : -50)+nextDelay+Math.round(next?.bedNoise ?? 0));
    const cigaretteTimes:number[]=[];
    if (d.smoking) {
      cigaretteTimes.push(localTime(day,600),localTime(day,900));
      if (d.lateCig) cigaretteTimes.push(nextBed-3600);
      for (const [j,ts] of cigaretteTimes.entries()) statements.push(insertEvent("cig-"+day+"-"+String(j),"cigarettes",ts));
    }
    if (d.caffeine) statements.push(insertEvent("coffee-"+day,"caffeine",localTime(day,d.lateCaffeine ? 1260 : 480),107));
    if (d.alcohol) statements.push(insertEvent("drink-"+day,"alcohol",localTime(day,1200),20));
    statements.push(db.prepare("INSERT INTO daily_summary (local_date,rhr,ln_rmssd,hrv_rmssd,spo2_avg,skin_temp_dev,resp_rate,steps,workout_min,hr_wear_min,computed_at) VALUES (?,?,?,?,97,?,15,?,?,1440,1)")
      .bind(day,rhr,hrv,Math.exp(hrv),illness ? 0.8 : 0,d.steps,d.workout ? 45 : null));
    if (d.workout) {
      const finish=d.lateWorkout ? nextBed-5400 : localTime(day,1020);
      statements.push(db.prepare("INSERT INTO workout (source_id,type,start_ts,end_ts,tz_offset_min,local_date,duration_min,updated_at) VALUES (?,'run',?,?,?,?,45,1)")
        .bind("workout-"+day,finish-2700,finish,offsetAt(finish),day));
    }
    const midnight=localTime(day,0);
    const pulseTimes=previousLateTs===null ? cigaretteTimes : [...cigaretteTimes,previousLateTs];
    previousLateTs=d.smoking && d.lateCig ? nextBed-3600 : null;
    const pulses=pulseTimes.map(ts=>`WHEN ${String(ts)} <= ?1 + m*60 AND ?1 + m*60 < ${String(ts+900)} THEN 8`).join(" ");
    statements.push(db.prepare(`INSERT INTO metric_minute (metric,ts,tz_offset_min,value,source)
      WITH RECURSIVE minutes(m) AS (SELECT 0 UNION ALL SELECT m+1 FROM minutes WHERE m<1439)
      SELECT 'hr',?1+m*60,?2,?3+0.002*(m-720)+((m*17+?4)%23-11)*0.03
        + ${pulses ? "CASE "+pulses+" ELSE 0 END" : "0"},'gh' FROM minutes`).bind(midnight,offsetAt(midnight),rhr+8,i));
    await db.batch(statements);
  }
}
