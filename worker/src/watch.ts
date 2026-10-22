import type { AppEnv } from "./app";
import { dateTimeFormat } from "./lib/time";
import { healthSleep } from "./mcp/tools/sleep";
import { healthTrackers } from "./mcp/tools/trackers";
import { healthWorkouts } from "./mcp/tools/workouts";

const encoder = new TextEncoder();
const KINDS: Record<string, string> = { caffeine: "cafe", cigarettes: "cigarro", alcohol: "alcohol" };

export async function handleWatchToday(request: Request, env: AppEnv, now: number): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
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
  const [{ sessions }, { workouts }, { events }, { results: buckets }] = await Promise.all([
    healthSleep(env.DB, { start: date, end: date }),
    healthWorkouts(env.DB, { start: date, end: date }),
    healthTrackers(env.DB, { date }),
    env.DB.prepare(`
      SELECT CAST((ts + tz_offset_min * 60 - ?) / 900 AS INTEGER) AS i, round(avg(value)) AS bpm
      FROM metric_minute
      WHERE metric = 'hr' AND source = 'gh' AND ts >= ? AND ts < ? AND date(ts + tz_offset_min * 60, 'unixepoch') = ?
      GROUP BY i
    `).bind(midnight, midnight - 14 * 3600, midnight + 38 * 3600, date).all<{ i: number; bpm: number }>(),
  ]);
  const hr = Array<number | null>(96).fill(null);
  for (const { i, bpm } of buckets) hr[i] = bpm;
  return Response.json({
    date, generatedAt: now,
    sleep: sessions.filter((s) => s.local_date === date)
      .map((s) => ({ start: minutes(s.start_local), end: minutes(s.end_local), nap: s.is_nap })),
    workouts: workouts.filter((w) => w.local_date === date).map((w) => ({ start: minutes(w.start_local), end: minutes(w.end_local) })),
    events: events.flatMap((e) => e.local_time === null ? [] : [{
      t: minutes(`${date}T${e.local_time}`),
      k: KINDS[e.tracker_id] ?? (e.tracker_id.startsWith("mood") ? "animo" : "other"),
    }]),
    hr,
  }, { headers: { "cache-control": "no-store" } });
}
