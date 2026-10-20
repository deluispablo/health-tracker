import { upsertRows } from "../lib/d1";
import { verifyGoogleSignature } from "../lib/signature";

interface WebhookEnv { DB: D1Database; WEBHOOK_SECRET: string }
interface WebhookDeps { keyset: () => Promise<unknown>; now?: () => number }

const encoder = new TextEncoder();
const RFC3339 = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function instant(value: unknown, civil: boolean): { seconds: number; fraction: string } {
  if (typeof value !== "string") throw new TypeError("Missing timestamp");
  const m = RFC3339.exec(civil ? `${value}Z` : value);
  if (!m) throw new TypeError("Invalid timestamp");
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new TypeError("Impossible timestamp");
  }
  const zone = m[8];
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4));
    if (hours > 23 || minutes > 59) throw new TypeError("Invalid offset");
    offset = (zone[0] === "+" ? 1 : -1) * (hours * 3600 + minutes * 60);
  }
  return { seconds: date.getTime() / 1000 - offset, fraction: m.at(7) ?? "" };
}

function interval(value: unknown): [number, number] | null {
  if (!object(value)) throw new TypeError("Invalid interval");
  const physical = "physicalTimeInterval" in value;
  if (!physical && !("civilIso8601TimeInterval" in value)) return null;
  const range = physical ? value.physicalTimeInterval : value.civilIso8601TimeInterval;
  if (!object(range)) throw new TypeError("Invalid interval endpoints");
  const start = instant(range.startTime, !physical);
  const end = instant(range.endTime, !physical);
  const precision = Math.max(start.fraction.length, end.fraction.length);
  // Compare the exact instants before outward rounding, including fractions finer than milliseconds.
  if (end.seconds < start.seconds || (end.seconds === start.seconds
    && end.fraction.padEnd(precision, "0") <= start.fraction.padEnd(precision, "0"))) {
    throw new TypeError("Interval end must follow start");
  }
  const widen = physical ? 0 : 14 * 3600;
  return [start.seconds - widen, end.seconds + (/[1-9]/.test(end.fraction) ? 1 : 0) + widen];
}

function queueRows(body: ArrayBuffer, receivedAt: number): unknown[][] {
  const items: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!Array.isArray(items)) throw new TypeError("Expected notification list");
  const rows: unknown[][] = [];
  for (const item of items as unknown[]) {
    if (!object(item) || !object(item.data)) throw new TypeError("Invalid notification");
    const { dataType, operation, intervals } = item.data;
    if (typeof dataType !== "string" || !/^[a-z0-9-]+$/.test(dataType)
      || (operation !== "UPSERT" && operation !== "DELETE") || !Array.isArray(intervals)) {
      throw new TypeError("Invalid notification fields");
    }
    for (const value of intervals as unknown[]) {
      const range = interval(value);
      if (range) rows.push([dataType, ...range, operation, receivedAt]);
    }
  }
  return rows;
}

export async function handleGoogleWebhook(request: Request, env: WebhookEnv, deps: WebhookDeps): Promise<Response> {
  // Equal-length digests allow a constant-time comparison even when header lengths differ.
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("authorization") ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(env.WEBHOOK_SECRET)),
  ]);
  if (!request.headers.has("authorization") || !crypto.subtle.timingSafeEqual(actual, expected)) return new Response(null, { status: 401 });

  const body = await request.arrayBuffer();
  if (body.byteLength <= 64) {
    try {
      const probe: unknown = JSON.parse(new TextDecoder().decode(body));
      if (object(probe) && Object.keys(probe).length === 1 && probe.type === "verification") return new Response(null, { status: 200 });
    } catch { /* A failed bounded handshake probe still requires a signature. */ }
  }
  const verified = await verifyGoogleSignature(request.headers.get("google-health-api-signature"), body, deps.keyset);
  if (verified !== "valid") return new Response(null, { status: verified === "unavailable" ? 503 : 401 });

  let rows: unknown[][];
  try { rows = queueRows(body, deps.now ? deps.now() : Math.floor(Date.now() / 1000)); }
  catch { return new Response(null, { status: 400 }); }
  try {
    await upsertRows(env.DB, "sync_pending", ["data_type", "start_ts", "end_ts", "operation", "received_at"],
      ["data_type", "start_ts", "end_ts", "operation"], rows);
  } catch { return new Response(null, { status: 500 }); }
  return new Response(null, { status: 204 });
}
