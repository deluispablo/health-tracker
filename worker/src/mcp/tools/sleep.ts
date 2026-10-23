import { dateRangeDays } from "../../lib/time";

type Stage = [number, number, string];

interface Session {
  local_date: string;
  is_nap: boolean;
  start_local: string;
  end_local: string;
  tz_offset_min: number;
  minutes_asleep: number | null;
  minutes_in_bed: number | null;
  efficiency: number | null;
  deep_min: number | null;
  rem_min: number | null;
  light_min: number | null;
  awake_min: number | null;
  latency_min: number | null;
  stages: Stage[];
}

interface SessionRow extends Omit<Session, "is_nap" | "start_local" | "end_local" | "stages"> {
  source_id: string;
  start_ts: number;
  end_ts: number;
  is_nap: number;
}

interface StageRow {
  session_id: string;
  start_ts: number;
  end_ts: number;
  session_start_ts: number;
  stage: string;
}

function localTime(timestamp: number, offset: number): string {
  return new Date((timestamp + offset * 60) * 1000).toISOString().slice(0, 16);
}

export async function healthSleep(db: D1Database, { start, end }: {
  start: string; end: string;
}): Promise<{ sessions: Session[]; coverage: { days_requested: number; days_with_sleep: number } }> {
  const daysRequested = dateRangeDays(start, end, 31, true);

  const [sessionsResult, stagesResult] = await db.batch<SessionRow | StageRow>([
    db.prepare(`
      SELECT source_id, start_ts, end_ts, local_date, is_nap, tz_offset_min,
        minutes_asleep, minutes_in_bed, efficiency, deep_min, rem_min, light_min, awake_min, latency_min
      FROM sleep_session WHERE local_date BETWEEN ? AND ? ORDER BY start_ts, source_id
    `).bind(start, end),
    db.prepare(`
      SELECT st.session_id, st.start_ts, st.end_ts, st.stage, s.start_ts AS session_start_ts
      FROM sleep_session s JOIN sleep_stage st ON st.session_id = s.source_id
      WHERE s.local_date BETWEEN ? AND ? ORDER BY st.session_id, st.start_ts
    `).bind(start, end),
  ]);
  const rows = sessionsResult.results as SessionRow[];
  const stages = stagesResult.results as StageRow[];

  const bySession = new Map<string, Stage[]>();
  for (const row of stages) {
    const hypnogram = bySession.get(row.session_id) ?? [];
    hypnogram.push([
      Math.floor((row.start_ts - row.session_start_ts) / 60),
      Math.floor((row.end_ts - row.session_start_ts) / 60), row.stage,
    ]);
    bySession.set(row.session_id, hypnogram);
  }
  const sessions = rows.map(({ source_id, start_ts, end_ts, is_nap, ...summary }) => ({
    ...summary,
    is_nap: Boolean(is_nap),
    start_local: localTime(start_ts, summary.tz_offset_min),
    end_local: localTime(end_ts, summary.tz_offset_min),
    stages: bySession.get(source_id) ?? [],
  }));
  return {
    sessions,
    coverage: { days_requested: daysRequested, days_with_sleep: new Set(rows.map((row) => row.local_date)).size },
  };
}
