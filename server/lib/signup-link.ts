import { constantTimeEqual } from './timing';

/**
 * Signed, single-use, expiring account-setup links, mirroring lib/oauth-state.ts exactly:
 * `token = base64url(payload).base64url(HMAC-SHA256(payload, key))` with the key HKDF-derived
 * from TOKEN_SECRET under its own info label `pawbook-signup-link` — domain separation, so a
 * signup link can never verify as an OAuth state (or as anything hono/jwt signed) and vice
 * versa. Single-use is enforced by the routes: `signup:nonce:{nonce}` is written to
 * PAWBOOK_CACHE at issue (matching expirationTtl) and consumed at completion.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export const SIGNUP_LINK_TTL_SECONDS = 30 * 60;

export const SIGNUP_NONCE_KEY = (nonce: string) => `signup:nonce:${nonce}`;

export type SignupPayload = {
  email: string;
  kind: 'sitter' | 'owner';
  nonce: string;
  exp: number;
};

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function b64urlToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
}

const linkKeyCache = new Map<string, Promise<CryptoKey>>();
function linkHmacKey(secret: string): Promise<CryptoKey> {
  let k = linkKeyCache.get(secret);
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
          info: enc.encode('pawbook-signup-link'),
        },
        ikm,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    })();
    linkKeyCache.set(secret, k);
  }
  return k;
}
async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await linkHmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signSignupLink(secret: string, payload: SignupPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifySignupLink(
  secret: string,
  token: string,
  nowMs: number,
): Promise<SignupPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(await hmac(secret, body));
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: SignupPayload;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
  if (
    typeof payload.email !== 'string' ||
    (payload.kind !== 'sitter' && payload.kind !== 'owner') ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number'
  )
    return null;
  if (payload.exp < nowMs) return null;
  return payload;
}
