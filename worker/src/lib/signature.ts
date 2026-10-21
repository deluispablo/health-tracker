let keys = new Map<number, CryptoKey>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("Invalid base64");
  }
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** Tink encodes unsigned coordinates as either 32 bytes or a zero-prefixed 33 bytes. */
function publicPoint(bytes: Uint8Array): Uint8Array {
  let pos = 0;
  const varint = () => {
    let n = 0;
    for (let shift = 0; shift < 35 && pos < bytes.length; shift += 7) {
      const b = bytes[pos++];
      n += (b & 127) * 2 ** shift;
      if (b < 128) return n;
    }
    throw new TypeError("Invalid protobuf varint");
  };
  const point = new Uint8Array(65);
  point[0] = 4;
  const found = new Set<number>();
  while (pos < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) throw new TypeError("Invalid protobuf field");
    if (wire === 0) { varint(); continue; }
    if (wire !== 2) throw new TypeError("Invalid public key protobuf");
    const length = varint();
    const end = pos + length;
    if (end > bytes.length) throw new TypeError("Truncated public key protobuf");
    if (field === 3 || field === 4) {
      let coordinate = bytes.subarray(pos, end);
      if (coordinate.length === 33 && coordinate[0] === 0) coordinate = coordinate.subarray(1);
      if (coordinate.length !== 32 || found.has(field)) throw new TypeError("Invalid public key coordinate");
      point.set(coordinate, field === 3 ? 1 : 33);
      found.add(field);
    }
    pos = end;
  }
  if (found.size !== 2) throw new TypeError("Missing public key coordinates");
  return point;
}

async function parseKeyset(value: unknown): Promise<Map<number, CryptoKey>> {
  if (!object(value) || !Array.isArray(value.key)) throw new TypeError("Invalid keyset");
  const snapshot = new Map<number, CryptoKey>();
  for (const entry of value.key as unknown[]) {
    if (!object(entry) || entry.status !== "ENABLED") continue;
    const data = entry.keyData;
    if (typeof entry.keyId !== "number" || !Number.isInteger(entry.keyId) || entry.keyId < 0 || entry.keyId > 0xffffffff
      || entry.outputPrefixType !== "TINK" || !object(data) || data.typeUrl !== "type.googleapis.com/google.crypto.tink.EcdsaPublicKey"
      || data.keyMaterialType !== "ASYMMETRIC_PUBLIC" || typeof data.value !== "string" || snapshot.has(entry.keyId)) {
      continue;
    }
    try {
      const key = await crypto.subtle.importKey("raw", publicPoint(base64(data.value)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      snapshot.set(entry.keyId, key);
    } catch { /* Unusable key material must not discard other valid entries. */ }
  }
  if (snapshot.size === 0) throw new TypeError("No usable signing keys");
  return snapshot;
}

/** Web Crypto uses fixed-width r||s; the Tink envelope contains DER integers. */
function rawSignature(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30 || der[1] !== der.length - 2 || der.length > 72) throw new TypeError("Invalid DER sequence");
  const raw = new Uint8Array(64);
  let pos = 2;
  for (const offset of [0, 32]) {
    if (der[pos++] !== 2) throw new TypeError("Invalid DER integer");
    const length = der[pos++];
    if (!(length >= 1 && length <= 33) || pos + length > der.length) throw new TypeError("Invalid DER length");
    let integer = der.subarray(pos, pos + length);
    if (integer[0] >= 128 || (length > 1 && integer[0] === 0 && integer[1] < 128)) throw new TypeError("Invalid DER sign or padding");
    if (integer[0] === 0) integer = integer.subarray(1);
    if (integer.length > 32) throw new TypeError("Oversized DER integer");
    raw.set(integer, offset + 32 - integer.length);
    pos += length;
  }
  if (pos !== der.length) throw new TypeError("Trailing DER data");
  return raw;
}

export async function verifyGoogleSignature(
  header: string | null, body: ArrayBuffer, keyset: () => Promise<unknown>,
): Promise<"valid" | "invalid" | "unavailable"> {
  let keyId: number;
  let signature: Uint8Array;
  try {
    if (!header) return "invalid";
    const envelope = base64(header);
    if (envelope.length < 6 || envelope[0] !== 1) return "invalid";
    keyId = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getUint32(1);
    signature = rawSignature(envelope.subarray(5));
  } catch { return "invalid"; }

  if (!keys.has(keyId)) {
    try {
      // Replace only after a usable snapshot imports, preserving the old cache on failure.
      keys = await parseKeyset(await keyset());
    } catch { return "unavailable"; }
  }
  const key = keys.get(keyId);
  if (!key) return "invalid";
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, body) ? "valid" : "invalid";
  } catch { return "invalid"; }
}
