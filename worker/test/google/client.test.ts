import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createGoogleClient } from "../../src/google/client";

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://health.googleapis.com/v4/users/me";

/** Scripted fetch: answers each call with the next response and records the request. */
function scripted(...responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init); // normalises both call forms
    calls.push({
      url: req.url, method: req.method,
      headers: Object.fromEntries(req.headers.entries()),
      body: await req.text(),
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${req.url}`);
    return next();
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const token = (at = "at-1", expiresIn = 3599) => json({ access_token: at, expires_in: expiresIn, token_type: "Bearer" });
const devices = (...d: unknown[]) => json({ pairedDevices: d });

function client(fetch: typeof globalThis.fetch, sleeps: number[] = [], creds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rt" }, kv: KVNamespace = env.OAUTH_KV) {
  return createGoogleClient({ fetch, kv, ...creds, sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); } });
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
    expect(ttl).toBeGreaterThan(3000 - 5);
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
    expect(ttl).toBeGreaterThan(540 - 5);
    expect(ttl).toBeLessThanOrEqual(540 + 1);
    await env.OAUTH_KV.delete((await kvEntries())[0]?.name ?? "");
    const second = scripted(token("at-2"), devices());
    await client(second.fetch).watchLastSync();
    expect(second.calls[0]?.url).toBe(TOKEN_URL);
    expect(second.calls[1]?.headers.authorization).toBe("Bearer at-2");
  });
});

describe("AC1 token cache edges", () => {
  it("caches from expires_in 120 (TTL 60) but not below", async () => {
    const at120 = scripted(token("at-120", 120), devices());
    await client(at120.fetch).watchLastSync();
    const ttl = ((await kvEntries())[0]?.expiration ?? 0) - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(55);
    expect(ttl).toBeLessThanOrEqual(61);
    await env.OAUTH_KV.delete((await kvEntries())[0]?.name ?? "");
    const at119 = scripted(token("at-119", 119), devices());
    await client(at119.fetch).watchLastSync();
    expect(await kvEntries()).toEqual([]);
  });

  it("still answers when the KV write fails (e.g. concurrent refresh rate limit)", async () => {
    const failingKv = { get: () => Promise.resolve(null), put: () => Promise.reject(new Error("KV PUT failed: 429")),
      delete: () => Promise.resolve() } as unknown as KVNamespace;
    const { fetch, calls } = scripted(token(), devices({ deviceVersion: "Pixel Watch 3", lastSyncTime: "2026-10-20T20:19:09Z" }));
    expect(await client(fetch, [], undefined, failingKv).watchLastSync()).toBe("2026-10-20T20:19:09Z");
    expect(calls[1]?.headers.authorization).toBe("Bearer at-1");
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
    expect(calls[1]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      range: { startTime: "2026-10-20T18:00:00Z", endTime: "2026-10-20T21:00:00Z" }, windowSize: "60s" });
  });

  it("returns every point across two pages with the same range and windowSize", async () => {
    const { fetch, calls } = scripted(token(),
      json({ rollupDataPoints: [item(18, 70, 72, 68)], nextPageToken: "a+b/c=" }),
      json({ rollupDataPoints: [item(25, 71, 73, 69)] }));
    expect(await client(fetch).rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 300)).toEqual([
      { ts: Date.UTC(2026, 9, 20, 20, 18) / 1000, avg: 70, min: 68, max: 72 },
      { ts: Date.UTC(2026, 9, 20, 20, 25) / 1000, avg: 71, min: 69, max: 73 },
    ]);
    const body = { range: { startTime: "2026-10-20T18:00:00Z", endTime: "2026-10-20T21:00:00Z" }, windowSize: "300s" };
    expect(calls.slice(1).map((call): unknown => JSON.parse(call.body))).toEqual([body, { ...body, pageToken: "a+b/c=" }]);
    expect(calls.slice(1).every((call) => call.url === `${API}/dataTypes/heart-rate/dataPoints:rollUp` && call.method === "POST")).toBe(true);
  });

  it.each([false, true])("caps pagination at 10 pages (more pages: %s), including empty pages", async (more) => {
    const { fetch, calls } = scripted(token(), ...Array.from({ length: 10 }, (_, i) => json({
      ...(i === 9 ? { rollupDataPoints: [item(25, 71, 73, 69)] } : {}),
      ...(i < 9 || more ? { nextPageToken: `page-${String(i + 2)}` } : {}),
    })));
    const result = client(fetch).rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 60);
    if (more) await expect(result).rejects.toThrow("Heart-rate rollUp exceeded 10 pages");
    else expect(await result).toEqual([{ ts: Date.UTC(2026, 9, 20, 20, 25) / 1000, avg: 71, min: 69, max: 73 }]);
    expect(calls).toHaveLength(11);
  });

  it("T23 AC2 drops points unless timestamp and all three HR values are finite numbers", async () => {
    const valid = item(25, 0, 0, 0);
    const invalid = [null, {}, { ...valid, heartRate: undefined }, { ...valid, heartRate: null },
      { ...valid, startTime: "not-a-date" },
      ...["beatsPerMinuteAvg", "beatsPerMinuteMin", "beatsPerMinuteMax"].flatMap((field) =>
        [undefined, null, "61", true, "overflow", "-overflow"].map((value) => ({
          ...valid, heartRate: { ...valid.heartRate, [field]: value },
        }))),
    ];
    const body = JSON.stringify({ rollupDataPoints: [...invalid, valid] })
      .replaceAll('"overflow"', "1e400").replaceAll('"-overflow"', "-1e400");
    const { fetch } = scripted(token(), () => new Response(body));
    expect(await client(fetch).rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 60))
      .toEqual([{ ts: Date.UTC(2026, 9, 20, 20, 25) / 1000, avg: 0, min: 0, max: 0 }]);
  });

  it("returns [] for an empty response and supports other minute windows", async () => {
    const { fetch, calls } = scripted(token(), json({}), json({ rollupDataPoints: [] }));
    const c = client(fetch);
    expect(await c.rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 300)).toEqual([]);
    expect(await c.rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 3600)).toEqual([]);
    expect((JSON.parse(calls[1]?.body ?? "") as { windowSize: string }).windowSize).toBe("300s");
    expect((JSON.parse(calls[2]?.body ?? "") as { windowSize: string }).windowSize).toBe("3600s");
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
    await expect(c.rollUpHeartRate("2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", 60)).rejects.toThrow(RangeError);
    const bad: [string, string][] = [["not-a-date", "2026-10-01T03:00:00Z"], ["2026-10-01", "2026-10-01T03:00:00Z"],
      ["2026-02-30T00:00:00Z", "2026-03-01T03:00:00Z"], ["2026-10-01T00:00:00Z", "2026-10-01T25:00:00Z"]];
    for (const [a, b] of bad) {
      await expect(c.rollUpHeartRate(a, b, 60)).rejects.toThrow(RangeError);
    }
    for (const w of [-60, Number.NaN, Number.POSITIVE_INFINITY, 60.5]) {
      await expect(c.rollUpHeartRate("2026-10-01T00:00:00Z", "2026-10-01T03:00:00Z", w)).rejects.toThrow(RangeError);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects endpoints finer than a millisecond instead of truncating them", async () => {
    const { fetch, calls } = scripted();
    await expect(client(fetch).rollUpHeartRate("2026-10-01T00:00:00Z", "2026-10-15T00:00:00.000001Z", 60)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("accepts RFC 3339 endpoints with an offset", async () => {
    const { fetch, calls } = scripted(token(), json({ rollupDataPoints: [] }));
    await client(fetch).rollUpHeartRate("2026-10-20T20:00:00+02:00", "2026-10-20T23:00:00+02:00", 60);
    expect(calls).toHaveLength(2);
  });

  it("retries with the same body", async () => {
    const { fetch, calls } = scripted(token(), json({}, 500), json({ rollupDataPoints: [] }));
    await client(fetch).rollUpHeartRate("2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 60);
    expect(calls[1]?.body).toBe(calls[2]?.body);
    expect(calls[2]?.headers["content-type"]).toContain("application/json");
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

  it.each(["0", "2", "10", "11", "86400", "9".repeat(400)])("T23 AC6 caps Retry-After %s at 10 seconds for token and API retries", async (ra) => {
    const sleeps: number[] = [];
    const retry = json({}, 429, { "retry-after": ra });
    const { fetch, calls } = scripted(retry, retry, retry, token(), retry, retry, retry, devices());
    expect(await client(fetch, sleeps).watchLastSync()).toBeNull();
    expect(sleeps).toEqual(Array<number>(6).fill(Math.min(Number(ra) * 1000, 10_000)));
    expect(calls).toHaveLength(8);
  });

  it.each(["-1", "1.5", "garbage", "Wed, 21 Oct 2026 10:00:00 GMT", ""])("T23 AC6 keeps exponential fallback for Retry-After %s", async (ra) => {
    const sleeps: number[] = [];
    const retry = json({}, 503, { "retry-after": ra });
    const { fetch } = scripted(token(), retry, retry, retry, devices());
    await client(fetch, sleeps).watchLastSync();
    expect(sleeps).toEqual([500, 1000, 2000]);
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

  it("treats every 403 as an ordinary API failure without retrying", async () => {
    const scope = scripted(token(), json({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403));
    await expect(client(scope.fetch).watchLastSync()).rejects.toThrow("Google API 403");
    expect(scope.calls).toHaveLength(2);
    const other = scripted(json({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCOUNT_NOT_LINKED" }] } }, 403));
    await expect(client(other.fetch).watchLastSync()).rejects.toThrow("Google API 403");
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
      { deviceVersion: "Google Pixel Watch 3", lastSyncTime: "2026-10-20T20:19:09Z", batteryLevel: 68 },
      { deviceVersion: "Google Pixel Watch 4" },
      { deviceVersion: "Google Pixel Watch 2", lastSyncTime: "2026-10-20T20:19:08.999999Z" },
    ));
    expect(await client(fetch).watchLastSync()).toBe("2026-10-20T20:19:09Z");
  });

  it("compares sub-millisecond precision in either order", async () => {
    const a = { deviceVersion: "Pixel Watch 3", lastSyncTime: "2026-10-20T20:19:09.000001Z" };
    const b = { deviceVersion: "Pixel Watch 2", lastSyncTime: "2026-10-20T20:19:09.000002Z" };
    for (const order of [[a, b], [b, a]]) {
      const { fetch } = scripted(token(), devices(...order));
      expect(await client(fetch).watchLastSync()).toBe("2026-10-20T20:19:09.000002Z");
      const { keys } = await env.OAUTH_KV.list();
      await Promise.all(keys.map((k) => env.OAUTH_KV.delete(k.name)));
    }
  });

  it("returns null when no watch has synced", async () => {
    const { fetch } = scripted(token(), devices({ deviceVersion: "MobileTrack", lastSyncTime: "2026-10-21T00:00:00Z" }, { deviceVersion: "Pixel Watch" }));
    expect(await client(fetch).watchLastSync()).toBeNull();
  });
});


describe("T36 AC1 hourly steps", () => {
  const start = "2026-10-01T00:00:00Z";
  const end = "2026-10-02T00:00:00Z";
  // Wire shape: https://developers.google.com/health/aggregate-data (steps rollUp).
  it("posts 3600s windows and parses countSum, including strings and zero without an offset", async () => {
    const point = (countSum: unknown, startTime: unknown = start) => ({ startTime, steps: { countSum } });
    const { fetch, calls } = scripted(token(), json({ rollupDataPoints: [
      point("72"), point(0, "2026-10-01T01:00:00Z"), point(-1), point(1.5), point("Infinity"),
      point(""), point(null), point(true), point("no"), point(2, "2026-02-30T00:00:00Z"),
      point(2, "garbage"), point(2, null), {}, null,
    ] }));
    expect(await client(fetch).rollUpSteps(start, end)).toEqual([
      { ts: Date.parse(start) / 1000, steps: 72 }, { ts: Date.parse(start) / 1000 + 3600, steps: 0 },
    ]);
    expect(calls[1]).toMatchObject({ url: `${API}/dataTypes/steps/dataPoints:rollUp`, method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer at-1", "content-type": "application/json" }) as unknown });
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ range: { startTime: start, endTime: end }, windowSize: "3600s",
      dataSourceFamily: "users/me/dataSourceFamilies/google-wearables" });
  });

  it("validates the range before fetching, allowing exactly 14 elapsed days", async () => {
    const { fetch, calls } = scripted(token(), json({}));
    const c = client(fetch);
    for (const [a, b] of [[start, start], [end, start], ["bad", end], [start, "2026-10-15T00:00:00.001Z"],
      [start, "2026-10-15T00:00:00.000001Z"]]) {
      await expect(c.rollUpSteps(a, b)).rejects.toThrow(RangeError);
    }
    expect(calls).toHaveLength(0);
    expect(await c.rollUpSteps(start, "2026-10-15T00:00:00Z")).toEqual([]);
  });

  it("retries the same request and rejects unexpected paging and API errors", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = scripted(token(), json({}, 503), json({ rollupDataPoints: [], nextPageToken: "more" }), json({}, 403));
    const c = client(fetch, sleeps);
    await expect(c.rollUpSteps(start, end)).rejects.toThrow(/paging/i);
    expect(calls[1]?.body).toBe(calls[2]?.body);
    expect(sleeps).toEqual([500]);
    await expect(c.rollUpSteps(start, end)).rejects.toThrow("Google API 403");
  });
});
