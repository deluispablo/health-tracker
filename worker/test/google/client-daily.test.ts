import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createGoogleClient } from "../../src/google/client";

interface Call { url: string; method: string; contentType: string; body: string }
const API = "https://health.googleapis.com/v4/users/me";

function scripted(...responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, contentType: req.headers.get("content-type") ?? "", body: await req.text() });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${req.url}`);
    return next();
  };
  return { fetch, calls };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = json({ access_token: "at-1", expires_in: 3599 });
const client = (fetch: typeof globalThis.fetch) => createGoogleClient({ fetch, kv: env.OAUTH_KV, clientId: "c", clientSecret: "s", refreshToken: "r",
  sleep: () => Promise.resolve() });

beforeEach(async () => {
  const { keys } = await env.OAUTH_KV.list();
  await Promise.all(keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("AC1 reconcile", () => {
  it("pages through :reconcile with the sample-time filter for sample types", async () => {
    const hr = (bpm: string) => ({ heartRate: { sampleTime: { physicalTime: "2026-10-20T21:32:05Z", utcOffset: "7200s" }, beatsPerMinute: bpm } });
    const { fetch, calls } = scripted(token, json({ dataPoints: [hr("67")], nextPageToken: "p/2" }), json({}), json({ dataPoints: [hr("68")] }));
    const c = client(fetch);
    expect(await c.reconcile("heart-rate", "2026-10-20T21:00:00Z", "2026-10-20T22:00:00Z")).toEqual([hr("67")]);
    const urls = calls.slice(1).map((x) => new URL(x.url));
    expect(urls[0]?.pathname).toBe("/v4/users/me/dataTypes/heart-rate/dataPoints:reconcile");
    expect(urls[0]?.searchParams.get("filter")).toBe(
      'heart_rate.sample_time.physical_time >= "2026-10-20T21:00:00Z" AND heart_rate.sample_time.physical_time < "2026-10-20T22:00:00Z"');
    expect(urls[1]?.searchParams.get("pageToken")).toBe("p/2");
  });

  it("filters interval types (sleep, exercise) on interval end time", async () => {
    const { fetch, calls } = scripted(token, json({}), json({ dataPoints: [] }));
    const c = client(fetch);
    expect(await c.reconcile("sleep", "2026-10-10T00:00:00Z", "2026-10-21T00:00:00Z")).toEqual([]);
    expect(await c.reconcile("exercise", "2026-10-10T00:00:00Z", "2026-10-21T00:00:00Z")).toEqual([]);
    expect(new URL(calls[1]?.url ?? "").searchParams.get("filter")).toBe(
      'sleep.interval.end_time >= "2026-10-10T00:00:00Z" AND sleep.interval.end_time < "2026-10-21T00:00:00Z"');
    expect(new URL(calls[2]?.url ?? "").searchParams.get("filter")).toBe(
      'exercise.interval.end_time >= "2026-10-10T00:00:00Z" AND exercise.interval.end_time < "2026-10-21T00:00:00Z"');
  });

  it("rejects bad or reversed instants without calling Google", async () => {
    const { fetch, calls } = scripted();
    const c = client(fetch);
    await expect(c.reconcile("heart-rate", "2026-10-21T00:00:00Z", "2026-10-20T00:00:00Z")).rejects.toThrow(RangeError);
    await expect(c.reconcile("heart-rate", "yesterday", "2026-10-20T00:00:00Z")).rejects.toThrow(RangeError);
    await expect(c.reconcile("Heart Rate", "2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z")).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("AC2 dailyRollUp", () => {
  const day = (d: number, value: Record<string, unknown>) => ({
    civilStartTime: { date: { year: 2026, month: 10, day: d }, time: {} },
    civilEndTime: { date: { year: 2026, month: 10, day: d + 1 }, time: {} },
    ...value,
  });

  it("posts civil date range and returns {date, value} oldest first", async () => {
    const { fetch, calls } = scripted(token, json({ rollupDataPoints: [day(19, { steps: { countSum: "1493" } }), day(18, { steps: { countSum: "0" } })] }));
    const out = await client(fetch).dailyRollUp("steps", "2026-10-18", "2026-10-20");
    expect(out).toEqual([
      { date: "2026-10-18", value: { countSum: "0" } },
      { date: "2026-10-19", value: { countSum: "1493" } },
    ]);
    expect(calls[1]?.url).toBe(`${API}/dataTypes/steps/dataPoints:dailyRollUp`);
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.contentType).toContain("application/json");
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      range: { start: { date: { year: 2026, month: 10, day: 18 } }, end: { date: { year: 2026, month: 10, day: 20 } } } });
  });

  it("maps the type's camelCase payload key and returns [] when empty", async () => {
    const { fetch } = scripted(token, json({ rollupDataPoints: [day(19, { activeZoneMinutes: { sumInMinutes: "12" } })] }), json({}));
    const c = client(fetch);
    expect(await c.dailyRollUp("active-zone-minutes", "2026-10-19", "2026-10-20")).toEqual([{ date: "2026-10-19", value: { sumInMinutes: "12" } }]);
    expect(await c.dailyRollUp("steps", "2026-10-19", "2026-10-20")).toEqual([]);
  });

  it("enforces 14 days for heart-rate, active-minutes and calories, 90 otherwise, and valid dates", async () => {
    const ok = scripted(token, json({}), json({}));
    await client(ok.fetch).dailyRollUp("heart-rate", "2026-10-01", "2026-10-15");
    await client(ok.fetch).dailyRollUp("steps", "2026-07-01", "2026-09-29");
    const { fetch, calls } = scripted();
    const c = client(fetch);
    for (const t of ["heart-rate", "active-minutes", "total-calories", "active-energy-burned"]) {
      await expect(c.dailyRollUp(t, "2026-10-01", "2026-10-16")).rejects.toThrow(RangeError);
    }
    await expect(c.dailyRollUp("steps", "2026-07-01", "2026-09-30")).rejects.toThrow(RangeError);
    const bad: [string, string][] = [["2026-10-20", "2026-10-20"], ["2026-10-21", "2026-10-20"], ["2026-02-30", "2026-03-02"], ["2026-1-5", "2026-01-09"]];
    for (const [a, b] of bad) {
      await expect(c.dailyRollUp("steps", a, b)).rejects.toThrow(RangeError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("AC3 daily list", () => {
  it("lists daily types with a civil date filter across pages", async () => {
    const rhr = (d: number, bpm: string) => ({ dailyRestingHeartRate: { date: { year: 2026, month: 10, day: d }, beatsPerMinute: bpm } });
    const { fetch, calls } = scripted(token, json({ dataPoints: [rhr(7, "65")], nextPageToken: "n" }), json({ dataPoints: [rhr(6, "64")] }));
    expect(await client(fetch).listDaily("daily-resting-heart-rate", "2026-10-05", "2026-10-08")).toEqual([rhr(7, "65"), rhr(6, "64")]);
    const u = new URL(calls[1]?.url ?? "");
    expect(u.pathname).toBe("/v4/users/me/dataTypes/daily-resting-heart-rate/dataPoints");
    expect(u.searchParams.get("filter")).toBe('daily_resting_heart_rate.date >= "2026-10-05" AND daily_resting_heart_rate.date < "2026-10-08"');
    expect(new URL(calls[2]?.url ?? "").searchParams.get("pageToken")).toBe("n");
  });
});
