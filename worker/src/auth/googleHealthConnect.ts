import { decryptSecret, encryptSecret } from "../lib/crypto";
import { upsertRows, upsertStatements } from "../lib/d1";

interface GoogleConnectEnv {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAIL: string;
  TOKEN_ENC_KEY: string;
}
interface GoogleConnectDeps { fetch?: typeof fetch; now?: () => number }

const SCOPES = ["activity_and_fitness", "health_metrics_and_measurements", "sleep", "settings"]
  .map((scope) => `https://www.googleapis.com/auth/googlehealth.${scope}.readonly`);

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowedIdentity(token: unknown, env: GoogleConnectEnv, now: number): boolean {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
  try {
    // The ID token comes directly from Google's TLS token endpoint (OIDC §3.1.3.7).
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return object(claims) && (claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com")
      && claims.aud === env.GOOGLE_CLIENT_ID && typeof claims.exp === "number" && claims.exp > now
      && claims.email_verified === true && typeof claims.email === "string"
      && claims.email.toLowerCase() === env.ALLOWED_EMAIL.toLowerCase();
  } catch { return false; }
}

export async function startGoogleConnect(request: Request, env: GoogleConnectEnv, deps: GoogleConnectDeps = {}): Promise<Response> {
  try {
    const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    await upsertRows(env.DB, "oauth_state", ["state", "verifier", "expires_at"], ["state"], [[state, verifier, now + 600]]);
    const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    consent.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${new URL(request.url).origin}/google/callback`,
      response_type: "code", scope: [...SCOPES, "openid", "email"].join(" "), access_type: "offline", prompt: "consent",
      code_challenge_method: "S256", code_challenge: challenge, state,
    }).toString();
    return Response.redirect(consent.toString(), 302);
  } catch { return new Response("Connection unavailable", { status: 500 }); }
}

export async function finishGoogleConnect(request: Request, env: GoogleConnectEnv, deps: GoogleConnectDeps = {}): Promise<Response> {
  const url = new URL(request.url);
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const state = url.searchParams.get("state");
  if (!state) return new Response("Invalid state", { status: 400 });
  let consumed: { verifier: string } | null;
  try {
    // One atomic delete prevents replay, including simultaneous callbacks and failed exchanges.
    consumed = await env.DB.prepare("DELETE FROM oauth_state WHERE state = ? AND expires_at > ? RETURNING verifier")
      .bind(state, now).first<{ verifier: string }>();
  } catch { return new Response("Connection unavailable", { status: 500 }); }
  if (!consumed) return new Response("Invalid state", { status: 400 });
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.has("error")) return new Response("Invalid callback", { status: 400 });

  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/google/callback`, code_verifier: consumed.verifier,
      }),
    });
  } catch { return new Response("Google unavailable", { status: 502 }); }
  if (!response.ok) return new Response("Invalid token response", { status: 400 });
  let tokens: unknown;
  try { tokens = await response.json(); }
  catch { return new Response("Invalid token response", { status: 400 }); }
  if (!object(tokens) || typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
    return new Response("Invalid token response", { status: 400 });
  }
  if (!allowedIdentity(tokens.id_token, env, now)) return new Response("Account forbidden", { status: 403 });
  const scopes = typeof tokens.scope === "string" ? tokens.scope.split(" ") : [];
  if (!SCOPES.every((scope) => scopes.includes(scope))) return new Response("Missing scopes", { status: 400 });
  try {
    const { iv, ciphertext } = await encryptSecret(env.TOKEN_ENC_KEY, tokens.refresh_token);
    await env.DB.batch([
      ...upsertStatements(env.DB, "secret_blob", ["name", "iv", "ciphertext", "updated_at"], ["name"],
        [["google_refresh_token", iv, ciphertext, now]]),
      env.DB.prepare("UPDATE sync_pending SET attempts = 0 WHERE attempts >= 5"),
    ]);
  } catch { return new Response("Connection unavailable", { status: 500 }); }
  return new Response("Google connected");
}

export async function loadGoogleRefreshToken(env: Pick<GoogleConnectEnv, "DB" | "TOKEN_ENC_KEY">): Promise<string | null> {
  const row = await env.DB.prepare("SELECT iv, ciphertext FROM secret_blob WHERE name = ?")
    .bind("google_refresh_token").first<{ iv: number[]; ciphertext: number[] }>();
  return row ? decryptSecret(env.TOKEN_ENC_KEY, new Uint8Array(row.iv).buffer, new Uint8Array(row.ciphertext).buffer) : null;
}
