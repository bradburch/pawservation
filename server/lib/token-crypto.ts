/**
 * AES-GCM encryption for OAuth tokens at rest in D1. The key is derived from TOKEN_SECRET via
 * HKDF-SHA256, so no extra secret is needed and the token store is useless without TOKEN_SECRET.
 * Ciphertext is base64(iv ‖ ct); the 12-byte IV is random per call.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

const keyCache = new Map<string, Promise<CryptoKey>>();
function deriveKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
        'deriveKey',
      ]);
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(0),
          info: enc.encode('pawservation-gcal-token'),
        },
        ikm,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keyCache.set(secret, k);
  }
  return k;
}

export async function encryptToken(secret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}

export async function decryptToken(secret: string, blob: string): Promise<string> {
  const key = await deriveKey(secret);
  const bytes = Uint8Array.from(atob(blob), (ch) => ch.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(pt);
}
