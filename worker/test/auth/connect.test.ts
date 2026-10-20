import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { finishGoogleConnect, loadGoogleRefreshToken, startGoogleConnect } from "../../src/auth/googleHealthConnect";
import { decryptSecret, encryptSecret } from "../../src/lib/crypto";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const ORIGIN = "https://health.example.test";
const CLIENT = "cid.apps.googleusercontent.com";
const NOW = 1_792_600_000;
const SCOPES = ["activity_and_fitness", "health_metrics_and_measurements", "sleep", "settings"]
  .map((s) => `https://www.googleapis.com/auth/googlehealth.${s}.readonly`);

const authEnv = (db: D1Database = env.DB) => ({
  DB: db, GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: "c&s=cret+/", ALLOWED_EMAIL: "owner@example.com", TOKEN_ENC_KEY: KEY,
});

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (claims: Record<string, unknown>) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
const claims = (over: Record<string, unknown> = {}) =>
  ({ iss: "https://accounts.google.com", aud: CLIENT, exp: NOW + 3600, email: "owner@example.com", email_verified: true, ...over });
const goodToken = (over: Record<string, unknown> = {}) => ({
  access_token: "ya29.secret-access", refresh_token: "1//secret-refresh", expires_in: 3599, id_token: idToken(claims()), ...over,
});

interface Call { url: string; method: string; contentType: string; body: string }
function google(response: unknown, status = 200) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, contentType: req.headers.get("content-type") ?? "", body: await req.text() });
    return new Response(typeof response === "string" ? response : JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}
const deps = (fetch: typeof globalThis.fetch, now = NOW) => ({ fetch, now: () => now });

async function start(now = NOW): Promise<URL> {
  const res = await startGoogleConnect(new Request(`${ORIGIN}/google/connect`), authEnv(), { now: () => now });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}
const stateOf = async (now = NOW) => (await start(now)).searchParams.get("state") ?? "";
const callback = (params: Record<string, string>) => new Request(`${ORIGIN}/google/callback?${new URLSearchParams(params).toString()}`);
const blobs = async () => (await env.DB.prepare("SELECT name, hex(iv) AS iv, hex(ciphertext) AS ct, updated_at FROM secret_blob ORDER BY name").all()).results;

const logs: string[] = [];
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM secret_blob").run();
  await env.DB.prepare("DELETE FROM oauth_state").run();
  logs.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  }
});
afterEach(() => { vi.restoreAllMocks(); });

describe("AC1 consent redirect", () => {
  it("redirects to Google with scopes, offline access, PKCE and a state stored for 10 min", async () => {
    const loc = await start();
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = loc.searchParams;
    expect(q.get("client_id")).toBe(CLIENT);
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/google/callback`);
    expect(q.get("response_type")).toBe("code");
    expect(new Set(q.get("scope")?.split(" "))).toEqual(new Set([...SCOPES, "openid", "email"]));
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const rows = (await env.DB.prepare("SELECT state, expires_at FROM oauth_state").all<{ state: string; expires_at: number }>()).results;
    expect(rows).toEqual([{ state: q.get("state"), expires_at: NOW + 600 }]);
  });

  it("uses a fresh state and challenge each time", async () => {
    const a = await start();
    const b = await start();
    expect(a.searchParams.get("state")).not.toBe(b.searchParams.get("state"));
    expect(a.searchParams.get("code_challenge")).not.toBe(b.searchParams.get("code_challenge"));
  });
});

describe("AC2 callback", () => {
  it("posts an encoded form with the PKCE verifier and stores the token encrypted", async () => {
    const loc = await start();
    const g = google(goodToken());
    const res = await finishGoogleConnect(callback({ state: loc.searchParams.get("state") ?? "", code: "a/b+c=d" }), authEnv(), deps(g.fetch));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/connected/i);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(g.calls[0]?.method).toBe("POST");
    expect(g.calls[0]?.contentType).toContain("application/x-www-form-urlencoded");
    const form = Object.fromEntries(new URLSearchParams(g.calls[0]?.body));
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "a/b+c=d", client_id: CLIENT,
      client_secret: "c&s=cret+/", redirect_uri: `${ORIGIN}/google/callback` });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.code_verifier)));
    expect(b64url(String.fromCharCode(...digest))).toBe(loc.searchParams.get("code_challenge"));
    const rows = await blobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "google_refresh_token", updated_at: NOW });
    expect((rows[0] as { iv: string }).iv).toHaveLength(24);
    expect(await loadGoogleRefreshToken(authEnv())).toBe("1//secret-refresh");
  });

  it("replaces the token on reconnect and leaves other blobs alone", async () => {
    await env.DB.prepare("INSERT INTO secret_blob(name, iv, ciphertext, updated_at) VALUES ('other', x'01', x'02', 5)").run();
    await finishGoogleConnect(callback({ state: await stateOf(), code: "c" }), authEnv(), deps(google(goodToken()).fetch));
    const second = google(goodToken({ refresh_token: "1//second" }));
    await finishGoogleConnect(callback({ state: await stateOf(), code: "c" }), authEnv(), deps(second.fetch, NOW + 50));
    expect(await loadGoogleRefreshToken(authEnv())).toBe("1//second");
    const rows = await blobs();
    expect(rows.map((r) => r.name)).toEqual(["google_refresh_token", "other"]);
    expect(rows[0]?.updated_at).toBe(NOW + 50);
    expect(rows[1]).toEqual({ name: "other", iv: "01", ct: "02", updated_at: 5 });
  });
});

describe("AC3 rejections keep storage unchanged", () => {
  let before: unknown[];
  beforeEach(async () => {
    const { iv, ciphertext } = await encryptSecret(KEY, "1//existing");
    await env.DB.prepare("INSERT INTO secret_blob(name, iv, ciphertext, updated_at) VALUES ('google_refresh_token', ?, ?, 7)").bind(iv, ciphertext).run();
    before = await blobs();
  });
  const unchanged = async () => { expect(await blobs()).toEqual(before); expect(await loadGoogleRefreshToken(authEnv())).toBe("1//existing"); };

  it("rejects missing, unknown and expired state without calling Google", async () => {
    const g = google(goodToken());
    expect((await finishGoogleConnect(callback({ code: "c" }), authEnv(), deps(g.fetch))).status).toBe(400);
    expect((await finishGoogleConnect(callback({ state: "unknown", code: "c" }), authEnv(), deps(g.fetch))).status).toBe(400);
    const old = await stateOf(NOW);
    expect((await finishGoogleConnect(callback({ state: old, code: "c" }), authEnv(), deps(g.fetch, NOW + 601))).status).toBe(400);
    expect(g.calls).toHaveLength(0);
    await unchanged();
  });

  it("consumes the state before the exchange, whatever the outcome", async () => {
    const cases: [Record<string, string>, unknown, number][] = [
      [{ error: "access_denied" }, goodToken(), 400],
      [{}, goodToken(), 400],
      [{ code: "c" }, goodToken({ id_token: idToken(claims({ email: "intruder@example.com" })) }), 403],
      [{ code: "c" }, { error: "invalid_grant" }, 400],
    ];
    for (const [params, response, status] of cases) {
      const state = await stateOf();
      const g = google(response, status === 400 && "error" in (response as object) ? 400 : 200);
      expect((await finishGoogleConnect(callback({ state, ...params }), authEnv(), deps(g.fetch))).status).toBe(status);
      const replay = google(goodToken());
      expect((await finishGoogleConnect(callback({ state, code: "c" }), authEnv(), deps(replay.fetch))).status).toBe(400);
      expect(replay.calls).toHaveLength(0);
      await unchanged();
    }
  });

  it("lets only one of two concurrent callbacks with the same state through", async () => {
    const state = await stateOf();
    const [a, b] = await Promise.all([
      finishGoogleConnect(callback({ state, code: "c" }), authEnv(), deps(google(goodToken({ refresh_token: "1//a" })).fetch)),
      finishGoogleConnect(callback({ state, code: "c" }), authEnv(), deps(google(goodToken({ refresh_token: "1//b" })).fetch)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it("rejects bad refresh_token values and malformed token responses with 400", async () => {
    for (const response of [goodToken({ refresh_token: undefined }), goodToken({ refresh_token: "" }), goodToken({ refresh_token: null }),
      goodToken({ refresh_token: 5 }), goodToken({ refresh_token: {} }), "not json", "[1,2]"]) {
      expect((await finishGoogleConnect(callback({ state: await stateOf(), code: "c" }), authEnv(), deps(google(response).fetch))).status).toBe(400);
    }
    const throwing = () => Promise.reject(new TypeError("network down"));
    expect((await finishGoogleConnect(callback({ state: await stateOf(), code: "c" }), authEnv(), deps(throwing))).status).toBe(502);
    await unchanged();
  });

  it("rejects identity problems with 403", async () => {
    const bad = [
      { id_token: undefined }, { id_token: "garbage" }, { id_token: "a.b" },
      { id_token: idToken(claims({ email: "intruder@example.com" })) },
      { id_token: idToken(claims({ email: "owner@example.com.evil" })) },
      { id_token: idToken(claims({ email: undefined })) }, { id_token: idToken(claims({ email: 5 })) },
      { id_token: idToken(claims({ email_verified: false })) }, { id_token: idToken(claims({ email_verified: "true" })) },
      { id_token: idToken(claims({ email_verified: undefined })) },
      { id_token: idToken(claims({ aud: "someone-else" })) }, { id_token: idToken(claims({ aud: [CLIENT, "x"] })) },
      { id_token: idToken(claims({ iss: "https://evil.example.com" })) },
      { id_token: idToken(claims({ exp: NOW - 1 })) }, { id_token: idToken(claims({ exp: undefined })) },
    ];
    for (const over of bad) {
      expect((await finishGoogleConnect(callback({ state: await stateOf(), code: "c" }), authEnv(), deps(google(goodToken(over)).fetch))).status).toBe(403);
      await unchanged();
    }
    const okIss = idToken(claims({ iss: "accounts.google.com", email: "Owner@Example.com" }));
    expect((await finishGoogleConnect(callback({ state: await stateOf(), code: "c" }), authEnv(), deps(google(goodToken({ id_token: okIss })).fetch))).status).toBe(200);
  });

  it("does not report success when storing fails", async () => {
    const failing = { prepare: (q: string) => env.DB.prepare(q), batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
    const state = await stateOf();
    const res = await finishGoogleConnect(callback({ state, code: "c" }), authEnv(failing), deps(google(goodToken()).fetch));
    expect(res.status).toBe(500);
    await unchanged();
  });
});

describe("AC4 encryption", () => {
  it("round-trips, uses a fresh IV and fails closed on tampering, wrong or malformed keys", async () => {
    const a = await encryptSecret(KEY, "hello");
    const b = await encryptSecret(KEY, "hello");
    expect(new Uint8Array(a.iv)).not.toEqual(new Uint8Array(b.iv));
    expect(await decryptSecret(KEY, a.iv, a.ciphertext)).toBe("hello");
    const bad = new Uint8Array(a.ciphertext);
    bad[0] ^= 1;
    await expect(decryptSecret(KEY, a.iv, bad.buffer)).rejects.toThrow();
    await expect(decryptSecret(OTHER_KEY, a.iv, a.ciphertext)).rejects.toThrow();
    for (const k of [btoa("short"), btoa(String.fromCharCode(...new Uint8Array(33))), btoa(String.fromCharCode(...new Uint8Array(16))), "not base64!", ""]) {
      await expect(encryptSecret(k, "x")).rejects.toThrow();
    }
  });

  it("loads null without a token and throws on a wrong key or edited IV/ciphertext", async () => {
    expect(await loadGoogleRefreshToken(authEnv())).toBeNull();
    const { iv, ciphertext } = await encryptSecret(KEY, "rt");
    const put = (i: ArrayBuffer, c: ArrayBuffer) => env.DB.prepare("INSERT OR REPLACE INTO secret_blob(name, iv, ciphertext, updated_at) VALUES ('google_refresh_token', ?, ?, 1)").bind(i, c).run();
    await put(iv, ciphertext);
    await expect(loadGoogleRefreshToken({ ...authEnv(), TOKEN_ENC_KEY: OTHER_KEY })).rejects.toThrow();
    const editedIv = new Uint8Array(iv);
    editedIv[0] ^= 1;
    await put(editedIv.buffer, ciphertext);
    await expect(loadGoogleRefreshToken(authEnv())).rejects.toThrow();
    await put(iv, ciphertext.slice(0, 10));
    await expect(loadGoogleRefreshToken(authEnv())).rejects.toThrow();
  });
});

describe("AC5 no leakage", () => {
  it("keeps tokens, client secret and key out of responses, headers, KV and logs on every path", async () => {
    const secrets = ["secret-refresh", "secret-access", KEY, "c&s=cret+/"];
    const loc = await start();
    const responses = [
      await finishGoogleConnect(callback({ state: loc.searchParams.get("state") ?? "", code: "c" }), authEnv(), deps(google(goodToken()).fetch)),
      await finishGoogleConnect(callback({ state: await stateOf(), code: "c" }), authEnv(), deps(google(goodToken({ id_token: idToken(claims({ email: "x@y.z" })) })).fetch)),
      await finishGoogleConnect(callback({ state: await stateOf(), code: "c" }), authEnv(), deps(google({ error: "invalid_grant", refresh_token: "1//secret-refresh" }, 400).fetch)),
    ];
    for (const res of responses) {
      const text = await res.text();
      const headers = JSON.stringify([...res.headers.entries()]);
      for (const s of secrets) { expect(text).not.toContain(s); expect(headers).not.toContain(s); }
    }
    expect(loc.toString()).not.toContain("cret");
    expect((await env.OAUTH_KV.list()).keys).toEqual([]);
    for (const line of logs) for (const s of secrets) expect(line).not.toContain(s);
  });
});
