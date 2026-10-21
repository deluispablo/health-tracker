import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleScheduled, route } from "../src/app";
import { encryptSecret } from "../src/lib/crypto";

const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-21T04:30:27Z");
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const appEnv = () => ({
  DB: env.DB, OAUTH_KV: env.OAUTH_KV, USER_TZ: "Europe/Madrid", WEBHOOK_SECRET: "Bearer hook-secret-0123456789",
  GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", ALLOWED_EMAIL: "owner@example.com", TOKEN_ENC_KEY: KEY,
});

interface Call { url: string; method: string; body: string }
function google(rollup: unknown[] = []) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, body: await req.text() });
    if (req.url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "at", expires_in: 3599 });
    if (req.url.endsWith("dataPoints:rollUp")) return Response.json({ rollupDataPoints: rollup });
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, calls };
}
const deps = (fetch: typeof globalThis.fetch) => ({ fetch, now: () => NOW, sleep: () => Promise.resolve() });

async function storeRefreshToken() {
  const { iv, ciphertext } = await encryptSecret(KEY, "refresh-token");
  await env.DB.prepare("INSERT INTO secret_blob (name, iv, ciphertext, updated_at) VALUES ('google_refresh_token', ?, ?, 1)")
    .bind(new Uint8Array(iv), new Uint8Array(ciphertext)).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch(["sync_pending", "sync_state", "metric_minute", "daily_summary", "tracker_daily", "secret_blob", "oauth_state"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const { keys } = await env.OAUTH_KV.list();
  await Promise.all(keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("AC1 five-minute cron", () => {
  it("drains the queue with the stored token, then recomputes the summaries for local D-2..D", async () => {
    await storeRefreshToken();
    await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES ('heart-rate', ?, ?, 'UPSERT', ?)")
      .bind(at("2026-10-20T21:00:00Z"), at("2026-10-20T21:01:00Z"), NOW - 60).run();
    const g = google([{ startTime: "2026-10-20T21:00:00Z", endTime: "2026-10-20T21:01:00Z", heartRate: { beatsPerMinuteAvg: 61, beatsPerMinuteMin: 60, beatsPerMinuteMax: 62 } }]);
    await handleScheduled("*/5 * * * *", appEnv(), deps(g.fetch));
    expect(g.calls.map((c) => new URL(c.url).pathname)).toEqual(["/token", "/v4/users/me/dataTypes/heart-rate/dataPoints:rollUp"]);
    expect((await env.DB.prepare("SELECT metric, ts, value FROM metric_minute").all()).results).toEqual([{ metric: "hr", ts: at("2026-10-20T21:00:00Z"), value: 61 }]);
    expect((await env.DB.prepare("SELECT local_date, hr_wear_min, computed_at FROM daily_summary ORDER BY local_date").all()).results).toEqual([
      { local_date: "2026-10-19", hr_wear_min: 0, computed_at: NOW }, { local_date: "2026-10-20", hr_wear_min: 1, computed_at: NOW },
      { local_date: "2026-10-21", hr_wear_min: 0, computed_at: NOW }]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first()).toEqual({ n: 0 });
  });

  it("skips Google entirely without a stored token but still recomputes", async () => {
    await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES ('heart-rate', 0, 60, 'UPSERT', 1)").run();
    const g = google();
    await handleScheduled("*/5 * * * *", appEnv(), deps(g.fetch));
    expect(g.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM daily_summary").first()).toEqual({ n: 3 });
  });

  it("uses the local date of USER_TZ: just after local midnight the window moves forward", async () => {
    // 22:30Z on 20 Oct is 00:30 on 21 Oct in Madrid.
    await handleScheduled("*/5 * * * *", appEnv(), { ...deps(google().fetch), now: () => at("2026-10-20T22:30:00Z") });
    expect((await env.DB.prepare("SELECT local_date FROM daily_summary ORDER BY local_date").all()).results.map((r) => r.local_date))
      .toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
  });

  it("rejects and skips the summaries when the stored token cannot be decrypted", async () => {
    await storeRefreshToken();
    const g = google();
    await expect(handleScheduled("*/5 * * * *", { ...appEnv(), TOKEN_ENC_KEY: btoa(String.fromCharCode(...new Uint8Array(32))) }, deps(g.fetch))).rejects.toThrow();
    expect(g.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM daily_summary").first()).toEqual({ n: 0 });
  });

  it("propagates a drain failure so the run is marked failed", async () => {
    await storeRefreshToken();
    await env.DB.prepare("CREATE TRIGGER fail_q BEFORE UPDATE ON sync_pending BEGIN SELECT RAISE(ABORT, 'x'); END").run();
    await env.DB.prepare("INSERT INTO sync_pending (data_type, start_ts, end_ts, operation, received_at) VALUES ('heart-rate', 0, 60, 'UPSERT', 1)").run();
    const failing = async () => Promise.resolve(new Response("down", { status: 503 }));
    try {
      await expect(handleScheduled("*/5 * * * *", appEnv(), deps(failing))).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_q").run();
    }
  });
});

describe("AC2 daily cron", () => {
  it("enqueues the 48-hour reconcile, purges expired OAuth states and does not call Google", async () => {
    await env.DB.prepare("INSERT INTO oauth_state (state, verifier, expires_at) VALUES ('old', 'v', ?), ('edge', 'v', ?), ('live', 'v', ?)")
      .bind(NOW - 1, NOW, NOW + 600).run();
    const g = google();
    await handleScheduled("30 4 * * *", appEnv(), deps(g.fetch));
    expect(g.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_pending").first()).toEqual({ n: 9 });
    expect((await env.DB.prepare("SELECT state FROM oauth_state ORDER BY state").all()).results).toEqual([{ state: "edge" }, { state: "live" }]);
  });

  it("rejects an unknown cron expression", async () => {
    await expect(handleScheduled("0 0 * * *", appEnv(), deps(google().fetch))).rejects.toThrow();
  });
});

describe("AC3 routes", () => {
  const req = (method: string, path: string, init: RequestInit = {}) => new Request(`https://health.example.com${path}`, { method, ...init });

  it("sends Google webhooks to the webhook handler (Authorization checked first)", async () => {
    const res = await route(req("POST", "/webhooks/google", { body: "[]" }), appEnv(), deps(google().fetch));
    expect(res.status).toBe(401);
    const ok = await route(req("POST", "/webhooks/google", { body: '{"type":"verification"}', headers: { authorization: "Bearer hook-secret-0123456789" } }),
      appEnv(), deps(google().fetch));
    expect(ok.status).toBe(200);
  });

  it("starts and finishes the Google connect flow", async () => {
    const start = await route(req("GET", "/google/connect"), appEnv(), deps(google().fetch));
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location") ?? "").searchParams.get("redirect_uri")).toBe("https://health.example.com/google/callback");
    const back = await route(req("GET", "/google/callback?state=nope&code=x"), appEnv(), deps(google().fetch));
    expect(back.status).toBe(400);
  });

  it("answers 405 for a wrong method on a known path and 404 elsewhere", async () => {
    for (const [method, path] of [["GET", "/webhooks/google"], ["POST", "/google/connect"], ["POST", "/google/callback"]] as const) {
      expect((await route(req(method, path), appEnv(), deps(google().fetch))).status).toBe(405);
    }
    for (const path of ["/privacy/", "/privacy/x", "/unknown", "/webhooks", "/google", "/webhooks/google/x", "/mcp"]) {
      expect((await route(req("GET", path), appEnv(), deps(google().fetch))).status).toBe(404);
    }
  });
});

describe("T20 public pages", () => {
  const getPage = (path: string, method = "GET") => route(
    new Request(`https://pixel.deluispablo.com${path}`, { method }), appEnv(), deps(google().fetch),
  );

  it("AC1 serves the Spanish private single-user homepage with a privacy link", async () => {
    const res = await getPage("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const text of ['lang="es"', "Pixel Health", "privado", "datos de salud personales", "único usuario", 'href="/privacy"']) {
      expect(html).toContain(text);
    }
  });

  it("AC2 serves the complete privacy policy", async () => {
    const res = await getPage("/privacy");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const text of [
      "único usuario personal: su propio desarrollador", "Google Health", "solo lectura",
      "cuenta de Cloudflare del propio propietario", "eventos que registra el propietario: café, alcohol y tabaco",
      "solo salen hacia el asistente que conectes y autorices", "cuando tú, como propietario, lo solicites",
      "nunca se venden, se comparten ni se utilizan para publicidad", "revocar el acceso",
      'href="https://myaccount.google.com/permissions"', "deluispablo@gmail.com",
    ]) expect(html).toContain(text);
  });

  it.each(["/", "/privacy"])("AC3/AC4 serves GET and bodyless HEAD with matching cache and security headers at %s", async (path) => {
    const get = await getPage(path);
    const head = await getPage(path, "HEAD");
    expect(head.status).toBe(get.status);
    expect(await head.text()).toBe("");
    expect([...head.headers]).toEqual([...get.headers]);
    expect(get.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(get.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const html = await get.text();
    expect(html).not.toMatch(/<script\b|<(?:link|img|iframe)\b|\bsrc=/i);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("AC3 rejects %s on both pages", async (method) => {
    for (const path of ["/", "/privacy"]) {
      expect((await getPage(path, method)).status).toBe(405);
    }
  });
});
