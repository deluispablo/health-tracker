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

async function makeSigner(keyId: number, zeroPrefix = true): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const point = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  // Tink EcdsaPublicKey protobuf: params (field 2), x (field 3), y (field 4), coordinates with a leading 0x00.
  const coord = (c: Uint8Array) => (zeroPrefix ? Uint8Array.of(0, ...c) : c);
  const x = coord(point.slice(1, 33));
  const y = coord(point.slice(33));
  const proto = Uint8Array.of(0x12, 6, 0x08, 3, 0x10, 2, 0x18, 2, 0x1a, x.length, ...x, 0x22, y.length, ...y);
  return { keyId, key: pair.privateKey, tinkValue: b64(proto) };
}

async function sign(signer: Signer, body: string): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.key, new TextEncoder().encode(body)));
  const id = new Uint8Array(4);
  new DataView(id.buffer).setUint32(0, signer.keyId);
  return b64(Uint8Array.of(1, ...id, ...toDer(raw)));
}

const keyset = (...signers: Signer[]) => keysetWith(signers.map((s) => [s, "ENABLED"]));
const keysetWith = (entries: [Signer, string][]) => ({
  primaryKeyId: entries[0]?.[0].keyId,
  key: entries.map(([s, status]) => ({ keyData: { typeUrl: "type.googleapis.com/google.crypto.tink.EcdsaPublicKey", value: s.tinkValue,
    keyMaterialType: "ASYMMETRIC_PUBLIC" }, status, keyId: s.keyId, outputPrefixType: "TINK" })),
});

const notification = (dataType: string, operation: string, ...intervals: Record<string, unknown>[]) =>
  ({ data: { version: "1", healthUserId: "u1", operation, dataType, intervals } });
const physical = (start: string, end: string) => ({ physicalTimeInterval: { startTime: start, endTime: end } });

function post(body: string, headers: Record<string, string>): Request {
  return new Request(URL_, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
}

let signer: Signer;
let keysetCalls = 0;
let currentKeyset: unknown;
let keysetFails = false;
const deps = () => ({
  keyset: () => { keysetCalls++; return keysetFails ? Promise.reject(new Error("keyset fetch failed")) : Promise.resolve(currentKeyset); },
  now: () => NOW,
});
async function signedPost(body: string, s: Signer = signer, e: { DB: D1Database; WEBHOOK_SECRET: string } = webhookEnv) {
  return handleGoogleWebhook(post(body, { authorization: SECRET, "google-health-api-signature": await sign(s, body) }), e, deps());
}
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
  keysetFails = false;
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

  it("only exempts an exact verification object from the signature", async () => {
    for (const body of ['{"type":"verification","x":1}', '{"type":"verification2"}', '[{"type":"verification"}]']) {
      expect((await handleGoogleWebhook(post(body, { authorization: SECRET }), webhookEnv, deps())).status).toBe(401);
    }
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
    const prefix0 = btoa(String.fromCharCode(0, ...Uint8Array.from(atob(good), (c) => c.charCodeAt(0)).slice(1)));
    const badDer = btoa(String.fromCharCode(...Uint8Array.from(atob(good), (c) => c.charCodeAt(0)).slice(0, 5), 0x30, 0x99, 0x02));
    for (const sig of ["%%%not-base64%%%", prefix0, badDer]) {
      expect((await handleGoogleWebhook(post(body, { authorization: SECRET, "google-health-api-signature": sig }), webhookEnv, deps())).status).toBe(401);
    }
    const tampered = body.replace("steps", "sleep");
    expect((await handleGoogleWebhook(post(tampered, { authorization: SECRET, "google-health-api-signature": good }), webhookEnv, deps())).status).toBe(401);
    expect(await pending()).toEqual([]);
  });

  it("rejects DISABLED keys and accepts unprefixed coordinates", async () => {
    const plain = await makeSigner(55, false);
    const disabled = await makeSigner(56);
    currentKeyset = keysetWith([[disabled, "DISABLED"], [plain, "ENABLED"]]);
    expect((await signedPost(body, disabled)).status).toBe(401);
    expect((await signedPost(body, plain)).status).toBe(204);
  });

  it("answers 400 to signed malformed bodies and 401 to unsigned ones", async () => {
    for (const bad of ["{not json", '[{"data": null}]', '[{"data": {"dataType": 5, "operation": "UPSERT", "intervals": []}}]',
      '[{"data": {"dataType": "steps", "operation": "MERGE", "intervals": []}}]', '[{"data": {"dataType": "steps", "operation": "UPSERT", "intervals": {}}}]',
      '[{"data": {"dataType": "Steps!", "operation": "UPSERT", "intervals": []}}]']) {
      expect((await signedPost(bad)).status).toBe(400);
      expect((await handleGoogleWebhook(post(bad, { authorization: SECRET }), webhookEnv, deps())).status).toBe(401);
    }
    const mixed = JSON.stringify([notification("steps", "UPSERT", physical("2026-10-20T20:19:00Z", "2026-10-20T20:58:00Z")),
      { data: { dataType: "steps", operation: "PATCH", intervals: [] } }]);
    expect((await signedPost(mixed)).status).toBe(400);
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
    expect(rows).toEqual(Array.from({ length: 99 }, (_, i) =>
      ({ data_type: "heart-rate", start_ts: NOW + i * 60, end_ts: NOW + i * 60 + 60, operation: "UPSERT", received_at: NOW, attempts: 0 })));
  });

  it("stamps received_at from the clock when no now() is injected", async () => {
    const body = JSON.stringify([notification("steps", "UPSERT", physical("2026-10-20T20:19:00Z", "2026-10-20T20:58:00Z"))]);
    const before = Math.floor(Date.now() / 1000);
    const res = await handleGoogleWebhook(post(body, { authorization: SECRET, "google-health-api-signature": await sign(signer, body) }), webhookEnv,
      { keyset: () => Promise.resolve(currentKeyset) });
    expect(res.status).toBe(204);
    const r = (await pending())[0] as { received_at: number };
    expect(r.received_at).toBeGreaterThanOrEqual(before);
    expect(r.received_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("answers 500 when the queue write fails and only answers after the write", async () => {
    let done = false;
    const slowDb = { prepare: (q: string) => env.DB.prepare(q),
      batch: async (st: D1PreparedStatement[]) => { await new Promise((r) => setTimeout(r, 20)); done = true; return env.DB.batch(st); } } as unknown as D1Database;
    const body = JSON.stringify([notification("steps", "UPSERT", physical("2026-10-20T20:19:00Z", "2026-10-20T20:58:00Z"))]);
    expect((await signedPost(body, signer, { DB: slowDb, WEBHOOK_SECRET: SECRET })).status).toBe(204);
    expect(done).toBe(true);
    const failingDb = { prepare: (q: string) => env.DB.prepare(q), batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
    expect((await signedPost(body, signer, { DB: failingDb, WEBHOOK_SECRET: SECRET })).status).toBe(500);
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

  it("handles several intervals, empty lists, physical-over-civil precedence and sub-second edges", async () => {
    const both = { ...physical("2026-10-20T20:00:00Z", "2026-10-20T20:05:00Z"), civilIso8601TimeInterval: { startTime: "2026-10-20T22:00:00", endTime: "2026-10-20T22:05:00" } };
    const body = JSON.stringify([
      notification("heart-rate", "UPSERT", physical("2026-10-20T20:18:55Z", "2026-10-20T20:57:27.000001Z"), physical("2026-10-20T21:00:00.400+02:00", "2026-10-20T21:10:00+02:00")),
      notification("steps", "UPSERT"),
      notification("distance", "UPSERT", both),
    ]);
    expect((await signedPost(body)).status).toBe(204);
    expect((await pending()).map((r) => [r.data_type, r.start_ts, r.end_ts])).toEqual([
      ["distance", Date.UTC(2026, 9, 20, 20, 0) / 1000, Date.UTC(2026, 9, 20, 20, 5) / 1000],
      ["heart-rate", Date.UTC(2026, 9, 20, 19, 0) / 1000, Date.UTC(2026, 9, 20, 19, 10) / 1000],
      ["heart-rate", Date.UTC(2026, 9, 20, 20, 18, 55) / 1000, Date.UTC(2026, 9, 20, 20, 57, 28) / 1000],
    ]);
  });

  it("rejects impossible or reversed intervals with 400 and no writes", async () => {
    for (const iv of [physical("2026-02-30T00:00:00Z", "2026-03-01T00:00:00Z"), physical("2026-10-20T21:00:00Z", "2026-10-20T20:00:00Z"),
      physical("2026-10-20T21:00:00Z", "2026-10-20T21:00:00Z"), physical("2026-10-20 21:00", "2026-10-20T22:00:00Z")]) {
      expect((await signedPost(JSON.stringify([notification("steps", "UPSERT", iv)]))).status).toBe(400);
    }
    expect(await pending()).toEqual([]);
  });

  it("keeps attempts across replays and queues UPSERT and DELETE for the same interval", async () => {
    const iv = physical("2026-10-20T20:19:00Z", "2026-10-20T20:58:00Z");
    expect((await signedPost(JSON.stringify([notification("steps", "UPSERT", iv)]))).status).toBe(204);
    await env.DB.prepare("UPDATE sync_pending SET attempts = 3").run();
    expect((await signedPost(JSON.stringify([notification("steps", "UPSERT", iv), notification("steps", "DELETE", iv)]))).status).toBe(204);
    const ops = (await pending()).map((r) => `${String(r.operation)}:${String(r.attempts)}`).sort();
    expect(ops).toEqual(["DELETE:0", "UPSERT:3"]);
  });

  it("answers 400 to a signed body that is not a notification list, writing nothing", async () => {
    const body = '{"not": "a list"}';
    const res = await handleGoogleWebhook(post(body, { authorization: SECRET, "google-health-api-signature": await sign(signer, body) }), webhookEnv, deps());
    expect(res.status).toBe(400);
    expect(await pending()).toEqual([]);
  });
});

describe("AC5 keyset failures", () => {
  it("answers 503 when the keyset cannot be fetched or parsed, and keeps cached keys", async () => {
    const body = JSON.stringify([notification("steps", "UPSERT", physical("2026-10-20T22:00:00Z", "2026-10-20T22:05:00Z"))]);
    expect((await signedPost(body)).status).toBe(204); // warms the cache with signer
    keysetFails = true;
    const fresh = await makeSigner(99_001);
    expect((await signedPost(body, fresh)).status).toBe(503);
    expect((await signedPost(body, signer)).status).toBe(204);
    keysetFails = false;
    currentKeyset = { nonsense: true };
    expect((await signedPost(body, fresh)).status).toBe(503);
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
