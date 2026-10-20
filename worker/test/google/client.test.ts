import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createGoogleClient, MissingScopeError } from "../../src/google/client";

interface Call { url: string; init: RequestInit | undefined }

/** Scripted fetch: answers each call with the next response and records the request. */
function scripted(...responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(next());
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const token = json({ access_token: "at-1", expires_in: 3599, token_type: "Bearer" });

function client(fetch: typeof globalThis.fetch, sleeps: number[] = []) {
  return createGoogleClient({
    fetch, kv: env.OAUTH_KV, clientId: "cid", clientSecret: "csecret", refreshToken: "rt",
    sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); },
  });
}

beforeEach(async () => {
  const { keys } = await env.OAUTH_KV.list();
  await Promise.all(keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("AC1 token cache", () => {
  it("refreshes once and caches the access token in KV for at most 50 min", async () => {
    const { fetch, calls } = scripted(token, json({ pairedDevices: [] }), json({ pairedDevices: [] }));
    const c = client(fetch);
    await c.watchLastSync();
    await c.watchLastSync();
    const tokenCalls = calls.filter((x) => x.url === "https://oauth2.googleapis.com/token");
    expect(tokenCalls).toHaveLength(1);
    const body = new URLSearchParams(tokenCalls[0]?.init?.body as string);
    expect(Object.fromEntries(body)).toEqual({ grant_type: "refresh_token", refresh_token: "rt", client_id: "cid", client_secret: "csecret" });
    const listed = await env.OAUTH_KV.list();
    expect(listed.keys).toHaveLength(1);
    const exp = listed.keys[0]?.expiration ?? 0;
    expect(exp - Date.now() / 1000).toBeLessThanOrEqual(50 * 60 + 1);
    expect(calls[1]?.init?.headers).toMatchObject({ authorization: "Bearer at-1" });
  });
});

describe("AC2 list", () => {
  it("follows nextPageToken and builds the snake_case time filter", async () => {
    const p = (v: string) => ({ heartRate: { beatsPerMinute: v, sampleTime: { physicalTime: "2026-10-20T20:00:00Z", utcOffset: "7200s" } } });
    const { fetch, calls } = scripted(token, json({ dataPoints: [p("70")], nextPageToken: "n2" }), json({ dataPoints: [p("71")] }));
    const points = await client(fetch).list("heart-rate", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z");
    expect(points).toHaveLength(2);
    const u1 = new URL(calls[1]?.url ?? "");
    const u2 = new URL(calls[2]?.url ?? "");
    expect(u1.pathname).toBe("/v4/users/me/dataTypes/heart-rate/dataPoints");
    expect(u1.searchParams.get("filter")).toBe(
      'heart_rate.sample_time.physical_time >= "2026-10-20T00:00:00Z" AND heart_rate.sample_time.physical_time < "2026-10-21T00:00:00Z"');
    expect(u1.searchParams.get("pageToken")).toBeNull();
    expect(u2.searchParams.get("pageToken")).toBe("n2");
    expect(u2.searchParams.get("filter")).toBe(u1.searchParams.get("filter"));
  });
});

describe("AC3 rollUp", () => {
  it("posts range + windowSize and maps rollupDataPoints", async () => {
    const { fetch, calls } = scripted(token, json({ rollupDataPoints: [
      { startTime: "2026-10-20T20:18:00Z", endTime: "2026-10-20T20:19:00Z", heartRate: { beatsPerMinuteAvg: 77.8, beatsPerMinuteMax: 82, beatsPerMinuteMin: 74 } },
    ] }));
    const r = await client(fetch).rollUp("heart-rate", "2026-10-20T18:00:00Z", "2026-10-20T21:00:00Z", 60);
    expect(r).toEqual([{ ts: Date.UTC(2026, 9, 20, 20, 18) / 1000, avg: 77.8, min: 74, max: 82 }]);
    expect(calls[1]?.url).toBe("https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints:rollUp");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      range: { startTime: "2026-10-20T18:00:00Z", endTime: "2026-10-20T21:00:00Z" }, windowSize: "60s" });
  });

  it("rejects a heart-rate range over 14 days without calling Google", async () => {
    const { fetch, calls } = scripted();
    await expect(client(fetch).rollUp("heart-rate", "2026-10-01T00:00:00Z", "2026-10-15T00:00:01Z", 60)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("AC4 retries and scope errors", () => {
  it("retries 429/5xx up to 3 times with backoff and Retry-After", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = scripted(token, json({}, 429, { "retry-after": "2" }), json({}, 503), json({}, 500), json({ pairedDevices: [] }));
    await client(fetch, sleeps).watchLastSync();
    expect(calls).toHaveLength(5);
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(3);
    expect(sleeps[2] ?? 0).toBeGreaterThan(sleeps[1] ?? 0);
  });

  it("gives up after 3 retries", async () => {
    const { fetch, calls } = scripted(token, json({}, 503), json({}, 503), json({}, 503), json({}, 503));
    await expect(client(fetch).watchLastSync()).rejects.toThrow();
    expect(calls).toHaveLength(5);
  });

  it("throws MissingScopeError on ACCESS_TOKEN_SCOPE_INSUFFICIENT", async () => {
    const { fetch } = scripted(token, json({ error: { code: 403, status: "PERMISSION_DENIED",
      details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403));
    await expect(client(fetch).watchLastSync()).rejects.toBeInstanceOf(MissingScopeError);
  });
});

describe("AC5 paired devices", () => {
  it("returns the watch lastSyncTime and ignores the phone", async () => {
    const { fetch } = scripted(token, json({ pairedDevices: [
      { deviceVersion: "MobileTrack", lastSyncTime: "2026-10-21T00:00:00Z" },
      { deviceVersion: "Google Pixel Watch 3", lastSyncTime: "2026-10-20T20:19:09Z", batteryLevel: 68 },
    ] }));
    expect(await client(fetch).watchLastSync()).toBe("2026-10-20T20:19:09Z");
  });

  it("returns null when no watch is paired", async () => {
    const { fetch } = scripted(token, json({ pairedDevices: [{ deviceVersion: "MobileTrack", lastSyncTime: "2026-10-21T00:00:00Z" }] }));
    expect(await client(fetch).watchLastSync()).toBeNull();
  });
});
