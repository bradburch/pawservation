/**
 * Password hashing for the sitter dashboard, using PBKDF2 via WebCrypto — the bcrypt/argon2
 * libraries don't run on the Workers runtime, but `crypto.subtle` does. Stored format:
 *   pbkdf2$<iterations>$<saltHex>$<hashHex>
 */

const ITERATIONS = 600_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

/**
 * Constant-time string equality. Length is leaked (unavoidable without padding), but the
 * per-character comparison does not short-circuit, so equal-length inputs take the same time.
 * Used for both hash and login-code comparison.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A real (600k-iteration) PBKDF2 hash of a random string nobody knows. Verifying any password
 * against this costs the same as verifying a real user's hash, so the login route can run a
 * derive on the email-not-found path and avoid a user-enumeration timing oracle.
 */
export const DUMMY_PASSWORD_HASH =
  'pbkdf2$600000$4f4aa1b2f29635a386a62fbce18336ae$8eaa4c479048f11664af6dd8a6118996921474eb6c72ba6c4b6caf66155fc6ae';

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const hash = await derive(password, fromHex(parts[2]), iterations);
  return constantTimeEqual(toHex(hash), parts[3]);
}
