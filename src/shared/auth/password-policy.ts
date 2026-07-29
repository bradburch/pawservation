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
 * Not a hashing-cost defense — PBKDF2's per-derive cost is set by ITERATIONS, not input size (an
 * oversized password is folded into the HMAC key once, same as a short one), so a long password
 * doesn't buy an attacker extra CPU. This is just a sane, generous finite bound against
 * pathological/mistaken input (e.g. a pasted file), well above any real passphrase.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Keyboard-walks and generic filler: dangerous as a PREFIX, so a longer password built around
 * one of these ("SuperPassword123!", "qwertyqwerty99xy") is exactly as guessable as the bare
 * word and is matched by SUBSTRING against the normalized password.
 */
const SUBSTRING_DENYLIST = [
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
  'admin123',
  'changeme',
  'trustno1',
  'abc123',
];

/**
 * Single dictionary words — weak only as the WHOLE password ("dragon" alone is a top-20 leaked
 * password; "PurpleDragonSunset" is not), so these are matched by EXACT equality against the
 * normalized password instead of substring, so a legitimate longer passphrase that merely
 * contains one of them isn't rejected.
 */
const WHOLE_WORD_DENYLIST = ['welcome', 'dragon', 'monkey', 'football', 'iloveyou'];

/** A local part (or normalized password) shorter than this would make the email-similarity
 *  check an unconditional match: a 1–2 character local part is a substring of nearly everything,
 *  and — symmetrically — an empty-after-normalization password (all symbols/non-Latin, e.g. an
 *  emoji or Cyrillic/CJK passphrase) is `''`, which `.includes('')` always finds inside ANY local
 *  part. Both sides need the floor, or the shorter operand degenerates into a match-everything
 *  wildcard. Too small a signal to act on either way, so it's skipped. */
const MIN_EMAIL_LOCAL_PART_LENGTH = 3;

/** `@`/`$`/`!`/`+` are common letter substitutions ("P@ssw0rd", "pa$$word") that would otherwise
 *  vanish under the alnum strip below and dodge the denylist entirely — fold them to the letter
 *  they're standing in for FIRST. Digits are deliberately left alone: several denylist entries
 *  depend on their own digits staying digits ("passw0rd", "trustno1"). */
const LEET_SUBSTITUTIONS: Record<string, string> = { '@': 'a', $: 's', '!': 'i', '+': 't' };

function foldLeet(s: string): string {
  return s.replace(/[@$!+]/g, (ch) => LEET_SUBSTITUTIONS[ch]);
}

/** Leet-folded, lowercased, ASCII-alphanumeric-only — enough to catch punctuation/case variants
 *  of a denylist entry or an email local part without pulling in a real unicode-normalization
 *  dependency. Anything outside ASCII alnum (emoji, Cyrillic, CJK, …) is simply dropped, which is
 *  why every caller must also apply {@link MIN_EMAIL_LOCAL_PART_LENGTH} before comparing. */
function normalize(s: string): string {
  return foldLeet(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
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
  if (
    SUBSTRING_DENYLIST.some((word) => normalized.includes(word)) ||
    WHOLE_WORD_DENYLIST.includes(normalized)
  )
    return 'That password is too common or predictable — choose something less guessable.';

  if (opts.email) {
    const local = normalize(opts.email.split('@')[0] ?? '');
    // Both operands must clear the floor — see the doc comment on MIN_EMAIL_LOCAL_PART_LENGTH.
    // A password containing no ASCII alphanumerics (all emoji/Cyrillic/CJK/symbols) normalizes
    // to '', and '' is a substring of everything, so without this guard on `normalized` too,
    // EVERY such password would be rejected as "based on your email address."
    if (
      local.length >= MIN_EMAIL_LOCAL_PART_LENGTH &&
      normalized.length >= MIN_EMAIL_LOCAL_PART_LENGTH &&
      (normalized.includes(local) || local.includes(normalized))
    )
      return 'Password cannot be based on your email address.';
  }

  return null;
}
