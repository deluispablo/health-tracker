import { isCalendarDate } from "../lib/time";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://health.googleapis.com/v4/users/me";
const KV_KEY = "google_access_token";
const MAX_RETRIES = 3;
const MAX_ROLLUP_MS = 14 * 24 * 3600 * 1000;

export interface GoogleClientOptions {
  fetch: typeof fetch;
  kv: KVNamespace;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sleep: (ms: number) => Promise<void>;
}

export interface RollUpPoint { ts: number; avg: number; min: number; max: number }
export interface StepsRollUpPoint { ts: number; steps: number }
export interface DailyRollUpPoint { date: string; value: unknown }

interface Device { deviceVersion?: string; lastSyncTime?: string }
interface CivilDate { year: number; month: number; day: number }

function parseCivilDate(s: string): Date {
  if (!isCalendarDate(s)) {
    throw new RangeError("date must be a real calendar date in YYYY-MM-DD format");
  }
  return new Date(`${s}T00:00:00Z`);
}

function civilRange(start: string, end: string, maxDays = Infinity) {
  const a = parseCivilDate(start);
  const b = parseCivilDate(end);
  const days = (b.getTime() - a.getTime()) / 86400000;
  if (!(days > 0 && days <= maxDays)) throw new RangeError("civil range must end after start and fit the daily limit");
  const fields = (d: Date): CivilDate => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  return { start: { date: fields(a) }, end: { date: fields(b) } };
}

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

/** Returned exercise instants accept arbitrary fractions, truncated to milliseconds. */
export function parseExerciseInstant(value: unknown): number {
  if (typeof value !== "string" || !RFC3339.test(value)) return NaN;
  if (!isCalendarDate(value.slice(0, 10))
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return NaN;
  return Date.parse(value);
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
      await o.sleep(ra !== null && /^\d+$/.test(ra) ? Math.min(Number(ra) * 1000, 10_000) : 500 * 2 ** n);
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
    throw new Error(`Google API ${String(res.status)}`);
  }

  async function listPages(type: string, field: string, start: string, end: string, action = ""): Promise<unknown[]> {
    const path = `${type.replaceAll("-", "_")}.${field}`;
    const filter = `${path} >= "${start}" AND ${path} < "${end}"`;
    const out: unknown[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ filter });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await api<{ dataPoints?: unknown[]; nextPageToken?: string }>(`${API}/dataTypes/${type}/dataPoints${action}?${q.toString()}`);
      out.push(...(page.dataPoints ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  return {
    async reconcile(type: string, start: string, end: string): Promise<unknown[]> {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(type)) throw new RangeError("invalid data type");
      const a = parseInstant(start);
      const b = parseInstant(end);
      if (!(b > a)) throw new RangeError("reconcile range must be valid with end after start");
      if (type === "exercise") {
        const civil = (ms: number) => new Date(ms).toISOString().slice(0, 19);
        const items = await listPages(type, "interval.civil_start_time",
          civil(Math.floor((a - 14 * 3600000) / 1000) * 1000),
          civil(Math.ceil((b + 14 * 3600000) / 1000) * 1000), ":reconcile");
        return items.filter((item) => {
          const point = item as { exercise?: { interval?: { startTime?: unknown } } } | null;
          const time = parseExerciseInstant(point?.exercise?.interval?.startTime);
          return time >= a && time < b;
        });
      }
      const field = type === "sleep" ? "interval.end_time" : "sample_time.physical_time";
      return listPages(type, field, start, end, ":reconcile");
    },

    async listDaily(type: string, startDate: string, endDate: string): Promise<unknown[]> {
      civilRange(startDate, endDate);
      return listPages(type, "date", startDate, endDate);
    },

    async dailyRollUp(type: string, startDate: string, endDate: string): Promise<DailyRollUpPoint[]> {
      const maxDays = ["heart-rate", "active-minutes", "total-calories", "active-energy-burned"].includes(type) ? 14 : 90;
      const range = civilRange(startDate, endDate, maxDays);
      const res = await api<{ rollupDataPoints?: ({ civilStartTime: { date: CivilDate } } & Record<string, unknown>)[] }>(
        `${API}/dataTypes/${type}/dataPoints:dailyRollUp`,
        { method: "POST", body: JSON.stringify({ range,
          ...(type === "steps" ? { dataSourceFamily: "users/me/dataSourceFamilies/google-wearables" } : {}) }) });
      const key = type.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      return (res.rollupDataPoints ?? []).map((p) => {
        const { year, month, day } = p.civilStartTime.date;
        return { date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, value: p[key] };
      }).sort((a, b) => a.date.localeCompare(b.date));
    },

    async rollUpHeartRate(start: string, end: string, windowSec: number): Promise<RollUpPoint[]> {
      const span = parseInstant(end) - parseInstant(start);
      if (!(span > 0 && span <= MAX_ROLLUP_MS)) throw new RangeError("rollUp range must be valid, end after start, at most 14 days");
      if (!Number.isInteger(windowSec) || windowSec <= 0 || windowSec % 60 !== 0) throw new RangeError("rollUp window must be a positive multiple of 60 s");
      const out: RollUpPoint[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await api<{ rollupDataPoints?: ({ startTime?: string;
          heartRate?: { beatsPerMinuteAvg?: number; beatsPerMinuteMin?: number; beatsPerMinuteMax?: number } | null } | null)[];
          nextPageToken?: string }>(`${API}/dataTypes/heart-rate/dataPoints:rollUp`,
          { method: "POST", body: JSON.stringify({ range: { startTime: start, endTime: end }, windowSize: `${String(windowSec)}s`, pageToken }) });
        out.push(...(res.rollupDataPoints ?? []).map((p) => ({
          ts: Date.parse(p?.startTime ?? "") / 1000,
          avg: p?.heartRate?.beatsPerMinuteAvg, min: p?.heartRate?.beatsPerMinuteMin, max: p?.heartRate?.beatsPerMinuteMax,
        })).filter((point): point is RollUpPoint => [point.ts, point.avg, point.min, point.max].every(Number.isFinite)));
        pageToken = res.nextPageToken;
        if (!pageToken) return out;
      }
      throw new Error("Heart-rate rollUp exceeded 10 pages");
    },

    async rollUpSteps(start: string, end: string): Promise<StepsRollUpPoint[]> {
      const span = parseInstant(end) - parseInstant(start);
      if (!(span > 0 && span <= MAX_ROLLUP_MS)) throw new RangeError("rollUp range must be valid, end after start, at most 14 days");
      const res = await api<{ rollupDataPoints?: ({ startTime?: string; steps?: { countSum?: unknown } | null } | null)[];
        nextPageToken?: string }>(`${API}/dataTypes/steps/dataPoints:rollUp`,
        { method: "POST", body: JSON.stringify({ range: { startTime: start, endTime: end }, windowSize: "3600s",
          dataSourceFamily: "users/me/dataSourceFamilies/google-wearables" }) });
      if (res.nextPageToken) throw new Error("Unexpected steps rollUp paging");
      return (res.rollupDataPoints ?? []).flatMap((p) => {
        const count = p?.steps?.countSum;
        const steps = typeof count === "number" || (typeof count === "string" && count.trim() !== "") ? Number(count) : NaN;
        const ts = typeof p?.startTime === "string" ? parseInstant(p.startTime) / 1000 : NaN;
        return Number.isFinite(ts) && Number.isInteger(steps) && steps >= 0 ? [{ ts, steps }] : [];
      });
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
