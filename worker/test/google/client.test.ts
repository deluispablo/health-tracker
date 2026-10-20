import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createGoogleClient, MissingScopeError } from "../../src/google/client";

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://health.googleapis.com/v4/users/me";

/** Scripted fetch: answers each call with the next response and records the request. */
function scripted(...responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url, method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "",
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(next());
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const token = (at = "at-1", expiresIn = 3599) => json({ access_token: at, expires_in: expiresIn, token_type: "Bearer" });
const devices = (...d: unknown[]) => json({ pairedDevices: d });

function client(fetch: typeof globalThis.fetch, sleeps: number[] = [], creds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rt" }) {
  return createGoogleClient({ fetch, kv: env.OAUTH_KV, ...creds, sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); } });
}

async function kvEntries() {
  const { keys } = await env.OAUTH_KV.list();
  return Promise.all(keys.map(async (k) => ({ name: k.name, expiration: k.expiration, value: await env.OAUTH_KV.get(k.name) })));
}

beforeEach(async () => {
  const { keys } = await env.OAUTH_KV.list();
  await Promise.all(keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("AC1 token cache", () => {
  it("posts an encoded form and caches the token in KV with a TTL of at most 50 min", async () => {
    const { fetch, calls } = scripted(token(), devices());
    await client(fetch, [], { clientId: "c&d=e", clientSecret: "s+/ ?", refreshToken: "r t" }).watchLastSync();
    expect(calls[0]?.url).toBe(TOKEN_URL);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      grant_type: "refresh_token", refresh_token: "r t", client_id: "c&d=e", client_secret: "s+/ ?" });
    expect(calls[1]?.headers.authorization).toBe("Bearer at-1");
    const entries = await kvEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("at-1");
    const ttl = (entries[0]?.expiration ?? 0) - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(3000 + 1);
  });

  it("reuses the KV token across client instances", async () => {
    const first = scripted(token(), devices());
    await client(first.fetch).watchLastSync();
    const second = scripted(devices());
    await client(second.fetch).watchLastSync();
    expect(second.calls.map((c) => c.url)).toEqual([`${API}/pairedDevices`]);
    expect(second.calls[0]?.headers.authorization).toBe("Bearer at-1");
  });

  it("refreshes again once the cached token is gone and honours a short expires_in", async () => {
    const first = scripted(token("at-short", 600), devices());
    await client(first.fetch).watchLastSync();
    const ttl = ((await kvEntries())[0]?.expiration ?? 0) - Date.now() / 1000;
    expect(ttl).toBeLessThanOrEqual(600 - 60 + 1);
    await env.OAUTH_KV.delete((await kvEntries())[0]?.name ?? "");
    const second = scripted(token("at-2"), devices());
    await client(second.fetch).watchLastSync();
    expect(second.calls[0]?.url).toBe(TOKEN_URL);
    expect(second.calls[1]?.headers.authorization).toBe("Bearer at-2");
  });
});

describe("AC2 list", () => {
  const p = (v: string) => ({ heartRate: { beatsPerMinute: v, sampleTime: { physicalTime: "2026-10-20T20:00:00Z", utcOffset: "7200s" } } });

  it("returns raw records across pages, including an empty middle page, with the snake_case filter", async () => {
    const { fetch, calls } = scripted(token(),
      json({ dataPoints: [p("70")], nextPageToken: "a+b/c=" }),
      json({ dataPoints: [], nextPageToken: "n3" }),
      json({ dataPoints: [p("71"), p("72")] }));
    const points = await client(fetch).list("heart-rate", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z");
    expect(points).toEqual([p("70"), p("71"), p("72")]);
    const urls = calls.slice(1).map((c) => new URL(c.url));
    expect(urls[0]?.pathname).toBe("/v4/users/me/dataTypes/heart-rate/dataPoints");
    expect(urls[0]?.searchParams.get("filter")).toBe(
      'heart_rate.sample_time.physical_time >= "2026-10-20T00:00:00Z" AND heart_rate.sample_time.physical_time < "2026-10-21T00:00:00Z"');
    expect(urls.map((u) => u.searchParams.get("pageToken"))).toEqual([null, "a+b/c=", "n3"]);
    expect(new Set(urls.map((u) => u.searchParams.get("filter"))).size).toBe(1);
  });

  it("retries a failed later page without duplicating records", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = scripted(token(), json({ dataPoints: [p("70")], nextPageToken: "n2" }), json({}, 503), json({ dataPoints: [p("71")] }));
    expect(await client(fetch, sleeps).list("heart-rate", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z")).toEqual([p("70"), p("71")]);
    expect(calls[2]?.url).toBe(calls[3]?.url);
  });
});

describe("AC3 heart-rate rollUp", () => {
  const item = (m: number, avg: number, max: number, min: number) => ({
    startTime: new Date(Date.UTC(2026, 9, 20, 20, m)).toISOString().replace(".000", ""),
    endTime: new Date(Date.UTC(2026, 9, 20, 20, m + 1)).toISOString().replace(".000", ""),
    heartRate: { beatsPerMinuteAvg: avg, beatsPerMinuteMax: max, beatsPerMinuteMin: min },
  });

  it("posts range + windowSize and maps every item without filling gaps", async () => {
    const { fetch, calls } = scripted(token(), json({ rollupDataPoints: [item(18, 77.8, 82, 74), item(25, 0, 0, 0)] }));
    const r = await client(fetch).rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 60);
    expect(r).toEqual([
      { ts: Date.UTC(2026, 9, 20, 20, 18) / 1000, avg: 77.8, min: 74, max: 82 },
      { ts: Date.UTC(2026, 9, 20, 20, 25) / 1000, avg: 0, min: 0, max: 0 },
    ]);
    expect(calls[1]?.url).toBe(`${API}/dataTypes/heart-rate/dataPoints:rollUp`);
    expect(calls[1]?.method).toBe("POST");
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      range: { startTime: "2026-10-20T18:00:00Z", endTime: "2026-10-20T21:00:00Z" }, windowSize: "60s" });
  });

  it("returns [] for an empty response and supports other minute windows", async () => {
    const { fetch, calls } = scripted(token(), json({}), json({ rollupDataPoints: [] }));
    const c = client(fetch);
    expect(await c.rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 300)).toEqual([]);
    expect(await c.rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 3600)).toEqual([]);
    expect(JSON.parse(calls[1]?.body ?? "").windowSize).toBe("300s");
    expect(JSON.parse(calls[2]?.body ?? "").windowSize).toBe("3600s");
  });

  it("accepts exactly 14 days and rejects more, or bad windows, without calling Google", async () => {
    const ok = scripted(token(), json({ rollupDataPoints: [] }));
    await client(ok.fetch).rollUpHeartRate("2026-10-01T00:00:00Z", "2026-10-15T00:00:00Z", 60);
    const { fetch, calls } = scripted();
    const c = client(fetch);
    await expect(c.rollUpHeartRate("2026-10-01T00:00:00Z", "2026-10-15T00:00:01Z", 60)).rejects.toThrow(RangeError);
    await expect(c.rollUpHeartRate("2026-10-01T00:00:00Z", "2026-10-01T03:00:00Z", 90)).rejects.toThrow(RangeError);
    await expect(c.rollUpHeartRate("2026-10-01T00:00:00Z", "2026-10-01T03:00:00Z", 0)).rejects.toThrow(RangeError);
    await expect(c.rollUpHeartRate("2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z", 60)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("retries with the same body", async () => {
    const { fetch, calls } = scripted(token(), json({}, 500), json({ rollupDataPoints: [] }));
    await client(fetch).rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 60);
    expect(calls[1]?.body).toBe(calls[2]?.body);
  });
});

describe("AC4 retries and errors", () => {
  it("backs off 500·2^n ms unless Retry-After (seconds) says otherwise, 3 retries max", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = scripted(token(), json({}, 429, { "retry-after": "2" }), json({}, 503), json({}, 500), devices());
    await client(fetch, sleeps).watchLastSync();
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([2000, 1000, 2000]);
  });

  it("honours a later Retry-After and retries the token refresh too", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = scripted(json({}, 503), token(), json({}, 503), json({}, 429, { "retry-after": "5" }), devices());
    await client(fetch, sleeps).watchLastSync();
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, TOKEN_URL, `${API}/pairedDevices`, `${API}/pairedDevices`, `${API}/pairedDevices`]);
    expect(sleeps).toEqual([500, 500, 5000]);
  });

  it("gives up after 3 retries", async () => {
    const { fetch, calls } = scripted(token(), json({}, 503), json({}, 503), json({}, 503), json({}, 503));
    await expect(client(fetch).watchLastSync()).rejects.toThrow();
    expect(calls).toHaveLength(5);
  });

  it("throws MissingScopeError only for ACCESS_TOKEN_SCOPE_INSUFFICIENT, without retrying", async () => {
    const scope = scripted(token(), json({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403));
    await expect(client(scope.fetch).watchLastSync()).rejects.toBeInstanceOf(MissingScopeError);
    expect(scope.calls).toHaveLength(2);
    const other = scripted(json({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCOUNT_NOT_LINKED" }] } }, 403));
    const err = await client(other.fetch).watchLastSync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MissingScopeError);
    expect(other.calls).toHaveLength(1);
  });

  it("does not retry 400", async () => {
    const { fetch, calls } = scripted(token(), json({ error: { code: 400 } }, 400));
    await expect(client(fetch).watchLastSync()).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("drops the cached token on 401 and throws without replaying", async () => {
    const first = scripted(token(), devices());
    await client(first.fetch).watchLastSync();
    const { fetch, calls } = scripted(json({ error: { code: 401 } }, 401));
    await expect(client(fetch).watchLastSync()).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(await kvEntries()).toEqual([]);
  });
});

describe("AC5 paired devices", () => {
  it("returns the latest watch sync and ignores the phone and watches without a sync time", async () => {
    const { fetch } = scripted(token(), devices(
      { deviceVersion: "MobileTrack", lastSyncTime: "2026-10-21T00:00:00Z" },
      { deviceVersion: "Google Pixel Watch 2", lastSyncTime: "2026-09-01T10:00:00Z" },
      { deviceVersion: "Google Pixel Watch 3", lastSyncTime: "2026-10-20T20:19:09Z", batteryLevel: 68 },
      { deviceVersion: "Google Pixel Watch 4" },
    ));
    expect(await client(fetch).watchLastSync()).toBe("2026-10-20T20:19:09Z");
  });

  it("returns null when no watch has synced", async () => {
    const { fetch } = scripted(token(), devices({ deviceVersion: "MobileTrack", lastSyncTime: "2026-10-21T00:00:00Z" }, { deviceVersion: "Pixel Watch" }));
    expect(await client(fetch).watchLastSync()).toBeNull();
  });
});
