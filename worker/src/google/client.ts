const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://health.googleapis.com/v4/users/me";
const KV_KEY = "google_access_token";
const MAX_RETRIES = 3;
const MAX_ROLLUP_MS = 14 * 24 * 3600 * 1000;

export class MissingScopeError extends Error {
  constructor() {
    super("Google access token lacks a required scope");
    this.name = "MissingScopeError";
  }
}

export interface GoogleClientOptions {
  fetch: typeof fetch;
  kv: KVNamespace;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sleep: (ms: number) => Promise<void>;
}

export interface RollUpPoint { ts: number; avg: number; min: number; max: number }

interface Device { deviceVersion?: string; lastSyncTime?: string }

const RFC3339 = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/;

/** Epoch ms of a valid RFC 3339 date-time; NaN when malformed, impossible or finer than 1 ms (Date would truncate it). */
function parseInstant(s: string): number {
  const m = RFC3339.exec(s);
  if (!m || /[1-9]/.test(((m[7] as string | undefined) ?? "").slice(3))) return Number.NaN;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return Number.NaN;
  return Date.parse(s);
}

/** Sortable key: whole seconds, then the fraction padded to ns (orders beyond ms precision). */
function syncKey(t: string): string {
  const m = /^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(t);
  return `${String(Date.parse(`${m?.[1] ?? t}${m?.[3] ?? ""}`)).padStart(16, "0")}.${(m?.[2] ?? "").padEnd(9, "0")}`;
}

export function createGoogleClient(o: GoogleClientOptions) {
  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let n = 0; ; n++) {
      const res = await o.fetch(url, init);
      if ((res.status !== 429 && res.status < 500) || n === MAX_RETRIES) return res;
      const ra = res.headers.get("retry-after");
      await o.sleep(ra !== null && /^\d+$/.test(ra) ? Number(ra) * 1000 : 500 * 2 ** n);
    }
  }

  async function accessToken(): Promise<string> {
    const cached = await o.kv.get(KV_KEY);
    if (cached) return cached;
    const res = await send(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: o.refreshToken,
        client_id: o.clientId, client_secret: o.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Google token refresh failed: ${String(res.status)}`);
    const { access_token, expires_in } = await res.json<{ access_token: string; expires_in: number }>();
    // KV minimum TTL is 60 s, so tokens with expires_in < 120 are used but not cached.
    if (expires_in >= 120) {
      await o.kv.put(KV_KEY, access_token, { expirationTtl: Math.min(expires_in - 60, 3000) }).catch(() => undefined);
    }
    return access_token;
  }

  async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = { ...(init.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${await accessToken()}` };
    const res = await send(url, { ...init, headers });
    if (res.ok) return res.json<T>();
    if (res.status === 401) await o.kv.delete(KV_KEY);
    if (res.status === 403) {
      const body = await res.json<{ error?: { details?: { reason?: string }[] } }>().catch(() => null);
      if (body?.error?.details?.some((d) => d.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) throw new MissingScopeError();
    }
    throw new Error(`Google API ${String(res.status)}`);
  }

  return {
    /** Raw dataPoints of a sample-based type over [start, end), following every page. */
    async list(type: string, start: string, end: string): Promise<unknown[]> {
      const field = `${type.replaceAll("-", "_")}.sample_time.physical_time`;
      const filter = `${field} >= "${start}" AND ${field} < "${end}"`;
      const out: unknown[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ filter });
        if (pageToken) q.set("pageToken", pageToken);
        const page = await api<{ dataPoints?: unknown[]; nextPageToken?: string }>(`${API}/dataTypes/${type}/dataPoints?${q.toString()}`);
        out.push(...(page.dataPoints ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },

    async rollUpHeartRate(start: string, end: string, windowSec: number): Promise<RollUpPoint[]> {
      const span = parseInstant(end) - parseInstant(start);
      if (!(span > 0 && span <= MAX_ROLLUP_MS)) throw new RangeError("rollUp range must be valid, end after start, at most 14 days");
      if (!Number.isInteger(windowSec) || windowSec <= 0 || windowSec % 60 !== 0) throw new RangeError("rollUp window must be a positive multiple of 60 s");
      const res = await api<{ rollupDataPoints?: { startTime: string; heartRate: { beatsPerMinuteAvg: number; beatsPerMinuteMin: number; beatsPerMinuteMax: number } }[] }>(
        `${API}/dataTypes/heart-rate/dataPoints:rollUp`,
        { method: "POST", body: JSON.stringify({ range: { startTime: start, endTime: end }, windowSize: `${String(windowSec)}s` }) });
      return (res.rollupDataPoints ?? []).map((p) => ({
        ts: Date.parse(p.startTime) / 1000,
        avg: p.heartRate.beatsPerMinuteAvg, min: p.heartRate.beatsPerMinuteMin, max: p.heartRate.beatsPerMinuteMax,
      }));
    },

    /** lastSyncTime (as sent) of the most recently synced watch, or null. */
    async watchLastSync(): Promise<string | null> {
      const { pairedDevices = [] } = await api<{ pairedDevices?: Device[] }>(`${API}/pairedDevices`);
      let best: string | null = null;
      for (const d of pairedDevices) {
        const t = d.lastSyncTime;
        if (t && d.deviceVersion?.includes("Watch") && (best === null || syncKey(t) > syncKey(best))) best = t;
      }
      return best;
    },
  };
}
