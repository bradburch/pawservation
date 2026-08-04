/**
 * Personal access tokens — the credential that makes the PUBLIC booking API real.
 *
 * `lib/llms.ts` publishes, per tenant, how to check availability, get a quote, request a booking,
 * change one and cancel one. Every one of those endpoints is behind `endUserAuth`, and the only
 * credential that satisfied it was the widget JWT: 24 hours long, and mintable only by the
 * email-code flow the widget itself drives. So the document described an API that a script, a
 * cron job, or any client other than the widget could not keep using past the next morning. A
 * personal access token is a credential the customer issues to themselves, from their own
 * signed-in session, that outlives that session and that they can kill on their own.
 *
 * A token authorises exactly what its owner could already do in the widget — same tenant, same end
 * user, same routes. It is not a delegation mechanism, carries no scopes, and confers nothing new.
 * That is what lets `endUserAuth` accept one wherever it accepts a widget JWT without any route
 * needing to know which was presented.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE SECURITY DECISIONS, and why each is what it is.
 *
 * 1. ENTROPY. 32 bytes from `crypto.getRandomValues` — the platform CSPRNG, the same source
 *    `routes/auth.ts` draws login codes from and `lib/password.ts` draws salts from. `Math.random`
 *    is a seeded PRNG whose output stream is reconstructable from a few samples; it must never
 *    produce a credential. 256 bits is far past the point where guessing is the attack, which is
 *    exactly what lets decision 2 below be as cheap as it is.
 *
 * 2. HASHING. Stored as a plain SHA-256, NOT as a PBKDF2 derivation the way
 *    `TenantUsers.PasswordHash` is. The difference is entirely about where the input comes from.
 *    A password is a short string a human invented, so a stolen hash is worth grinding and the
 *    only defence is to make each guess expensive — hence 100k iterations. A token here is 256
 *    uniform random bits; there is no dictionary, no reuse across sites, no human pattern, and a
 *    brute-force is not merely expensive but arithmetically hopeless. Iterating would buy exactly
 *    nothing, and would charge 100k iterations to EVERY authenticated request made with a
 *    credential designed to be presented constantly. No salt either, for the same reason a salt
 *    exists at all: salts stop one precomputed table from cracking many hashes, and there is no
 *    precomputable table over a 256-bit uniform space. Deterministic hashing is also what makes
 *    the lookup a single indexed read instead of a scan over every row belonging to the tenant.
 *
 * 3. COMPARISON, and timing. The plaintext token is never compared to anything: it is hashed
 *    once, and the DIGEST is what gets matched, by an index probe on `(TenantId, TokenHash)`.
 *    SQLite's `=` is not constant-time, so it is worth being precise about what that can leak. The
 *    value it compares is a SHA-256 digest, and SHA-256 is preimage-resistant: an attacker who
 *    extracted a digest one byte at a time from response timings still could not produce a token
 *    that hashes to it, and authentication requires presenting the preimage. There is no
 *    timing channel on the SECRET at all, because the secret never participates in a comparison.
 *
 *    The alternative — an id-in-the-token format, fetch by public id, then `constantTimeEqual` the
 *    digests — was considered and NOT taken. It defends the same digest, which does not need
 *    defending, at the cost of a compound token format and a second failure mode (id present,
 *    secret wrong). `constantTimeEqual` is still the right tool where a low-entropy secret really
 *    is compared byte-for-byte, which is why `lib/timing.ts` exists and why login codes and
 *    password hashes use it. This is not that case, and saying so is better than performing a
 *    constant-time compare that has nothing to protect.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Human-visible prefix on every token. It is not a secret and carries no meaning to the server
 * beyond being part of the string that gets hashed; it exists so a token found in a log, a
 * pasted support message, or a committed config file is recognisable as a pawservation
 * credential — the property that lets automated secret scanners flag one before it is abused.
 */
export const PAT_PREFIX = 'pawsv_';

/** 256 bits. See decision 1 above; also the reason decision 2 can skip an iterated KDF. */
const SECRET_BYTES = 32;

/**
 * How stale `LastUsedAt` may be before a use refreshes it. The column answers "is this token
 * still in use, and is it the one I think it is?" for an owner deciding whether to revoke —
 * recognition, not an audit trail. Stamping it on literally every request would put a D1 write on
 * the hot path of the one credential built for automated clients, which are precisely the callers
 * that make many requests. At one hour, a client polling every thirty seconds writes once per
 * hour instead of 120 times, and the displayed value is never more than an hour behind — a
 * distinction with no meaning to a human reading "last used". A token's FIRST use always writes,
 * because NULL is always stale.
 */
export const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fresh token. Base64url over 32 CSPRNG bytes: URL- and header-safe, and free of the `+`, `/`
 * and `=` that get mangled when a token is pasted through a shell or a query string.
 */
export function generatePersonalAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${PAT_PREFIX}${b64}`;
}

/** Lowercase hex SHA-256 of a token — the only form of it that is ever persisted. */
export async function hashPersonalAccessToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/**
 * Cheap syntactic screen, so a widget JWT (or a stray header) never reaches the database as a
 * candidate token. NOT a security check — the prefix is public — purely a way to avoid a pointless
 * hash-and-query for every non-PAT string `endUserAuth` is handed.
 */
export function looksLikePersonalAccessToken(token: string): boolean {
  return token.startsWith(PAT_PREFIX);
}

/** True when a use should refresh `LastUsedAt` — see LAST_USED_RESOLUTION_MS. */
export function shouldRefreshLastUsed(lastUsedAt: string | null, nowMs: number): boolean {
  if (lastUsedAt === null) return true;
  const previous = Date.parse(`${lastUsedAt.replace(' ', 'T')}Z`);
  // An unparseable stamp is treated as stale rather than trusted: refreshing it repairs the row.
  if (Number.isNaN(previous)) return true;
  return nowMs - previous >= LAST_USED_RESOLUTION_MS;
}
