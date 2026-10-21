import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/app";
import worker from "../../src/index";
import { DAILY_COLUMNS, healthDaily } from "../../src/mcp/tools/daily";
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
let lastGoogleBody: Record<string, unknown> = {};
function google(over: Record<string, unknown> = {}, status = 200, refresh: string | null = GOOGLE_REFRESH) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const req = new Request(input, init);
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const body: Record<string, unknown> = { access_token: GOOGLE_ACCESS, expires_in: 3600, id_token: idToken(over) };
    if (refresh !== null) body.refresh_token = refresh;
    lastGoogleBody = body;
    return Promise.resolve(Response.json(body, { status }));
  });
}
async function request(path: string, init: RequestInit = {}, bindings = connectorEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await handlers.fetch(new Request(new URL(path, ORIGIN), init), bindings, ctx);
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
  expect(html).not.toContain("<script>alert");
  const decoded = html.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  expect(decoded).toContain(CLIENT_NAME);
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
async function rpc(token: string, method: string, params: object, id = 1, bindings = connectorEnv): Promise<Rpc> {
  const res = await request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`,
    "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }, bindings);
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
    "sync_pending", "sync_state", "secret_blob", "oauth_state", "event"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
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
    const fetch = google({}, 200, null);
    await accessToken();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastGoogleBody).not.toHaveProperty("refresh_token");
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
  it("initializes and lists exactly the eight described tools, only the log tool writing", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    const msg = await rpc(token, "tools/list", {});
    expect(msg.error).toBeUndefined();
    expect(msg.result?.tools?.map((t) => t.name).sort()).toEqual(["health_compare", "health_correlate", "health_daily", "health_intraday", "health_log_event", "health_sleep", "health_status", "health_trackers"]);
    for (const tool of msg.result?.tools ?? []) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      expect(tool.annotations).toMatchObject(tool.name === "health_log_event"
        ? { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        : { readOnlyHint: true, openWorldHint: false });
    }
    const log = (msg.result?.tools ?? []).find((t) => t.name === "health_log_event")?.inputSchema as { properties: Record<string, { description?: string }> };
    for (const id of ["cigarettes", "alcohol", "caffeine"]) expect(log.properties.tracker_id.description).toContain(id);
  });

  it("describes health_status with an empty input schema and read-only annotations", async () => {
    google();
    const token = await accessToken();
    const msg = await rpc(token, "tools/list", {});
    expect(msg.error).toBeUndefined();
    const status = msg.result?.tools?.find((tool) => tool.name === "health_status");
    expect(status).toBeDefined();
    expect(status?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(status?.inputSchema).toMatchObject({ type: "object", properties: {} });
    const schema = status?.inputSchema as { properties?: object; required?: string[] } | undefined;
    expect(Object.keys(schema?.properties ?? {})).toEqual([]);
    expect(schema?.required ?? []).toEqual([]);
    for (const report of [/stream|flujo|data|datos/i, /queue|cola|pending|pendiente/i, /google/i,
      /coverage|cobertura/i, /alert|avis/i]) expect(status?.description).toMatch(report);
  });

  it("calls health_status without arguments, uses USER_TZ and current time, and audits one successful call", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    const before = (await audit()).length;
    const now = Math.floor(Date.now() / 1000);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: connectorEnv.USER_TZ,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(now * 1000));
      const part = (name: string) => parts.find((p) => p.type === name)?.value ?? "";
      const today = `${part("year")}-${part("month")}-${part("day")}`;
      const expected = {
        now_local: `${today}T${part("hour")}:${part("minute")}`,
        streams: [{ stream: "sleep", latest_local: null, age_hours: null }, { stream: "daily", latest_local: null, age_hours: null },
          { stream: "watch", latest_local: null, age_hours: null }],
        queue: { pending: 0, stuck: 0, oldest_received_local: null },
        google: { connected: false, token_updated_local: null },
        coverage: Array.from({ length: 14 }, (_, i) => ({
          date: new Date(Date.parse(`${today}T00:00:00Z`) - (13 - i) * 86400000).toISOString().slice(0, 10), hr_minutes: 0,
        })),
        alerts: [
          { code: "google_disconnected", message: expect.any(String) as unknown },
          { code: "no_data_48h", message: expect.any(String) as unknown },
          { code: "daily_stale", message: expect.any(String) as unknown },
        ],
      };
      const msg = await rpc(token, "tools/call", { name: "health_status", arguments: {} });
      expect(msg.error).toBeUndefined();
      expect(msg.result?.isError).not.toBe(true);
      expect(msg.result?.structuredContent).toEqual(expected);
      expect(msg.result?.content).toEqual([{ type: "text", text: JSON.stringify(msg.result?.structuredContent) }]);
      await toolAudit("health_status", {}, 1, before);
    } finally {
      clock.mockRestore();
    }
  });

  it("describes the valid values of every argument so clients need not guess", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    const msg = await rpc(token, "tools/list", {});
    type Schema = { properties: Record<string, { description?: string }> };
    const tools = new Map((msg.result?.tools ?? []).map((t) => [t.name, t.inputSchema as Schema]));
    const describe = (tool: string, field: string) => tools.get(tool)?.properties[field]?.description ?? "";
    for (const [tool, fields] of [["health_daily", ["start", "end"]], ["health_sleep", ["start", "end"]], ["health_intraday", ["date"]]] as const) {
      for (const field of fields) expect(describe(tool, field)).toContain("YYYY-MM-DD");
    }
    for (const column of DAILY_COLUMNS) expect(describe("health_daily", "metrics")).toContain(column);
    expect(describe("health_intraday", "metric")).toMatch(/\bhr\b/);
    expect(describe("health_intraday", "date")).toContain("2000-01-01");
    expect(describe("health_intraday", "date")).toContain("2099-12-31");
    for (const r of ["1m", "5m", "1h"]) expect(describe("health_intraday", "resolution")).toContain(r);
    expect(describe("health_daily", "start")).toContain("90");
    expect(describe("health_sleep", "start")).toContain("31");
    expect(describe("health_trackers", "date")).toContain("YYYY-MM-DD");
    for (const field of ["tracker_id", "value", "at", "note", "idempotency_key"]) {
      expect(describe("health_log_event", field).trim().length).toBeGreaterThan(0);
    }
    const trackerValues = describe("health_log_event", "tracker_id") + " " + describe("health_log_event", "value");
    for (const value of ["cigarettes", "alcohol", "caffeine", "u", "g", "mg", "1", "20", "13", "200", "80", "1000"]) {
      expect(trackerValues).toContain(value);
    }
    expect(trackerValues).toMatch(/default/i);
    expect(describe("health_log_event", "at")).toMatch(/RFC\s*3339|YYYY-MM-DDT/);
    expect(describe("health_log_event", "at")).toMatch(/7/);
    expect(describe("health_log_event", "at")).toMatch(/300|5\s*min/);
    expect(describe("health_log_event", "note")).toContain("280");
    const key = describe("health_log_event", "idempotency_key");
    expect(key).toContain("8");
    expect(key).toContain("64");
    expect(key).toMatch(/ASCII|A-Z/);
    expect(key).toMatch(/_|underscore/i);
    expect(key).toMatch(/-|hyphen/i);
    expect(key).toMatch(/retry|replay|duplicate|idempoten/i);
    const log = tools.get("health_log_event") as Schema & { required: string[] };
    expect(log.required).toEqual(["tracker_id"]);
    for (const [field, type] of [["tracker_id", "string"], ["value", "number"], ["at", "string"], ["note", "string"], ["idempotency_key", "string"]]) {
      expect(log.properties[field]).toMatchObject({ type });
    }
    expect(tools.get("health_trackers")).toMatchObject({ required: ["date"], properties: { date: { type: "string" } } });
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
    ["health_trackers", {}], ["health_trackers", { date: 123 }],
    ["health_log_event", {}], ["health_log_event", { tracker_id: "caffeine", value: "80" }],
    ["health_log_event", { tracker_id: "caffeine", at: 123 }], ["health_log_event", { tracker_id: "caffeine", note: 123 }],
    ["health_log_event", { tracker_id: "caffeine", idempotency_key: 123 }],
  ])("rejects structurally invalid arguments for %s", async (name, args) => {
    google();
    const token = await accessToken();
    await initialize(token);
    const msg = await rpc(token, "tools/call", { name, arguments: args });
    expect(Boolean(msg.error) || msg.result?.isError === true).toBe(true);
  });

  it("logs an event through MCP once per idempotency key, audits it, and lists it for the day", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    const args = { tracker_id: "caffeine", value: 60, note: "café", idempotency_key: "connector-key-01" };
    const before = (await audit()).length;
    const started = Math.floor(Date.now() / 1000);
    const first = await rpc(token, "tools/call", { name: "health_log_event", arguments: args });
    expect(first.error).toBeUndefined();
    expect(first.result?.isError).not.toBe(true);
    expect(first.result?.structuredContent).toMatchObject({ created: true, event: { id: "k_connector-key-01", tracker_id: "caffeine", value: 60, note_untrusted: "café" } });
    expect(first.result?.content).toEqual([{ type: "text", text: JSON.stringify(first.result?.structuredContent) }]);
    const stored = await env.DB.prepare("SELECT ts, created_at, tz_offset_min, local_date FROM event WHERE id = ?").bind("k_connector-key-01")
      .first<{ ts: number; created_at: number; tz_offset_min: number; local_date: string }>();
    expect(stored).not.toBeNull();
    if (!stored) throw new Error("missing logged event");
    expect(stored.created_at).toBeGreaterThanOrEqual(started);
    expect(stored.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(Number.isInteger(stored.created_at)).toBe(true);
    expect(stored.ts).toBe(stored.created_at);
    const local = new Date((stored.ts + stored.tz_offset_min * 60) * 1000).toISOString().slice(0, 10);
    expect(stored.local_date).toBe(local);
    const offset = new Intl.DateTimeFormat("en", { timeZone: connectorEnv.USER_TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(stored.ts * 1000)).find((p) => p.type === "timeZoneName")?.value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? "");
    expect(match).not.toBeNull();
    if (!match) throw new Error("missing USER_TZ offset");
    expect(stored.tz_offset_min).toBe((match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])));
    await toolAudit("health_log_event", args, 1, before);
    const again = await rpc(token, "tools/call", { name: "health_log_event", arguments: args }, 2);
    expect(again.result?.structuredContent).toEqual({ ...(first.result?.structuredContent as object), created: false });
    await toolAudit("health_log_event", args, 1, before + 1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM event").first("n")).toBe(1);
    const date = (first.result?.structuredContent as { event: { local_date: string } }).event.local_date;
    const listed = await rpc(token, "tools/call", { name: "health_trackers", arguments: { date } }, 3);
    expect(listed.result?.structuredContent).toMatchObject({ date, events: [{ id: "k_connector-key-01", value: 60 }] });
    expect(listed.result?.content).toEqual([{ type: "text", text: JSON.stringify(listed.result?.structuredContent) }]);
    await toolAudit("health_trackers", { date }, 1, before + 2);
    const invalid = { tracker_id: "nope", note: "owner's refused note" };
    const bad = await rpc(token, "tools/call", { name: "health_log_event", arguments: invalid }, 4);
    expect(bad.error).toBeUndefined();
    expect(bad.result?.isError).toBe(true);
    expect(bad.result?.content?.[0].text).toEqual(expect.any(String));
    expect(bad.result?.content?.[0].text).not.toBe("Unable to read health data");
    await toolAudit("health_log_event", invalid, 0, before + 3);
    expect((await audit()).at(-1)?.error).toBe(bad.result?.content?.[0].text);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM event").first("n")).toBe(1);
  });

  it("returns the tracker date RangeError and audits the refused listing", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    const before = (await audit()).length;
    const args = { date: "2026-02-30" };
    const msg = await rpc(token, "tools/call", { name: "health_trackers", arguments: args });
    expect(msg.error).toBeUndefined();
    expect(msg.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.any(String) as unknown }] });
    expect(msg.result?.content?.[0].text).not.toBe("Unable to read health data");
    await toolAudit("health_trackers", args, 0, before);
    expect((await audit()).at(-1)?.error).toBe(msg.result?.content?.[0].text);
  });

  it("returns the generic error and failed audit when a tracker insert fails", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    const before = (await audit()).length;
    await env.DB.prepare("CREATE TRIGGER fail_connector_event BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'private D1 error'); END").run();
    try {
      const args = { tracker_id: "caffeine", note: "owner's note" };
      const msg = await rpc(token, "tools/call", { name: "health_log_event", arguments: args });
      expect(msg.error).toBeUndefined();
      expect(msg.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Unable to read health data" }] });
      await toolAudit("health_log_event", args, 0, before);
      expect((await audit()).at(-1)?.error).toBe("Unable to read health data");
      expect(await env.DB.prepare("SELECT count(*) AS n FROM event").first("n")).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_connector_event").run();
    }
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

describe("T17 AC4 analysis tools through the authenticated connector", () => {
  const behaviors = ["cigarettes", "alcohol_g", "caffeine_mg"];
  const outcomes = ["rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev", "sleep_min", "sleep_eff",
    "deep_min", "rem_min", "sleep_latency_min", "steps", "azm", "readiness_proxy"];
  const names = [...behaviors, ...outcomes];
  const window = { start: "2026-01-01", end: "2026-01-07" };
  const compareArgs = { ...window, behavior: "cigarettes", outcome: "rhr", lag_days: 0 };
  const correlateArgs = { ...window, x: "rhr", y: "sleep_min" };
  const caveats = (n: number) => `Asociacional, no causal. n=${String(n)}. Posibles confusores: alcohol, entrenamiento, hora de acostarse, enfermedad.`;

  it("describes every analysis argument's type, allowed values, defaults and limits", async () => {
    google();
    const token = await accessToken();
    const msg = await rpc(token, "tools/list", {});
    type Schema = { required: string[]; properties: Record<string, { type: string; description?: string; items?: { type: string } }> };
    const tools = new Map((msg.result?.tools ?? []).map((t) => [t.name, t]));
    for (const [name, required, types] of [
      ["health_compare", ["behavior", "outcome", "start", "end"], { behavior: "string", outcome: "string", start: "string", end: "string", lag_days: "integer", bins: "array" }],
      ["health_correlate", ["x", "y", "start", "end"], { x: "string", y: "string", start: "string", end: "string", max_lag: "integer" }],
    ] as const) {
      const tool = tools.get(name);
      expect(tool).toBeDefined();
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      const schema = tool?.inputSchema as Schema;
      expect([...schema.required].sort()).toEqual([...required].sort());
      for (const [field, type] of Object.entries(types)) {
        expect(schema.properties[field].type).toBe(type);
        expect(schema.properties[field].description?.trim().length).toBeGreaterThan(0);
      }
      for (const field of ["start", "end"]) {
        const description = schema.properties[field].description ?? "";
        for (const text of ["YYYY-MM-DD", "365", "2000-01-01", "2099-12-31"]) expect(description).toContain(text);
      }
      const lag = schema.properties[name === "health_compare" ? "lag_days" : "max_lag"].description ?? "";
      for (const text of ["0", "7", name === "health_compare" ? "1" : "3"]) expect(lag).toContain(text);
      expect(lag).toMatch(/default/i);
      if (name === "health_compare") {
        for (const value of behaviors) expect(schema.properties.behavior.description).toContain(value);
        for (const value of outcomes) expect(schema.properties.outcome.description).toContain(value);
        expect(schema.properties.bins.items).toMatchObject({ type: "number" });
        const bins = schema.properties.bins.description ?? "";
        for (const text of [...behaviors, "1", "5", "10", "20", "40", "200", "400"]) expect(bins).toContain(text);
        expect(bins).toMatch(/default/i);
        expect(bins).toMatch(/ascend|increas/i);
        expect(bins).toMatch(/positive/i);
        expect(bins).toMatch(/finite/i);
      } else {
        for (const field of ["x", "y"]) {
          for (const value of names) expect(schema.properties[field].description).toContain(value);
          expect(schema.properties[field].description).toMatch(/distinct|different/i);
        }
      }
    }
  });

  it("returns a seeded Welch comparison in both JSON forms and audits one successful call", async () => {
    google();
    const token = await accessToken();
    await initialize(token);
    const values = [1, 3, 5, 7, 2, 4, 8];
    for (let i = 0; i < values.length; i++) {
      const day = `2026-01-0${String(i + 1)}`;
      await env.DB.prepare("INSERT INTO daily_summary (local_date, rhr, computed_at) VALUES (?, ?, 1)").bind(day, values[i]).run();
      await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, 'cigarettes', ?, 1, 0)")
        .bind(day, i < 4 ? 0 : 1).run();
    }
    const before = (await audit()).length;
    const msg = await rpc(token, "tools/call", { name: "health_compare", arguments: compareArgs });
    expect(msg.error).toBeUndefined();
    expect(msg.result?.isError).not.toBe(true);
    expect(msg.result?.structuredContent).toEqual({ ...compareArgs, n: 7,
      groups: [{ label: "0", n: 4, mean: 4, sd: 2.582 }, { label: ">0–5", n: 3, mean: 4.667, sd: 3.055 },
        { label: ">5–10", n: 0, mean: null, sd: null }, { label: ">10", n: 0, mean: null, sd: null }],
      comparisons: [{ group: ">0–5", vs: "0", diff: 0.667, df: 3.959, ci95: [-5.427, 6.76] }], caveats: caveats(7) });
    expect(msg.result?.content).toEqual([{ type: "text", text: JSON.stringify(msg.result?.structuredContent) }]);
    await toolAudit("health_compare", compareArgs, 1, before);
  });

  it("uses the default lag_days 1 and the requested custom bins through MCP", async () => {
    google();
    const token = await accessToken();
    const args = { ...window, behavior: "caffeine_mg", outcome: "sleep_min", bins: [0.5, 2.5] };
    const before = (await audit()).length;
    const msg = await rpc(token, "tools/call", { name: "health_compare", arguments: args });
    expect(msg.error).toBeUndefined();
    expect(msg.result?.isError).not.toBe(true);
    expect(msg.result?.structuredContent).toEqual({ behavior: args.behavior, outcome: args.outcome, ...window, lag_days: 1, n: 0,
      groups: ["0", ">0–0.5", ">0.5–2.5", ">2.5"].map((label) => ({ label, n: 0, mean: null, sd: null })),
      comparisons: [], caveats: caveats(0) });
    expect(msg.result?.content).toEqual([{ type: "text", text: JSON.stringify(msg.result?.structuredContent) }]);
    await toolAudit("health_compare", args, 1, before);
  });

  it.each([undefined, 0, 7])("returns prewhitened correlation with max_lag %s in both JSON forms and audits it", async (max_lag) => {
    google();
    const token = await accessToken();
    await initialize(token);
    const x = [1, 4, 2, 8, 3, 7, 5];
    const y = [7, 5, 18, 18, 7, 11, 18];
    for (let i = 0; i < x.length; i++) await env.DB.prepare("INSERT INTO daily_summary (local_date, rhr, sleep_min, computed_at) VALUES (?, ?, ?, 1)")
      .bind(`2026-01-0${String(i + 1)}`, x[i], y[i]).run();
    const args = max_lag === undefined ? correlateArgs : { ...correlateArgs, max_lag };
    const before = (await audit()).length;
    const msg = await rpc(token, "tools/call", { name: "health_correlate", arguments: args });
    expect(msg.error).toBeUndefined();
    expect(msg.result?.isError).not.toBe(true);
    const out = msg.result?.structuredContent as { phi: number; lags: { lag: number; r: number | null; n: number }[]; caveats: string };
    expect(out).toMatchObject({ ...correlateArgs, phi: -0.34, caveats: caveats(6) });
    expect(out.lags[0]).toEqual({ lag: 0, n: 6, r: 0.429 });
    expect(out.lags.map(({ lag }) => lag)).toEqual(Array.from({ length: (max_lag ?? 3) + 1 }, (_, i) => i));
    expect(msg.result?.content).toEqual([{ type: "text", text: JSON.stringify(out) }]);
    await toolAudit("health_correlate", args, 1, before);
  });

  it.each([
    ["health_compare", { ...compareArgs, behavior: "alcohol" }, `behavior must be one of: ${behaviors.join(", ")}`],
    ["health_compare", { ...compareArgs, outcome: "bedtime_local" }, `outcome must be one of: ${outcomes.join(", ")}`],
    ["health_compare", { ...compareArgs, lag_days: -1 }, "lag_days must be an integer from 0 to 7"],
    ["health_compare", { ...compareArgs, lag_days: 8 }, "lag_days must be an integer from 0 to 7"],
    ...[[], [0], [2, 1], [1, 1], [1, 2, 3, 4, 5, 6]].map((bins) => ["health_compare", { ...compareArgs, bins }, "bins must be 1 to 5 ascending positive finite numbers"]),
    ["health_correlate", { ...correlateArgs, x: "unknown" }, `x and y must be distinct names from: ${names.join(", ")}`],
    ["health_correlate", { ...correlateArgs, y: "rhr" }, `x and y must be distinct names from: ${names.join(", ")}`],
    ["health_correlate", { ...correlateArgs, max_lag: -1 }, "max_lag must be an integer from 0 to 7"],
    ["health_correlate", { ...correlateArgs, max_lag: 8 }, "max_lag must be an integer from 0 to 7"],
    ...[["health_compare", compareArgs], ["health_correlate", correlateArgs]].flatMap(([name, args]) => [
      [name, { ...(args as object), start: "2026-02-30" }, "date must be a real calendar date in YYYY-MM-DD format"],
      [name, { ...(args as object), end: "2100-01-01" }, "date must be a real calendar date in YYYY-MM-DD format"],
      [name, { ...(args as object), end: "2027-01-01" }, "range must contain 1 to 365 dates"],
      [name, { ...(args as object), end: "2025-12-31" }, "range must contain 1 to 365 dates"],
    ]),
  ] as [string, object, string][])("returns the exact semantic RangeError and failed audit for %s %j", async (name, args, message) => {
    google();
    const token = await accessToken();
    const before = (await audit()).length;
    const msg = await rpc(token, "tools/call", { name, arguments: args });
    expect(msg.error).toBeUndefined();
    expect(msg.result).toMatchObject({ isError: true, content: [{ type: "text", text: message }] });
    await toolAudit(name, args, 0, before);
    expect((await audit()).at(-1)?.error).toBe(message);
  });

  it.each([
    ["health_compare", {}], ["health_compare", { ...compareArgs, behavior: 1 }], ["health_compare", { ...compareArgs, outcome: [] }],
    ["health_compare", { ...compareArgs, start: 1 }], ["health_compare", { ...compareArgs, lag_days: "1" }],
    ["health_compare", { ...compareArgs, lag_days: 0.5 }], ["health_compare", { ...compareArgs, bins: "5" }],
    ["health_compare", { ...compareArgs, bins: ["5"] }], ["health_correlate", {}],
    ["health_correlate", { ...correlateArgs, x: 1 }], ["health_correlate", { ...correlateArgs, y: [] }],
    ["health_correlate", { ...correlateArgs, end: 1 }], ["health_correlate", { ...correlateArgs, max_lag: "3" }],
    ["health_correlate", { ...correlateArgs, max_lag: 0.5 }],
  ])("uses SDK structural validation for %s %j", async (name, args) => {
    google();
    const token = await accessToken();
    const msg = await rpc(token, "tools/call", { name, arguments: args });
    expect(Boolean(msg.error) || msg.result?.isError === true).toBe(true);
  });

  it.each([["health_compare", compareArgs], ["health_correlate", correlateArgs]])("returns a generic D1 error and failed audit for %s", async (name, args) => {
    google();
    const token = await accessToken();
    const before = (await audit()).length;
    const db = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => {
        if (/\bFROM\s+v_daily\b/i.test(sql)) throw new Error("private D1 analysis failure");
        return t.prepare(sql);
      };
      const value: unknown = Reflect.get(t, p);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    } });
    const msg = await rpc(token, "tools/call", { name, arguments: args }, 1, { ...connectorEnv, DB: db });
    expect(msg.error).toBeUndefined();
    expect(msg.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Unable to read health data" }] });
    expect(msg.result?.structuredContent).toBeUndefined();
    await toolAudit(name, args, 0, before);
    expect((await audit()).at(-1)?.error).toBe("Unable to read health data");
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
