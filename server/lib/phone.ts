/**
 * A CLIENT'S PHONE NUMBER: the free text the person typed, trimmed — so a sitter can always reach
 * the person whose keys she holds.
 *
 * Deliberately light, and written once so every creation path asks the same question:
 *   - non-empty after trimming;
 *   - at most `MAX_PHONE_LENGTH` (40) characters, the cap every admin route already applied;
 *   - at least `MIN_PHONE_DIGITS` (7) ASCII digits somewhere in it — enough to refuse "n/a", "-" or
 *     "ask Tina", and not enough to refuse "+44 20 7946 0958", "(555) 555-0100 ext 12" or
 *     "555 0100 (mum)".
 * No normalisation to an international format, no phone library, no uniqueness (two people in one
 * household may share a number), and no index: what the person typed is what the sitter dials.
 */

export const MAX_PHONE_LENGTH = 40;
export const MIN_PHONE_DIGITS = 7;

export type PhoneRefusalCode = 'phone_required' | 'phone_invalid';
export type PhoneCheck =
  { ok: true; phone: string } | { ok: false; code: PhoneRefusalCode; reason: string };

export function validatePhone(input: unknown): PhoneCheck {
  if (input !== undefined && input !== null && typeof input !== 'string')
    return { ok: false, code: 'phone_invalid', reason: 'A phone number must be text.' };
  const phone = (input ?? '').trim();
  if (phone === '') return { ok: false, code: 'phone_required', reason: 'Enter a phone number.' };
  if (phone.length > MAX_PHONE_LENGTH)
    return {
      ok: false,
      code: 'phone_invalid',
      reason: `A phone number is at most ${MAX_PHONE_LENGTH} characters.`,
    };
  // `\d` without the `u` flag is ASCII 0-9 only, which is the point: a digit the sitter cannot
  // dial is not a digit for this rule.
  if ((phone.match(/\d/g) ?? []).length < MIN_PHONE_DIGITS)
    return {
      ok: false,
      code: 'phone_invalid',
      reason: `That doesn't look like a phone number — it needs at least ${MIN_PHONE_DIGITS} digits.`,
    };
  return { ok: true, phone };
}

/**
 * A STORED phone as the person-facing reads report it: trimmed, or `null` when nothing usable is on
 * file. Only blank or whitespace counts as missing. A number stored before `validatePhone` existed
 * is NOT re-judged by its digit rule — the sitter typed it and can dial it — but a value of only
 * spaces reaches nobody, and treating it as present would skip the one prompt that fixes it.
 */
export function phoneOnFile(stored: string | null | undefined): string | null {
  const phone = (stored ?? '').trim();
  return phone === '' ? null : phone;
}
