import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createGoogleClient } from "../../src/google/client";
// @ts-expect-error Vite loads this Markdown as text; there is no raw-module declaration.
import architectureSource from "../../../docs/architecture.md?raw";

function scripted(...pages: unknown[]) {
  const calls: URL[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    expect(request.method).toBe("GET");
    calls.push(new URL(request.url));
    if (!pages.length) throw new Error("unexpected fetch");
    return Promise.resolve(Response.json(pages.shift()));
  };
  const client = createGoogleClient({ fetch, kv: env.OAUTH_KV, clientId: "c", clientSecret: "s", refreshToken: "r",
    sleep: () => Promise.resolve() });
  return { client, calls };
}
const point = (id: string, startTime: unknown) => ({ dataPointName: id, exercise: { interval: { startTime } } });

beforeEach(async () => { await env.OAUTH_KV.put("google_access_token", "test-access"); });

describe("T10f AC1 exercise reconcile", () => {
  it("widens civil start bounds by 14 hours and follows empty and omitted pages with the same GET filter", async () => {
    const a = point("east", "2026-10-20T14:00:00+14:00");
    const b = point("west", "2026-10-20T11:59:59-12:00");
    const { client, calls } = scripted({ dataPoints: [a], nextPageToken: "a+b/c=" },
      { dataPoints: [], nextPageToken: "empty" }, { nextPageToken: "omitted" }, { dataPoints: [b, point("outside-last-page", "2026-10-21T00:00:00Z")] });
    expect(await client.reconcile("exercise", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z")).toEqual([a, b]);
    expect(calls.map((u) => u.pathname)).toEqual(Array<string>(4).fill("/v4/users/me/dataTypes/exercise/dataPoints:reconcile"));
    expect(calls.map((u) => u.searchParams.get("pageToken"))).toEqual([null, "a+b/c=", "empty", "omitted"]);
    expect(calls.map((u) => u.searchParams.get("filter"))).toEqual(Array<string>(4).fill(
      'exercise.interval.civil_start_time >= "2026-10-19T10:00:00" AND exercise.interval.civil_start_time < "2026-10-21T14:00:00"'));
  });

  it("rounds civil bounds outward from offset instants but cuts at exact milliseconds", async () => {
    const lower = point("lower", "2026-10-20T09:00:00.500Z");
    const fraction = point("fraction", "2026-10-21T00:00:00.250123456+14:00");
    const { client, calls } = scripted({ dataPoints: [point("before", "2026-10-20T09:00:00.499Z"), lower,
      fraction, point("upper", "2026-10-20T10:00:00.500Z"), point("after", "2026-10-20T10:00:00.501Z")] });
    expect(await client.reconcile("exercise", "2026-10-20T11:00:00.500+02:00", "2026-10-20T05:00:00.500-05:00")).toEqual([lower, fraction]);
    expect(calls[0]?.searchParams.get("filter")).toBe(
      'exercise.interval.civil_start_time >= "2026-10-19T19:00:00" AND exercise.interval.civil_start_time < "2026-10-21T00:00:01"');
  });

  it("uses physical startTime, not endTime or civil time, for the half-open cut", async () => {
    const inside = { ...point("inside", "2026-10-20T00:00:00Z"), exercise: { interval: {
      startTime: "2026-10-20T00:00:00Z", endTime: "2026-10-22T00:00:00Z", civilStartTime: "1900-01-01T00:00:00" } } };
    const { client } = scripted({ dataPoints: [point("before", "2026-10-19T23:59:59.999Z"), inside,
      point("upper", "2026-10-21T00:00:00Z")] });
    expect(await client.reconcile("exercise", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z")).toEqual([inside]);
  });

  it("drops missing, malformed, zoneless and impossible returned starts, accepting arbitrary fractional precision", async () => {
    const valid = point("ok", "2026-03-01T00:00:00.123456789Z");
    const bad = [undefined, null, 1793491200, "", "nope", "2026-03-01", "2026-03-01T00:00:00",
      "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-02-28T24:00:00Z", "2026-03-01T00:60:00Z",
      "2026-03-01T00:00:60Z", "2026-03-01T00:00:00+25:00"];
    const { client } = scripted({ dataPoints: [null, {}, { exercise: null }, ...bad.map((t, i) => point(String(i), t)), valid] });
    expect(await client.reconcile("exercise", "2026-02-28T00:00:00Z", "2026-03-02T00:00:00Z")).toEqual([valid]);
  });

  it("keeps request validation and rejects before fetching", async () => {
    const { client, calls } = scripted();
    for (const [start, end] of [["2026-10-20T00:00:00Z", "2026-10-20T00:00:00Z"],
      ["2026-10-21T00:00:00Z", "2026-10-20T00:00:00Z"], ["2026-02-30T00:00:00Z", "2026-03-02T00:00:00Z"],
      ["2026-10-20", "2026-10-21T00:00:00Z"], ["2026-10-20T00:00:00.0001Z", "2026-10-21T00:00:00Z"]]) {
      await expect(client.reconcile("exercise", start, end)).rejects.toThrow(RangeError);
    }
    expect(calls).toEqual([]);
  });

  it("rejects the entire answer when a later page fails", async () => {
    const { client } = scripted({ dataPoints: [point("ok", "2026-10-20T00:00:00Z")], nextPageToken: "missing" });
    await expect(client.reconcile("exercise", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z")).rejects.toThrow();
  });
});

it("T10f AC6 architecture documents the exercise civil filter, exact start cut and health_workouts", () => {
  const architecture = architectureSource as string;
  expect(architecture).toContain("exercise.interval.civil_start_time");
  expect(architecture).toMatch(/14\s*(?:h|hour)/i);
  expect(architecture).toMatch(/startTime|physical start|\[start, end\)/);
  expect(architecture).toContain("health_workouts");
});
