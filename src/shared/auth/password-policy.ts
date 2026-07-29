/**
 * The password floor for both auth systems (sitter dashboard, owner console). Lives in
 * `src/shared/` — the `service-templates.ts`/`rate.ts` pattern — so `app/setup/App.tsx` imports
 * the SAME validator `signup.ts`/`password-reset.ts` enforce at their trust boundary, instead of
 * duplicating a literal. The client check is UX only; the server call sites are the real control
 * and always validate independently. `src/shared/` stays dependency-free, so this is a short,
 * hand-listed denylist — a floor, not a security product (no zxcvbn, no bundled wordlist).
 */

/** Raised from the historical 8 — see task brief. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * PBKDF2 has no bcrypt-style truncation, so an unbounded password is a cheap CPU-burn vector on
 * a token-gated but otherwise unauthenticated endpoint (signup/reset complete). Generous enough
 * that no real passphrase hits it.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Short and hand-listed on purpose (see module doc). Substring matching against the normalized
 * password below means a longer password built around one of these ("SuperPassword123!",
 * "qwertyqwerty99xy") is still caught without listing every extension.
 */
const DENYLIST = [
  'password',
  'passw0rd',
  'letmein',
  'qwerty',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '12345678',
  '123456789',
  '1234567890',
  'iloveyou',
  'welcome',
  'admin123',
  'changeme',
  'trustno1',
  'dragon',
  'monkey',
  'football',
  'abc123',
];

/** A local part shorter than this would make the email-similarity check reject almost any
 *  password (e.g. a 1-character local part is a substring of nearly everything) — too small a
 *  signal to act on, so it's skipped rather than becoming a false-positive generator. */
const MIN_EMAIL_LOCAL_PART_LENGTH = 3;

/** Lowercased, ASCII-alphanumeric-only — enough to catch punctuation/case variants of a denylist
 *  entry or an email local part without pulling in a real unicode-normalization dependency. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ValidatePasswordOptions {
  /** The account email, when known, so a password derived from it can be rejected. */
  email?: string;
}

/**
 * Returns a user-facing error message when `password` fails the policy, or `null` when it's
 * acceptable. Deliberately does NOT require character classes (upper/lower/digit/symbol) —
 * length plus a denylist is the better-evidenced policy and produces fewer written-down
 * passwords.
 */
export function validatePassword(
  password: string,
  opts: ValidatePasswordOptions = {},
): string | null {
  // Code points, not UTF-16 code units — `password.length` counts one emoji as 2, one astral
  // character as 2; `Array.from` (which iterates by code point) counts each as 1.
  const chars = Array.from(password);

  if (chars.length < MIN_PASSWORD_LENGTH)
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (chars.length > MAX_PASSWORD_LENGTH)
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (chars.every((ch) => ch === chars[0]))
    return 'Password cannot be a single repeated character.';

  const normalized = normalize(password);
  if (DENYLIST.some((word) => normalized.includes(word)))
    return 'That password is too common or predictable — choose something less guessable.';

  if (opts.email) {
    const local = normalize(opts.email.split('@')[0] ?? '');
    if (
      local.length >= MIN_EMAIL_LOCAL_PART_LENGTH &&
      (normalized.includes(local) || local.includes(normalized))
    )
      return 'Password cannot be based on your email address.';
  }

  return null;
}
