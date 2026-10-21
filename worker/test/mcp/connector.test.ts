import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/app";
import worker from "../../src/index";
import { healthDaily } from "../../src/mcp/tools/daily";
import { healthIntraday } from "../../src/mcp/tools/intraday";
import { healthSleep } from "../../src/mcp/tools/sleep";

const ORIGIN = "https://pixel.test";
const REDIRECT = "https://client.example/callback";
const CLIENT_NAME = "Health <script>alert(1)</script> & reader";
const CLIENT = "connector.apps.googleusercontent.com";
const EMAIL = "owner@example.com";
const VERIFIER = "connector-pkce-verifier-012345678901234567890123456789";
const CLIENT_STATE = "client-state-kept-through-google";
const GOOGLE_ACCESS = "ya29.connector-secret-access";
const GOOGLE_REFRESH = "1//connector-secret-refresh";
type ConnectorEnv = AppEnv & { PUBLIC_ORIGIN: string };
const connectorEnv: ConnectorEnv = {
  ...env, PUBLIC_ORIGIN: ORIGIN, USER_TZ: "Europe/Madrid", WEBHOOK_SECRET: "Bearer connector-hook-secret",
  GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: "connector-client-secret", ALLOWED_EMAIL: EMAIL,
  TOKEN_ENC_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1))),
};
// The existing export infers two fetch arguments; the connector adds the execution context.
const handlers = worker as {
  fetch: (request: Request, env: ConnectorEnv, ctx: ExecutionContext) => Response | Promise<Response>;
  scheduled: (controller: ScheduledController, env: ConnectorEnv, ctx: ExecutionContext) => void | Promise<void>;
};
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const challenge = async (s: string) => b64url(String.fromCharCode(...new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
)));
function idToken(over: Record<string, unknown> = {}) {
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({
    iss: "https://accounts.google.com", aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 3600,
    email: EMAIL, email_verified: true, ...over,
  }))}.sig`;
}
function google(over: Record<string, unknown> = {}, status = 200, refresh: string | undefined = GOOGLE_REFRESH) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const req = new Request(input, init);
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    return Promise.resolve(Response.json({ access_token: GOOGLE_ACCESS, refresh_token: refresh, expires_in: 3600,
      id_token: idToken(over) }, { status }));
  });
}
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await handlers.fetch(new Request(new URL(path, ORIGIN), init), connectorEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const formPost = (path: string, body: URLSearchParams, cookie = "") => request(path, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: ORIGIN }, body: body.toString(),
});
function cookies(res: Response, previous = ""): string {
  const jar = new Map(previous.split("; ").filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p]));
  for (const cookie of res.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    jar.set(pair.slice(0, pair.indexOf("=")), pair);
  }
  return [...jar.values()].join("; ");
}
interface Consent {
  clientId: string; cookie: string; action: string; fields: URLSearchParams;
  buttons: { name: string; value: string; text: string; action: string }[];
}
async function consent(): Promise<Consent> {
  const registered = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  expect(registered.status).toBe(201);
  const client = await registered.json<{ client_id: string; token_endpoint_auth_method: string }>();
  expect(client.client_id).toEqual(expect.any(String));
  expect(client.token_endpoint_auth_method).toBe("none");
  const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code",
    scope: "health:read", state: CLIENT_STATE, code_challenge: await challenge(VERIFIER), code_challenge_method: "S256" });
  const page = await request(`/authorize?${q.toString()}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("x-frame-options")?.toUpperCase()).toBe("DENY");
  expect(page.headers.get("cache-control")).toContain("no-store");
  const cookie = cookies(page);
  expect(cookie).not.toBe("");
  for (const value of page.headers.getSetCookie()) {
    expect(value).toMatch(/;\s*Secure/i);
    expect(value).toMatch(/;\s*HttpOnly/i);
    expect(value).toMatch(/;\s*SameSite=Lax/i);
  }
  const html = await page.text();
  expect(html).toContain("health:read");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain(CLIENT_NAME);
  expect(html).toContain(new URL(REDIRECT).hostname);
  const result: Consent = { clientId: client.client_id, cookie, action: "/authorize", fields: new URLSearchParams(), buttons: [] };
  let button: Consent["buttons"][number] | undefined;
  await new HTMLRewriter()
    .on("form", { element(el) { result.action = el.getAttribute("action") ?? "/authorize"; } })
    .on("form input", { element(el) {
      const name = el.getAttribute("name");
      if (!name || el.hasAttribute("disabled")) return;
      const type = el.getAttribute("type") ?? "text";
      if (["checkbox", "radio"].includes(type) && !el.hasAttribute("checked")) return;
      if (type === "submit") result.buttons.push({ name, value: el.getAttribute("value") ?? "", text: el.getAttribute("value") ?? "", action: el.getAttribute("formaction") ?? result.action });
      else result.fields.append(name, el.getAttribute("value") ?? "");
    } })
    .on("form button", {
      element(el) {
        if (el.getAttribute("type") === "button" || el.hasAttribute("disabled")) return;
        button = { name: el.getAttribute("name") ?? "", value: el.getAttribute("value") ?? "", text: "", action: el.getAttribute("formaction") ?? result.action };
        result.buttons.push(button);
        el.onEndTag(() => { button = undefined; });
      },
      text(chunk) { if (button) button.text += chunk.text; },
    }).transform(new Response(html)).text();
  return result;
}
async function decide(c: Consent, decision: "Allow" | "Deny") {
  const button = c.buttons.find((b) => b.text.trim().toLowerCase() === decision.toLowerCase());
  expect(button, `${decision} submit button`).toBeDefined();
  const fields = new URLSearchParams(c.fields);
  if (button?.name) fields.set(button.name, button.value);
  return formPost(button?.action ?? c.action, fields, c.cookie);
}
async function upstream() {
  const c = await consent();
  const res = await decide(c, "Allow");
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("location") ?? "");
  expect(url.origin).toBe("https://accounts.google.com");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT, response_type: "code",
    redirect_uri: `${ORIGIN}/oauth/google/callback`, code_challenge_method: "S256", prompt: "select_account" });
  expect(new Set(url.searchParams.get("scope")?.split(" "))).toEqual(new Set(["openid", "email"]));
  expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.searchParams.get("state")).toBeTruthy();
  return { ...c, cookie: cookies(res, c.cookie), url };
}
function callback(flow: Awaited<ReturnType<typeof upstream>>, params: Record<string, string> = { code: "google-code" }, cookie = flow.cookie) {
  return request(`/oauth/google/callback?${new URLSearchParams({ state: flow.url.searchParams.get("state") ?? "", ...params }).toString()}`,
    { headers: { cookie } });
}
function clientRedirect(res: Response) {
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("location") ?? "");
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get("state")).toBe(CLIENT_STATE);
  return url;
}
async function authorizedCode() {
  const flow = await upstream();
  const url = clientRedirect(await callback(flow));
  expect(url.searchParams.has("error")).toBe(false);
  expect(url.searchParams.get("code")).toBeTruthy();
  return { ...flow, code: url.searchParams.get("code") ?? "" };
}
function exchange(flow: Awaited<ReturnType<typeof authorizedCode>>, verifier = VERIFIER) {
  return formPost("/oauth/token", new URLSearchParams({ grant_type: "authorization_code", client_id: flow.clientId,
    redirect_uri: REDIRECT, code: flow.code, code_verifier: verifier }));
}
async function accessToken() {
  const res = await exchange(await authorizedCode());
  expect(res.status).toBe(200);
  const body = await res.json<{ access_token: string; token_type: string; scope: string }>();
  expect(body.access_token).toEqual(expect.any(String));
  expect(body.access_token.length).toBeGreaterThan(0);
  expect(body.token_type.toLowerCase()).toBe("bearer");
  expect(body.scope.split(" ")).toContain("health:read");
  return body.access_token;
}
interface Audit { kind: string; name: string; args_json: string | null; ok: number; ms: number; error: string | null }
const audit = async () => (await env.DB.prepare("SELECT kind, name, args_json, ok, ms, error FROM audit_log ORDER BY id").all<Audit>()).results;
function auditFields(row: Audit, ok: number) {
  expect(row.ok).toBe(ok);
  expect(row.ms).toEqual(expect.any(Number));
  expect(row.ms).toBeGreaterThanOrEqual(0);
  if (ok) expect(row.error).toBeNull();
  else expect(row.error).toEqual(expect.any(String));
}
async function refused(res: Response) {
  const url = clientRedirect(res);
  expect(url.searchParams.get("error")).toBe("access_denied");
  expect(url.searchParams.has("code")).toBe(false);
  expect(url.searchParams.has("access_token")).toBe(false);
  const rows = await audit();
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("auth");
  expect(rows[0].name).toMatch(/^refused:/);
  auditFields(rows[0], 0);
}
interface RpcResult {
  protocolVersion?: string;
  capabilities?: { tools?: object };
  tools?: { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; openWorldHint: boolean } }[];
  content?: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}
interface Rpc { jsonrpc: string; id: number; result?: RpcResult; error?: { code: number; message: string } }
async function rpc(token: string, method: string, params: object, id = 1): Promise<Rpc> {
  const res = await request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`,
    "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  expect(res.status).toBe(200);
  expect(res.headers.has("mcp-session-id")).toBe(false);
  const text = await res.text();
  const messages: Rpc[] = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n\r?\n/).filter((frame) => /^data:/m.test(frame)).map((frame) => JSON.parse(
      frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"),
    ) as Rpc)
    : [JSON.parse(text) as Rpc];
  const message = messages.find((m) => m.id === id);
  if (!message) throw new Error(`Missing JSON-RPC response for id ${String(id)}`);
  expect(message).toMatchObject({ jsonrpc: "2.0", id });
  return message;
}
async function initialize(token: string) {
  const msg = await rpc(token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "connector-contract", version: "1.0" } });
  expect(msg.error).toBeUndefined();
  expect(msg.result?.protocolVersion).toEqual(expect.any(String));
  expect(msg.result?.capabilities?.tools).toBeDefined();
}
async function toolAudit(name: string, args: object, ok: number, before: number) {
  const rows = await audit();
  expect(rows).toHaveLength(before + 1);
  const row = rows[rows.length - 1];
  expect(row).toMatchObject({ kind: "tool", name });
  expect(JSON.parse(row.args_json ?? "null")).toEqual(args);
  auditFields(row, ok);
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["audit_log", "sleep_stage", "sleep_session", "metric_daily", "metric_minute", "daily_summary", "tracker_daily",
    "sync_pending", "sync_state", "secret_blob", "oauth_state"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  const { keys } = await env.OAUTH_KV.list();
  await Promise.all(keys.map((key) => env.OAUTH_KV.delete(key.name)));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("AC1 Bearer challenge and discovery", () => {
  it.each([undefined, "Bearer bad-token"])("challenges %s and links the protected resource to its issuer", async (authorization) => {
    const res = await request("/mcp", { headers: authorization ? { authorization } : {} });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer\b/i);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(metadataUrl).toBeTruthy();
    expect(new URL(metadataUrl ?? "").origin).toBe(ORIGIN);
    const metadata = await request(metadataUrl ?? "");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  });

  it("advertises PKCE S256, CIMD, public clients and DCR", async () => {
    const res = await request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const metadata = await res.json<{ code_challenge_methods_supported: string[]; token_endpoint_auth_methods_supported: string[] }>();
    expect(metadata).toMatchObject({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`,
      client_id_metadata_document_supported: true });
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
  });
});

describe("AC2 owner authorization and refusals", () => {
  it("registers a public client, consents, checks Google PKCE, exchanges a code and audits the grant", async () => {
    const fetch = google({ email: "Owner@Example.com" });
    await accessToken();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const sent = new Request(input, init);
    const form = new URLSearchParams(await sent.text());
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "google-code", client_id: CLIENT,
      client_secret: connectorEnv.GOOGLE_CLIENT_SECRET, redirect_uri: `${ORIGIN}/oauth/google/callback` });
    expect(form.get("code_verifier")).toBeTruthy();
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "auth", name: "grant" });
    auditFields(rows[0], 1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM secret_blob").first("n")).toBe(0);
    for (const secret of [GOOGLE_ACCESS, GOOGLE_REFRESH, EMAIL, connectorEnv.GOOGLE_CLIENT_SECRET]) expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("grants the owner when Google returns no refresh token", async () => {
    google({}, 200, undefined);
    await accessToken();
    expect((await audit()).map((r) => r.name)).toEqual(["grant"]);
  });

  it("sends the upstream verifier matching Google's challenge", async () => {
    const fetch = google();
    const flow = await upstream();
    clientRedirect(await callback(flow));
    const [input, init] = fetch.mock.calls[0];
    const form = new URLSearchParams(await new Request(input, init).text());
    expect(await challenge(form.get("code_verifier") ?? "")).toBe(flow.url.searchParams.get("code_challenge"));
  });

  it.each([
    ["another account", { email: "intruder@example.com" }], ["unverified email", { email_verified: false }],
    ["wrong issuer", { iss: "https://evil.example" }], ["wrong audience", { aud: "another-client" }], ["expired identity", { exp: 1 }],
  ])("refuses %s with access_denied and an audit row", async (_name, claims) => {
    google(claims);
    await refused(await callback(await upstream()));
  });

  it("refuses a Google error without exchanging a token", async () => {
    const fetch = google();
    await refused(await callback(await upstream(), { error: "access_denied" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses denied consent before contacting Google", async () => {
    const fetch = google();
    await refused(await decide(await consent(), "Deny"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a failed Google exchange", async () => {
    google({}, 400);
    await refused(await callback(await upstream()));
  });

  it.each(["missing", "wrong"])("issues no code with %s browser binding cookies", async (binding) => {
    const fetch = google();
    const flow = await upstream();
    const other = binding === "wrong" ? await upstream() : undefined;
    const res = await callback(flow, { code: "stolen-code" }, other?.cookie ?? "");
    expect(res.status).toBe(400);
    expect(res.headers.has("location")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    const rows = await audit();
    expect(rows.map((r) => [r.kind, r.name])).toEqual([["auth", "refused:invalid_request"]]);
    auditFields(rows[0], 0);
  });

  it("issues no second code for a reused callback state", async () => {
    const fetch = google();
    const flow = await authorizedCode();
    const replay = await callback(flow);
    expect(replay.status).toBe(400);
    expect(replay.headers.has("location")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await audit()).map((r) => r.name)).toEqual(["grant", "refused:invalid_request"]);
  });

  it("rejects the wrong client PKCE verifier at the token endpoint", async () => {
    google();
    const res = await exchange(await authorizedCode(), "wrong-verifier-012345678901234567890123456789012345");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; access_token?: string }>();
    expect(body.error).toBe("invalid_grant");
    expect(body.access_token).toBeUndefined();
  });
});

describe("AC3 stateless read tools and audit", () => {
  it("initializes and lists exactly the three described read-only tools", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    const msg = await rpc(token, "tools/list", {});
    expect(msg.error).toBeUndefined();
    expect(msg.result?.tools?.map((t) => t.name).sort()).toEqual(["health_daily", "health_intraday", "health_sleep"]);
    for (const tool of msg.result?.tools ?? []) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
  });

  it("calls each tool on seeded data, returns both JSON forms and writes one audit row per call", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_summary (local_date, rhr, steps, computed_at) VALUES ('2026-10-20', 61, 8123, 1)"),
      env.DB.prepare("INSERT INTO sleep_session (source_id, start_ts, end_ts, tz_offset_min, local_date, minutes_asleep, updated_at) VALUES ('night', 1792443600, 1792472400, 120, '2026-10-20', 420, 1)"),
      env.DB.prepare("INSERT INTO sleep_stage (session_id, start_ts, end_ts, stage) VALUES ('night', 1792443600, 1792447200, 'DEEP')"),
      env.DB.prepare("INSERT INTO metric_minute (metric, ts, tz_offset_min, value) VALUES ('hr', 1792476000, 120, 62)"),
    ]);
    const daily = { start: "2026-10-20", end: "2026-10-20", metrics: ["rhr", "steps"] };
    const sleep = { start: "2026-10-20", end: "2026-10-20" };
    const intraday = { metric: "hr", date: "2026-10-20", resolution: "5m" } as const;
    const cases = [
      ["health_daily", daily, await healthDaily(env.DB, daily)], ["health_sleep", sleep, await healthSleep(env.DB, sleep)],
      ["health_intraday", intraday, await healthIntraday(env.DB, intraday)],
    ] as const;
    for (const [name, args, expected] of cases) {
      const before = (await audit()).length;
      const msg = await rpc(token, "tools/call", { name, arguments: args });
      expect(msg.error).toBeUndefined();
      expect(msg.result?.isError).not.toBe(true);
      expect(msg.result?.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
      expect(msg.result?.structuredContent).toEqual(expected);
      await toolAudit(name, args, 1, before);
    }
  });

  it.each([
    ["health_daily", { start: "2026-02-30", end: "2026-03-01" }, "date must be a real calendar date in YYYY-MM-DD format"],
    ["health_daily", { start: "2026-01-01", end: "2026-04-01" }, "range must contain 1 to 90 dates"],
    ["health_sleep", { start: "2026-01-01", end: "2026-02-01" }, "range must contain 1 to 31 dates"],
    ["health_intraday", { metric: "hr", date: "2026-02-30", resolution: "1m" }, "date must be a real YYYY-MM-DD date between 2000-01-01 and 2099-12-31"],
    ["health_daily", { start: "2026-10-20", end: "2026-10-20", metrics: ["nope"] }, "metrics must be distinct names from DAILY_COLUMNS"],
    ["health_daily", { start: "2026-10-20", end: "2026-10-20", metrics: [] }, "metrics must be distinct names from DAILY_COLUMNS"],
    ["health_daily", { start: "2026-10-20", end: "2026-10-20", metrics: ["rhr", "rhr"] }, "metrics must be distinct names from DAILY_COLUMNS"],
    ["health_intraday", { metric: "steps", date: "2026-10-20", resolution: "1m" }, "metric must be hr"],
    ["health_intraday", { metric: "hr", date: "2026-10-20", resolution: "2m" }, "resolution must be 1m, 5m or 1h"],
  ])("returns the RangeError and failed audit for %s %j", async (name, args, message) => {
    google();
    const token = await accessToken();
    await initialize(token);
    const before = (await audit()).length;
    const msg = await rpc(token, "tools/call", { name, arguments: args });
    expect(msg.error).toBeUndefined();
    expect(msg.result).toMatchObject({ isError: true, content: [{ type: "text", text: message }] });
    await toolAudit(name, args, 0, before);
  });

  it.each([
    ["health_daily", { end: "2026-10-20" }], ["health_sleep", { start: 123, end: "2026-10-20" }],
    ["health_intraday", { metric: "hr", date: "2026-10-20" }],
  ])("rejects structurally invalid arguments for %s", async (name, args) => {
    google();
    const token = await accessToken();
    await initialize(token);
    const msg = await rpc(token, "tools/call", { name, arguments: args });
    expect(Boolean(msg.error) || msg.result?.isError === true).toBe(true);
  });

  it("keeps a successful tool response when the audit write fails", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    await env.DB.prepare("CREATE TRIGGER fail_connector_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
    try {
      const args = { start: "2026-10-20", end: "2026-10-20" };
      const msg = await rpc(token, "tools/call", { name: "health_daily", arguments: args });
      expect(msg.error).toBeUndefined();
      expect(msg.result?.isError).not.toBe(true);
      expect(msg.result?.structuredContent).toEqual(await healthDaily(env.DB, args));
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_connector_audit").run();
    }
  });
});

describe("AC4 existing routes and both crons through the default export", () => {
  it("keeps unsigned webhooks unauthorized", async () => {
    expect((await request("/webhooks/google", { method: "POST", body: "[]" })).status).toBe(401);
  });

  it("keeps Google connect public and redirects to Google", async () => {
    const res = await request("/google/connect");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/google/callback`);
  });

  it("keeps an unknown Google connect callback state rejected", async () => {
    expect((await request("/google/callback?state=x&code=y")).status).toBe(400);
  });

  it("enqueues the daily 48-hour reconcile without Google", async () => {
    const fetch = google();
    const ctx = createExecutionContext();
    const before = Math.floor(Date.now() / 1000);
    await handlers.scheduled({ cron: "30 4 * * *" } as ScheduledController, connectorEnv, ctx);
    await waitOnExecutionContext(ctx);
    const rows = (await env.DB.prepare("SELECT data_type, start_ts, end_ts, operation FROM sync_pending ORDER BY data_type").all<{
      data_type: string; start_ts: number; end_ts: number; operation: string;
    }>()).results;
    expect(rows.map((r) => r.data_type)).toEqual(["active-zone-minutes", "daily-heart-rate-variability", "daily-oxygen-saturation",
      "daily-respiratory-rate", "daily-resting-heart-rate", "daily-sleep-temperature-derivations", "heart-rate", "sleep", "steps"]);
    for (const row of rows) {
      expect(row.operation).toBe("UPSERT");
      expect(row.end_ts - row.start_ts).toBe(48 * 3600);
      expect(row.end_ts).toBeGreaterThanOrEqual(Math.floor(before / 60) * 60);
      expect(row.end_ts).toBeLessThanOrEqual(Math.floor(Date.now() / 60000) * 60);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("recomputes the local day's summary on the five-minute cron without a stored Google token", async () => {
    const fetch = google();
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: connectorEnv.USER_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    await env.DB.prepare("INSERT INTO metric_daily (metric, local_date, value, updated_at) VALUES ('steps', ?, 8123, 1)").bind(date).run();
    const ctx = createExecutionContext();
    await handlers.scheduled({ cron: "*/5 * * * *" } as ScheduledController, connectorEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.DB.prepare("SELECT steps FROM daily_summary WHERE local_date = ?").bind(date).first()).toEqual({ steps: 8123 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM daily_summary").first("n")).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
  });
});
