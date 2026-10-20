import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleGoogleWebhook } from "../../src/ingest/webhook";

const SECRET = "Bearer test-secret-0123456789";
const URL_ = "https://example.test/webhooks/google";
const NOW = 1_792_600_000;

interface Signer { keyId: number; key: CryptoKey; tinkValue: string }

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** P1363 (r||s) → DER, as Tink emits. */
function toDer(raw: Uint8Array): Uint8Array {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let x = v.slice(i);
    if (x.at(0) !== undefined && (x.at(0) ?? 0) >= 0x80) x = Uint8Array.of(0, ...x);
    return Uint8Array.of(0x02, x.length, ...x);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

async function makeSigner(keyId: number): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const point = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  // Tink EcdsaPublicKey protobuf: params (field 2), x (field 3), y (field 4), coordinates with a leading 0x00.
  const proto = Uint8Array.of(0x12, 6, 0x08, 3, 0x10, 2, 0x18, 2, 0x1a, 33, 0, ...point.slice(1, 33), 0x22, 33, 0, ...point.slice(33));
  return { keyId, key: pair.privateKey, tinkValue: b64(proto) };
}

async function sign(signer: Signer, body: string): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.key, new TextEncoder().encode(body)));
  const id = new Uint8Array(4);
  new DataView(id.buffer).setUint32(0, signer.keyId);
  return b64(Uint8Array.of(1, ...id, ...toDer(raw)));
}

const keyset = (...signers: Signer[]) => ({
  primaryKeyId: signers[0]?.keyId,
  key: signers.map((s) => ({ keyData: { typeUrl: "type.googleapis.com/google.crypto.tink.EcdsaPublicKey", value: s.tinkValue,
    keyMaterialType: "ASYMMETRIC_PUBLIC" }, status: "ENABLED", keyId: s.keyId, outputPrefixType: "TINK" })),
});

const notification = (dataType: string, operation: string, interval: Record<string, unknown>) =>
  ({ data: { version: "1", healthUserId: "u1", operation, dataType, intervals: [interval] } });
const physical = (start: string, end: string) => ({ physicalTimeInterval: { startTime: start, endTime: end } });

function post(body: string, headers: Record<string, string>): Request {
  return new Request(URL_, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
}

let signer: Signer;
let keysetCalls = 0;
let currentKeyset: unknown;
const deps = () => ({ keyset: () => { keysetCalls++; return Promise.resolve(currentKeyset); }, now: () => NOW });
const webhookEnv = { DB: env.DB, WEBHOOK_SECRET: SECRET };

async function pending() {
  return (await env.DB.prepare("SELECT data_type, start_ts, end_ts, operation, received_at, attempts FROM sync_pending ORDER BY data_type, start_ts").all()).results;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  signer = await makeSigner(4_193_570_438);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sync_pending").run();
  currentKeyset = keyset(signer);
  keysetCalls = 0;
});

describe("AC1 handshake", () => {
  it("answers 200 to the authorized verification and 401 otherwise", async () => {
    const body = '{"type": "verification"}';
    expect((await handleGoogleWebhook(post(body, { authorization: SECRET }), webhookEnv, deps())).status).toBe(200);
    expect((await handleGoogleWebhook(post(body, {}), webhookEnv, deps())).status).toBe(401);
    expect((await handleGoogleWebhook(post(body, { authorization: "Bearer test-secret-0123456788" }), webhookEnv, deps())).status).toBe(401);
    expect((await handleGoogleWebhook(post(body, { authorization: "Bearer short" }), webhookEnv, deps())).status).toBe(401);
    expect(await pending()).toEqual([]);
  });
});

describe("AC2 signature", () => {
  const body = JSON.stringify([notification("steps", "UPSERT", physical("2026-10-20T20:19:00Z", "2026-10-20T20:58:00Z"))]);

  it("rejects missing, invalid and tampered signatures without writing", async () => {
    const good = await sign(signer, body);
    for (const sig of [undefined, "AAAA", good.slice(0, -4) + "AAAA"]) {
      const headers: Record<string, string> = { authorization: SECRET };
      if (sig) headers["google-health-api-signature"] = sig;
      expect((await handleGoogleWebhook(post(body, headers), webhookEnv, deps())).status).toBe(401);
    }
    const tampered = body.replace("steps", "sleep");
    expect((await handleGoogleWebhook(post(tampered, { authorization: SECRET, "google-health-api-signature": good }), webhookEnv, deps())).status).toBe(401);
    expect(await pending()).toEqual([]);
  });

  it("checks Authorization before reading the body", async () => {
    const req = post(body, { "google-health-api-signature": await sign(signer, body) });
    expect((await handleGoogleWebhook(req, webhookEnv, deps())).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(keysetCalls).toBe(0);
  });
});

describe("AC3 queueing", () => {
  it("queues 99 signed notifications and answers 204", async () => {
    const items = Array.from({ length: 99 }, (_, i) => notification("heart-rate", "UPSERT",
      physical(new Date((NOW + i * 60) * 1000).toISOString(), new Date((NOW + i * 60 + 60) * 1000).toISOString())));
    const body = JSON.stringify(items);
    const res = await handleGoogleWebhook(post(body, { authorization: SECRET, "google-health-api-signature": await sign(signer, body) }), webhookEnv, deps());
    expect(res.status).toBe(204);
    const rows = await pending();
    expect(rows).toHaveLength(99);
    expect(rows[0]).toEqual({ data_type: "heart-rate", start_ts: NOW, end_ts: NOW + 60, operation: "UPSERT", received_at: NOW, attempts: 0 });
  });
});

describe("AC4 interval normalisation", () => {
  it("collapses duplicates, widens civil-only intervals by 14 h and keeps DELETE", async () => {
    const civil = { civilDateTimeInterval: {}, civilIso8601TimeInterval: { startTime: "2026-10-20T00:00:00", endTime: "2026-10-21T00:00:00" } };
    const body = JSON.stringify([
      notification("steps", "UPSERT", physical("2026-10-20T20:19:00Z", "2026-10-20T20:58:00Z")),
      notification("steps", "UPSERT", physical("2026-10-20T20:19:00Z", "2026-10-20T20:58:00Z")),
      notification("steps", "UPSERT", civil),
      notification("sleep", "DELETE", physical("2026-10-19T22:00:00Z", "2026-10-20T06:00:00Z")),
      notification("distance", "UPSERT", {}),
    ]);
    const res = await handleGoogleWebhook(post(body, { authorization: SECRET, "google-health-api-signature": await sign(signer, body) }), webhookEnv, deps());
    expect(res.status).toBe(204);
    const day = Date.UTC(2026, 9, 20) / 1000;
    expect(await pending()).toEqual([
      { data_type: "sleep", start_ts: Date.UTC(2026, 9, 19, 22) / 1000, end_ts: Date.UTC(2026, 9, 20, 6) / 1000, operation: "DELETE", received_at: NOW, attempts: 0 },
      { data_type: "steps", start_ts: day - 14 * 3600, end_ts: day + 24 * 3600 + 14 * 3600, operation: "UPSERT", received_at: NOW, attempts: 0 },
      { data_type: "steps", start_ts: Date.UTC(2026, 9, 20, 20, 19) / 1000, end_ts: Date.UTC(2026, 9, 20, 20, 58) / 1000, operation: "UPSERT", received_at: NOW, attempts: 0 },
    ]);
  });

  it("answers 400 to a signed body that is not a notification list, writing nothing", async () => {
    const body = '{"not": "a list"}';
    const res = await handleGoogleWebhook(post(body, { authorization: SECRET, "google-health-api-signature": await sign(signer, body) }), webhookEnv, deps());
    expect(res.status).toBe(400);
    expect(await pending()).toEqual([]);
  });
});

describe("AC5 key rotation", () => {
  it("refetches the keyset once for an unknown key id and caches known keys", async () => {
    const rotated = await makeSigner(1_083_906_037);
    const body = JSON.stringify([notification("steps", "UPSERT", physical("2026-10-20T21:00:00Z", "2026-10-20T21:05:00Z"))]);
    const send = async (s: Signer) => handleGoogleWebhook(post(body, { authorization: SECRET, "google-health-api-signature": await sign(s, body) }), webhookEnv, deps());
    expect((await send(signer)).status).toBe(204);
    const afterFirst = keysetCalls;
    expect((await send(signer)).status).toBe(204);
    expect(keysetCalls).toBe(afterFirst);
    currentKeyset = keyset(signer, rotated);
    expect((await send(rotated)).status).toBe(204);
    expect(keysetCalls).toBe(afterFirst + 1);
    const stranger = await makeSigner(7);
    expect((await send(stranger)).status).toBe(401);
    expect(keysetCalls).toBe(afterFirst + 2);
  });
});
