/**
 * Password hashing for the sitter dashboard, using PBKDF2 via WebCrypto — the bcrypt/argon2
 * libraries don't run on the Workers runtime, but `crypto.subtle` does. Stored format:
 *   pbkdf2$<iterations>$<saltHex>$<hashHex>
 */

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
  type ValidatePasswordOptions,
} from '../../src/shared/index.js';
import { constantTimeEqual } from './timing';

/** `validatePassword` lives in `src/shared/auth/password-policy.ts` so the setup bundle imports
 *  the same validator; re-exported here unchanged, and still enforced server-side at the trust
 *  boundary (signup.ts, password-reset.ts). */
export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, validatePassword, type ValidatePasswordOptions };

// Cloudflare Workers' runtime rejects PBKDF2 iteration counts above 100_000
// (NotSupportedError in production; local workerd and Node do NOT enforce the cap),
// so this is the maximum deployable value.
export const ITERATIONS = 100_000;
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
 * A real PBKDF2 hash (at {@link ITERATIONS}) of a random string nobody knows. Verifying any
 * password against this costs the same as verifying a real user's hash, so the login route can
 * run a derive on the email-not-found path and avoid a user-enumeration timing oracle. The
 * embedded iteration count MUST match ITERATIONS — `password.test.ts` asserts this so the
 * timing parity can't silently drift if ITERATIONS is raised.
 */
export const DUMMY_PASSWORD_HASH =
  'pbkdf2$100000$a9ed3cc9aea90df324aa3f7f5321c8b2$196ab1e6cbfd64f76c1b69b5dae27e112d5dedc77f07abec1a6d989bb79f186d';

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const hash = await derive(password, fromHex(parts[2]), iterations);
  return constantTimeEqual(toHex(hash), parts[3]);
}
