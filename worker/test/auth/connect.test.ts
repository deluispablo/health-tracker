import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { finishGoogleConnect, loadGoogleRefreshToken, startGoogleConnect } from "../../src/auth/googleHealthConnect";
import { decryptSecret, encryptSecret } from "../../src/lib/crypto";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const ORIGIN = "https://health.example.test";
const SCOPES = ["activity_and_fitness", "health_metrics_and_measurements", "sleep", "settings"]
  .map((s) => `https://www.googleapis.com/auth/googlehealth.${s}.readonly`);

const authEnv = () => ({
  DB: env.DB, OAUTH_KV: env.OAUTH_KV, GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "csecret",
  ALLOWED_EMAIL: "owner@example.com", TOKEN_ENC_KEY: KEY,
});

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (claims: Record<string, unknown>) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;

interface Call { url: string; body: string }
function tokenEndpoint(response: Record<string, unknown>, status = 200) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, body: await req.text() });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}
const goodToken = (email = "owner@example.com", verified = true) => ({
  access_token: "ya29.secret-access", refresh_token: "1//secret-refresh", expires_in: 3599,
  id_token: idToken({ email, email_verified: verified, aud: "cid.apps.googleusercontent.com" }),
});

async function start(): Promise<URL> {
  const res = await startGoogleConnect(new Request(`${ORIGIN}/google/connect`), authEnv());
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}
const callback = (params: Record<string, string>) => new Request(`${ORIGIN}/google/callback?${new URLSearchParams(params).toString()}`);
const stored = async () => (await env.DB.prepare("SELECT name FROM secret_blob").all<{ name: string }>()).results;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM secret_blob").run();
  const { keys } = await env.OAUTH_KV.list();
  await Promise.all(keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("AC1 consent redirect", () => {
  it("redirects to Google with scopes, offline access, PKCE and a 10-min state", async () => {
    const loc = await start();
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = loc.searchParams;
    expect(q.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/google/callback`);
    expect(q.get("response_type")).toBe("code");
    expect(new Set(q.get("scope")?.split(" "))).toEqual(new Set([...SCOPES, "openid", "email"]));
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const { keys } = await env.OAUTH_KV.list();
    expect(keys).toHaveLength(1);
    const ttl = (keys[0]?.expiration ?? 0) - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(540);
    expect(ttl).toBeLessThanOrEqual(601);
  });

  it("uses a fresh state and challenge each time", async () => {
    const a = await start();
    const b = await start();
    expect(a.searchParams.get("state")).not.toBe(b.searchParams.get("state"));
    expect(a.searchParams.get("code_challenge")).not.toBe(b.searchParams.get("code_challenge"));
  });
});

describe("AC2 callback", () => {
  it("exchanges the code with the PKCE verifier and stores the token encrypted", async () => {
    const state = (await start()).searchParams.get("state") ?? "";
    const challenge = (await env.OAUTH_KV.list()).keys.length;
    expect(challenge).toBe(1);
    const google = tokenEndpoint(goodToken());
    const res = await finishGoogleConnect(callback({ state, code: "auth-code" }), authEnv(), { fetch: google.fetch });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/connected/i);
    expect(google.calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    const form = Object.fromEntries(new URLSearchParams(google.calls[0]?.body));
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "auth-code", client_id: "cid.apps.googleusercontent.com",
      client_secret: "csecret", redirect_uri: `${ORIGIN}/google/callback` });
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    const row = await env.DB.prepare("SELECT name, length(iv) AS iv, ciphertext FROM secret_blob").first<{ name: string; iv: number; ciphertext: ArrayBuffer }>();
    expect(row?.name).toBe("google_refresh_token");
    expect(row?.iv).toBe(12);
    expect(new TextDecoder().decode(row?.ciphertext)).not.toContain("secret-refresh");
    expect(await loadGoogleRefreshToken(authEnv())).toBe("1//secret-refresh");
  });

  it("verifies the PKCE challenge matches the verifier sent", async () => {
    const loc = await start();
    const google = tokenEndpoint(goodToken());
    await finishGoogleConnect(callback({ state: loc.searchParams.get("state") ?? "", code: "c" }), authEnv(), { fetch: google.fetch });
    const verifier = new URLSearchParams(google.calls[0]?.body).get("code_verifier") ?? "";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    expect(b64url(String.fromCharCode(...digest))).toBe(loc.searchParams.get("code_challenge"));
  });
});

describe("AC3 rejections", () => {
  it("rejects missing, unknown and replayed state without storing", async () => {
    const google = tokenEndpoint(goodToken());
    expect((await finishGoogleConnect(callback({ code: "c" }), authEnv(), { fetch: google.fetch })).status).toBe(400);
    expect((await finishGoogleConnect(callback({ state: "unknown", code: "c" }), authEnv(), { fetch: google.fetch })).status).toBe(400);
    const state = (await start()).searchParams.get("state") ?? "";
    expect((await finishGoogleConnect(callback({ state, code: "c" }), authEnv(), { fetch: google.fetch })).status).toBe(200);
    await env.DB.prepare("DELETE FROM secret_blob").run();
    expect((await finishGoogleConnect(callback({ state, code: "c" }), authEnv(), { fetch: google.fetch })).status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("rejects a Google error, a missing code and a token without refresh_token", async () => {
    const s1 = (await start()).searchParams.get("state") ?? "";
    expect((await finishGoogleConnect(callback({ state: s1, error: "access_denied" }), authEnv(), { fetch: tokenEndpoint(goodToken()).fetch })).status).toBe(400);
    const s2 = (await start()).searchParams.get("state") ?? "";
    expect((await finishGoogleConnect(callback({ state: s2 }), authEnv(), { fetch: tokenEndpoint(goodToken()).fetch })).status).toBe(400);
    const s3 = (await start()).searchParams.get("state") ?? "";
    const noRefresh = { ...goodToken(), refresh_token: undefined };
    expect((await finishGoogleConnect(callback({ state: s3, code: "c" }), authEnv(), { fetch: tokenEndpoint(noRefresh).fetch })).status).toBe(400);
    const s4 = (await start()).searchParams.get("state") ?? "";
    expect((await finishGoogleConnect(callback({ state: s4, code: "c" }), authEnv(), { fetch: tokenEndpoint({ error: "invalid_grant" }, 400).fetch })).status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("rejects another, unverified or differently-cased lookalike email with 403", async () => {
    for (const tok of [goodToken("intruder@example.com"), goodToken("owner@example.com", false), goodToken("owner@example.com.evil")]) {
      const state = (await start()).searchParams.get("state") ?? "";
      expect((await finishGoogleConnect(callback({ state, code: "c" }), authEnv(), { fetch: tokenEndpoint(tok).fetch })).status).toBe(403);
    }
    const state = (await start()).searchParams.get("state") ?? "";
    expect((await finishGoogleConnect(callback({ state, code: "c" }), authEnv(), { fetch: tokenEndpoint(goodToken("Owner@Example.com")).fetch })).status).toBe(200);
    await env.DB.prepare("DELETE FROM secret_blob WHERE 1").run();
    expect(await stored()).toEqual([]);
  });

  it("rejects an id_token for another client", async () => {
    const state = (await start()).searchParams.get("state") ?? "";
    const tok = { ...goodToken(), id_token: idToken({ email: "owner@example.com", email_verified: true, aud: "someone-else" }) };
    expect((await finishGoogleConnect(callback({ state, code: "c" }), authEnv(), { fetch: tokenEndpoint(tok).fetch })).status).toBe(403);
    expect(await stored()).toEqual([]);
  });
});

describe("AC4 encryption", () => {
  it("round-trips, uses a fresh IV and fails closed on tampering or a wrong key", async () => {
    const a = await encryptSecret(KEY, "hello");
    const b = await encryptSecret(KEY, "hello");
    expect(new Uint8Array(a.iv)).not.toEqual(new Uint8Array(b.iv));
    expect(await decryptSecret(KEY, a.iv, a.ciphertext)).toBe("hello");
    const bad = new Uint8Array(a.ciphertext);
    bad[0] ^= 1;
    await expect(decryptSecret(KEY, a.iv, bad.buffer)).rejects.toThrow();
    await expect(decryptSecret(OTHER_KEY, a.iv, a.ciphertext)).rejects.toThrow();
    await expect(encryptSecret(btoa("short"), "x")).rejects.toThrow();
  });

  it("returns null without a stored token and throws on a tampered blob", async () => {
    expect(await loadGoogleRefreshToken(authEnv())).toBeNull();
    const { iv, ciphertext } = await encryptSecret(KEY, "rt");
    const bad = new Uint8Array(ciphertext);
    bad[bad.length - 1] ^= 1;
    await env.DB.prepare("INSERT INTO secret_blob(name, iv, ciphertext, updated_at) VALUES ('google_refresh_token', ?, ?, 1)").bind(iv, bad.buffer).run();
    await expect(loadGoogleRefreshToken(authEnv())).rejects.toThrow();
  });
});

describe("AC5 no leakage", () => {
  it("keeps tokens and the key out of responses and KV", async () => {
    const loc = await start();
    const res = await finishGoogleConnect(callback({ state: loc.searchParams.get("state") ?? "", code: "c" }), authEnv(), { fetch: tokenEndpoint(goodToken()).fetch });
    const text = await res.text();
    for (const secret of ["secret-refresh", "secret-access", KEY, "csecret"]) expect(text).not.toContain(secret);
    expect(loc.toString()).not.toContain("csecret");
    const { keys } = await env.OAUTH_KV.list();
    const values = await Promise.all(keys.map((k) => env.OAUTH_KV.get(k.name)));
    for (const v of values) for (const secret of ["secret-refresh", "secret-access", KEY]) expect(v ?? "").not.toContain(secret);
  });
});
