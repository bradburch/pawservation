import { constantTimeEqual } from './timing';

/**
 * Generic signed, single-use-capable, expiring link primitive shared by every token type that
 * needs it (signup links, password-reset links): `token = base64url(payload).base64url(HMAC-
 * SHA256(payload, key))`, with the key HKDF-derived from a caller-supplied secret under a
 * caller-supplied `label`. The label provides domain separation — two callers using different
 * labels can never verify each other's tokens, even from byte-identical payloads and the same
 * underlying secret. Single-use enforcement (a KV nonce) and payload shape are the caller's
 * responsibility; this module only signs and verifies bytes.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function b64urlToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
}

// Keyed by label first, then secret — two labels sharing the same secret still get independent
// derived keys, and repeated calls with the same (label, secret) reuse the derived CryptoKey.
const keyCache = new Map<string, Map<string, Promise<CryptoKey>>>();
function hmacKey(label: string, secret: string): Promise<CryptoKey> {
  let bySecret = keyCache.get(label);
  if (!bySecret) {
    bySecret = new Map();
    keyCache.set(label, bySecret);
  }
  let k = bySecret.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
        'deriveKey',
      ]);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(label) },
        ikm,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    })();
    bySecret.set(secret, k);
  }
  return k;
}
async function hmac(label: string, secret: string, data: string): Promise<Uint8Array> {
  const key = await hmacKey(label, secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signLink(label: string, secret: string, payload: unknown): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(label, secret, body));
  return `${body}.${sig}`;
}

/**
 * `isValid` narrows the decoded JSON to `T` AND is responsible for checking every field the
 * caller's payload type requires (this module only adds the universal `exp` check on top).
 */
export async function verifyLink<T extends { exp: number }>(
  label: string,
  secret: string,
  token: string,
  isValid: (payload: unknown) => payload is T,
  nowMs: number,
): Promise<T | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(await hmac(label, secret, body));
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
  if (!isValid(payload)) return null;
  if (payload.exp < nowMs) return null;
  return payload;
}
