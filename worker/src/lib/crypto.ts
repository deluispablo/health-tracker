async function encryptionKey(keyB64: string): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(keyB64)) throw new TypeError("Invalid encryption key");
  const bytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new TypeError("Invalid encryption key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(keyB64: string, text: string): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> {
  const key = await encryptionKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return { iv: iv.buffer, ciphertext };
}

export async function decryptSecret(keyB64: string, iv: ArrayBuffer, ciphertext: ArrayBuffer): Promise<string> {
  const key = await encryptionKey(keyB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
