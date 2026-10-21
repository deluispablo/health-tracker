import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { AppDeps, ConnectorEnv } from "../app";
import { audit } from "../lib/audit";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize ${name}</title>
<h1>Allow ${name} to read your health data?</h1>
<p>${details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}
Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
<p>Scope: ${details.scope.map(escape).join(" ")}</p>
<button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form></html>`;
}

export function allowedEmail(token: unknown, env: Pick<ConnectorEnv, "GOOGLE_CLIENT_ID" | "ALLOWED_EMAIL">, now: number): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    // The ID token comes directly from Google's TLS token endpoint (OIDC §3.1.3.7).
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (claims === null || typeof claims !== "object" || Array.isArray(claims)) return null;
    const c = claims as Record<string, unknown>;
    return (c.iss === "https://accounts.google.com" || c.iss === "accounts.google.com")
      && c.aud === env.GOOGLE_CLIENT_ID && typeof c.exp === "number" && c.exp > now
      && c.email_verified === true && typeof c.email === "string"
      && c.email.toLowerCase() === env.ALLOWED_EMAIL.toLowerCase() ? c.email.toLowerCase() : null;
  } catch { return null; }
}

export async function login(request: Request, env: ConnectorEnv, deps: AppDeps, ctx: ExecutionContext): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) throw new Error("OAuth provider unavailable");
  const started = Date.now();
  const url = new URL(request.url);
  const refusal = (reason: string) => {
    audit(ctx, env.DB, { kind: "auth", name: `refused:${reason}`, started, error: reason });
  };
  try {
    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        const original = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(original);
        const consent = await oauth.beginConsent(original);
        consent.headers.set("Content-Type", "text/html; charset=utf-8");
        return new Response(consentPage(details, consent.handle), { headers: consent.headers });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      let form: FormData;
      try { form = await request.formData(); }
      catch { throw new AuthorizationError("invalid_request", { description: "Invalid consent form" }); }
      const handle = form.get("handle");
      const decision = form.get("decision");
      if (typeof handle !== "string" || (decision !== "allow" && decision !== "deny")) {
        throw new AuthorizationError("invalid_request", { description: "Invalid consent form" });
      }
      if (decision === "deny") {
        const denied = await oauth.denyConsent(request, handle);
        refusal("consent_denied");
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle);
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      target.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${env.PUBLIC_ORIGIN}/oauth/google/callback`, response_type: "code", scope: "openid email",
        code_challenge_method: "S256", code_challenge: challenge, prompt: "select_account", state: upstream.state }).toString();
      upstream.headers.set("Location", target.toString());
      return new Response(null, { status: 302, headers: upstream.headers });
    }

    if (request.method !== "GET") return new Response(null, { status: 405 });
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
    const deny = (reason: string) => {
      refusal(reason);
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    };
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) return deny("google_error");
    let email: string | null;
    try {
      const response = await deps.fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${env.PUBLIC_ORIGIN}/oauth/google/callback`, code_verifier: data.verifier }),
      });
      if (!response.ok) return deny("google_exchange");
      const tokens: unknown = await response.json();
      email = allowedEmail(tokens !== null && typeof tokens === "object" && "id_token" in tokens ? tokens.id_token : undefined, env, deps.now());
    } catch { return deny("google_exchange"); }
    if (!email) return deny("identity");
    const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: email,
      metadata: {}, scope: ["health:read"], props: { email } });
    audit(ctx, env.DB, { kind: "auth", name: "grant", started });
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      refusal("invalid_request");
      return new Response("Invalid authorization request. Please start again.", {
        status: 400, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    throw error;
  }
}
