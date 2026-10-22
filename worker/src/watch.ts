import type { AppEnv } from "./app";
import { dateTimeFormat } from "./lib/time";
import { healthSleep } from "./mcp/tools/sleep";
import { healthWorkouts } from "./mcp/tools/workouts";

const encoder = new TextEncoder();
const KINDS: Record<string, string> = { caffeine: "cafe", cigarettes: "cigarro", alcohol: "alcohol" };

export async function handleWatchToday(request: Request, env: AppEnv, now: number): Promise<Response> {
  // Equal-length digests allow a constant-time comparison even when header lengths differ.
  const [actual, expected] = await Promise.all([request.headers.get("authorization") ?? "", `Bearer ${env.WATCH_TOKEN}`]
    .map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  if (typeof env.WATCH_TOKEN !== "string" || env.WATCH_TOKEN.length < 32 || !request.headers.has("authorization")
    || !crypto.subtle.timingSafeEqual(actual, expected)) return new Response(null, { status: 401 });

  const parts = dateTimeFormat("en-US", {
    timeZone: env.USER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now * 1000);
  const date = ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
  const midnight = Date.parse(`${date}T00:00:00Z`) / 1000;
  const minutes = (local: string) => (Date.parse(`${local}:00Z`) / 1000 - midnight) / 60;
  const [{ sessions }, { workouts }, { results: events }, { results: buckets }] = await Promise.all([
    healthSleep(env.DB, { start: date, end: date }),
    healthWorkouts(env.DB, { start: date, end: date }),
    // Every log of the day: the dial draws all of them, unlike health_trackers' 50-event page.
    env.DB.prepare(`
      SELECT e.tracker_id, e.ts + e.tz_offset_min * 60 AS local_ts,
        CASE WHEN t.value_type = 'count' THEN e.value ELSE 1 END AS n FROM event e JOIN tracker t ON t.id = e.tracker_id
      WHERE e.local_date = ? AND e.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY e.ts, e.id
    `).bind(date).all<{ tracker_id: string; local_ts: number; n: number }>(),
    env.DB.prepare(`
      SELECT CAST((ts + tz_offset_min * 60 - ?) / 900 AS INTEGER) AS i, round(avg(value)) AS bpm
      FROM metric_minute
      WHERE metric = 'hr' AND source = 'gh' AND ts >= ? AND ts < ? AND date(ts + tz_offset_min * 60, 'unixepoch') = ?
      GROUP BY i
    `).bind(midnight, midnight - 14 * 3600, midnight + 38 * 3600, date).all<{ i: number; bpm: number }>(),
  ]);
  const hr = Array<number | null>(96).fill(null);
  for (const { i, bpm } of buckets) hr[i] = bpm;
  const totals: Record<string, number> = {}, counts: Record<string, number> = {};
  const marks = events.map((e) => {
    const k = KINDS[e.tracker_id] ?? (e.tracker_id.startsWith("mood") ? "animo" : "other");
    totals[e.tracker_id] = (totals[e.tracker_id] ?? 0) + e.n;
    counts[k] = (counts[k] ?? 0) + e.n;   // count trackers (cigarettes) add their units; amounts count logs
    return { t: Math.floor((e.local_ts - midnight) / 60), k };
  });
  return Response.json({
    date, generatedAt: now,
    sleep: sessions.filter((s) => s.local_date === date)
      .map((s) => ({ start: minutes(s.start_local), end: minutes(s.end_local), nap: s.is_nap })),
    workouts: workouts.filter((w) => w.local_date === date).map((w) => ({ start: minutes(w.start_local), end: minutes(w.end_local) })),
    events: marks, totals, counts,
    hr,
  }, { headers: { "cache-control": "no-store" } });
}
