import type { AppEnv } from "./app";
import { dateTimeFormat } from "./lib/time";
import { healthSleep } from "./mcp/tools/sleep";
import { deleteEvent, logEvent } from "./mcp/tools/trackers";
import { healthWorkouts } from "./mcp/tools/workouts";

const encoder = new TextEncoder();
const KINDS: Record<string, string> = { caffeine: "cafe", cigarettes: "cigarro", alcohol: "alcohol", water: "agua" };
// Watch logs are stored as kw_<key>, an id MCP (always k_<key>) can never produce, so the watch token
// can neither replay nor undo an MCP log.
const WATCH_ID = "kw_";
const watchKey = (key: unknown) => typeof key === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : null;

async function authorized(request: Request, env: AppEnv): Promise<boolean> {
  // Equal-length digests allow a constant-time comparison even when header lengths differ.
  const [actual, expected] = await Promise.all([request.headers.get("authorization") ?? "", `Bearer ${env.WATCH_TOKEN}`]
    .map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return typeof env.WATCH_TOKEN === "string" && env.WATCH_TOKEN.length >= 32 && request.headers.has("authorization")
    && crypto.subtle.timingSafeEqual(actual, expected);
}

/** Logs one tap from the watch (POST) or undoes one (DELETE); the idempotency key makes retries safe. */
export async function handleWatchLog(request: Request, env: AppEnv, now: number): Promise<Response> {
  if (!await authorized(request, env)) return new Response(null, { status: 401 });
  if (request.method === "DELETE") {
    const body = await request.json().catch(() => null) as { idempotency_key?: unknown } | null;
    const key = watchKey(body?.idempotency_key);
    if (!key) return Response.json({ error: "idempotency_key is required" }, { status: 400 });
    const row = await env.DB.prepare(`SELECT e.tracker_id FROM event e JOIN tracker t ON t.id = e.tracker_id
      WHERE e.id = ? AND t.surface IS NOT NULL AND t.default_value IS NOT NULL AND t.archived_at IS NULL`).bind(WATCH_ID + key).first<{ tracker_id: string }>();
    if (!row) return new Response(null, { status: 404 });
    return Response.json(await deleteEvent(env.DB, { event_id: WATCH_ID + key }, { now }));
  }
  const body = await request.json().catch(() => null) as { tracker_id?: unknown; at?: unknown; idempotency_key?: unknown } | null;
  if (!body || typeof body.tracker_id !== "string"
    || typeof body.at !== "string") {
    return Response.json({ error: "tracker_id, at and idempotency_key are required" }, { status: 400 });
  }
  const key = watchKey(body.idempotency_key);
  if (!key) return Response.json({ error: "tracker_id, at and idempotency_key are required" }, { status: 400 });
  const tracker = await env.DB.prepare("SELECT id FROM tracker WHERE id = ? AND surface IS NOT NULL AND default_value IS NOT NULL AND archived_at IS NULL")
    .bind(body.tracker_id).first();
  if (!tracker) return Response.json({ error: "tracker_id must name an active watch tracker" }, { status: 400 });
  try {
    const result = await logEvent(env.DB, { tracker_id: body.tracker_id, at: body.at, idempotency_key: key },
      { now, tz: env.USER_TZ, idPrefix: WATCH_ID });
    // A replay (or a lost insert race) returns the stored event: only hand it back if it is this tap's tracker.
    if (result.event.tracker_id !== body.tracker_id) return new Response(null, { status: 409 });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (e) {
    if (e instanceof RangeError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function handleWatchToday(request: Request, env: AppEnv, now: number): Promise<Response> {
  if (!await authorized(request, env)) return new Response(null, { status: 401 });

  const parts = dateTimeFormat("en-US", {
    timeZone: env.USER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now * 1000);
  const date = ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
  const midnight = Date.parse(`${date}T00:00:00Z`) / 1000;
  const minutes = (local: string) => (Date.parse(`${local}:00Z`) / 1000 - midnight) / 60;
  const [{ sessions }, { workouts }, { results: events }, { results: buckets }, catalog] = await Promise.all([
    healthSleep(env.DB, { start: date, end: date }),
    healthWorkouts(env.DB, { start: date, end: date }),
    // Every log of the day: the dial draws all of them, unlike health_trackers' 50-event page.
    env.DB.prepare(`
      SELECT e.id, e.tracker_id, e.ts + e.tz_offset_min * 60 AS local_ts,
        e.value, t.surface,
        CASE WHEN t.value_type = 'count' THEN e.value ELSE 1 END AS n FROM event e JOIN tracker t ON t.id = e.tracker_id
      WHERE e.local_date = ? AND e.deleted_at IS NULL ORDER BY e.ts, e.id
    `).bind(date).all<{ id: string; tracker_id: string; local_ts: number; n: number; value: number; surface: string | null }>(),
    env.DB.prepare(`
      SELECT CAST((ts + tz_offset_min * 60 - ?) / 900 AS INTEGER) AS i, round(avg(value)) AS bpm
      FROM metric_minute
      WHERE metric = 'hr' AND source = 'gh' AND ts >= ? AND ts < ? AND date(ts + tz_offset_min * 60, 'unixepoch') = ?
      GROUP BY i
    `).bind(midnight, midnight - 14 * 3600, midnight + 38 * 3600, date).all<{ i: number; bpm: number }>(),
    env.DB.batch<{ value: string | number | null }>([
      env.DB.prepare(`
        SELECT t.id, t.name, t.unit, t.default_value AS value, t.surface,
          CASE WHEN t.value_type = 'scale' THEN COALESCE((SELECT latest.value FROM event latest
              WHERE latest.tracker_id = t.id AND latest.local_date = ? AND latest.deleted_at IS NULL
              ORDER BY latest.ts DESC, latest.id DESC LIMIT 1), 0)
            ELSE COALESCE(SUM(e.value), 0) END AS today
        FROM tracker t LEFT JOIN event e ON e.tracker_id = t.id AND e.local_date = ? AND e.deleted_at IS NULL
        WHERE t.surface IS NOT NULL AND t.default_value IS NOT NULL AND t.archived_at IS NULL GROUP BY t.id ORDER BY t.sort, t.id
      `).bind(date, date),
      env.DB.prepare("SELECT value FROM profile WHERE key = 'water_goal_ml'"),
    ]),
  ]);
  const trackers = catalog[0].results;
  let goal_ml = 2000;
  try {
    const goal: unknown = JSON.parse(catalog[1].results[0]?.value as string);
    if (typeof goal === "number" && Number.isInteger(goal) && goal >= 500 && goal <= 6000) goal_ml = goal;
  } catch { /* Unset or invalid stored goals use the default. */ }
  const ml = events.filter((e) => e.tracker_id === "water").reduce((sum, e) => sum + e.value, 0);
  const hr = Array<number | null>(96).fill(null);
  for (const { i, bpm } of buckets) hr[i] = bpm;
  const totals: Record<string, number> = {}, counts: Record<string, number> = {};
  const marks = events.map((e) => {
    const k = e.surface === "tile" ? "suplemento" : KINDS[e.tracker_id] ?? (e.tracker_id.startsWith("mood") ? "animo" : "other");
    totals[e.tracker_id] = (totals[e.tracker_id] ?? 0) + e.n;
    counts[k] = (counts[k] ?? 0) + e.n;   // count trackers (cigarettes) add their units; amounts count logs
    // Moods carry which one, so the dial can colour it; watch logs carry their key, so the watch can match its queue.
    const t = Math.floor((e.local_ts - midnight) / 60);
    return {
      t, k, ...(k === "suplemento" ? { id: e.tracker_id } : {}), ...(k === "animo" ? { m: e.tracker_id.slice("mood_".length) } : {}),
      ...(e.id.startsWith(WATCH_ID) ? { i: e.id.slice(WATCH_ID.length) } : {}),
    };
  });
  return Response.json({
    date, generatedAt: now,
    sleep: sessions.filter((s) => s.local_date === date)
      .map((s) => ({ start: minutes(s.start_local), end: minutes(s.end_local), nap: s.is_nap })),
    workouts: workouts.filter((w) => w.local_date === date).map((w) => ({ start: minutes(w.start_local), end: minutes(w.end_local) })),
    events: marks, totals, counts,
    water: { ml, goal_ml }, trackers,
    hr,
  }, { headers: { "cache-control": "no-store" } });
}
