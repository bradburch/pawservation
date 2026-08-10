/**
 * Reading a sitter's own calendar as a ledger of stays (see
 * docs/superpowers/specs/2026-08-09-calendar-backfill-design.md).
 *
 * PURE. No D1, no env, no fetch — every function takes plain data and returns plain data, so
 * `server/db/repo.ts` stays the only module that touches the database.
 */

export type ParsedSummary = {
  petNames: string[];
  serviceHint: string | null;
  cancelled: boolean;
};

/** Service words we recognise in a title, lowercased. Matched against the tenant's own labels
 *  in `resolveService` — this list only decides where the pet names stop. */
const SERVICE_WORDS = ['boarding', 'house-sit', 'housesit', 'house sit', 'walk', 'check-in', 'check in'];

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pawservation writes `[CANCELLED] ` / `[REQUEST] ` markers (google-calendar.ts:384). A sitter's
 * own calendar tends to carry a trailing ` - CANCELLED` instead. Both are read; only CANCELLED
 * means cancelled, because a `[REQUEST]` is a booking that never happened yet.
 */
export function parseEventSummary(summary: string): ParsedSummary {
  let text = String(summary ?? '').trim();
  if (text === '') return { petNames: [], serviceHint: null, cancelled: false };

  let cancelled = false;
  const leading = /^\[(CANCELLED|REQUEST)\]\s*/i.exec(text);
  if (leading) {
    cancelled = leading[1].toUpperCase() === 'CANCELLED';
    text = text.slice(leading[0].length);
  }
  const trailing = /[\s\-–—]+CANCELLED\s*$/i.exec(text);
  if (trailing) {
    cancelled = true;
    text = text.slice(0, trailing.index);
  }

  // The service word, if present, ends the pet-name run — everything before it is names.
  // Matched at a token boundary (start/end of string or a non-alphanumeric neighbour), never as a
  // bare substring, so a pet named "Walker" is not read as the service "walk".
  const lower = text.toLowerCase();
  let serviceHint: string | null = null;
  let namesPart = text;
  for (const word of SERVICE_WORDS) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`, 'gi');
    let match: RegExpExecArray | null;
    let at = -1;
    while ((match = re.exec(lower)) !== null) {
      // LAST occurrence wins, in case the word also appears earlier (e.g. inside a pet name that
      // happens to contain it as its own token).
      at = match.index;
    }
    if (at === -1) continue;
    // Longest match wins ('check-in' over 'check').
    if (serviceHint === null || word.length > serviceHint.length) {
      serviceHint = word;
      namesPart = text.slice(0, at);
    }
  }
  if (serviceHint !== null) serviceHint = serviceHint.replace(/\s/g, '-');

  const petNames = namesPart
    .split(/\s+and\s+|\s*[,&]\s*|\s+[—–]\s+/i)
    .map((part) => part.trim())
    .filter((part) => part !== '');

  return { petNames, serviceHint, cancelled };
}

export type BackfillPet = { id: string; name: string; petType: string };

export type FlagReason =
  | 'no-pets'
  | 'ambiguous-pet'
  | 'multiple-households'
  | 'unknown-service'
  | 'unpriced-set';

export type PetResolution =
  | { ok: true; pets: BackfillPet[] }
  | { ok: false; reason: 'no-pets' | 'ambiguous-pet'; detail: string };

/** Lowercased and stripped of non-alphanumerics, so "Sadie" meets "sadie" and "Mr. Bo" meets
 *  "mr bo". Deliberately lossy — which is exactly why a key matching two pets is REFUSED below
 *  rather than resolved. */
const nameKey = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export function resolvePetsByName(names: string[], pets: BackfillPet[]): PetResolution {
  if (names.length === 0) {
    return { ok: false, reason: 'no-pets', detail: 'No pet names in the title' };
  }
  const byKey = new Map<string, BackfillPet[]>();
  for (const pet of pets) {
    const key = nameKey(pet.name);
    if (key === '') continue;
    byKey.set(key, [...(byKey.get(key) ?? []), pet]);
  }

  const resolved: BackfillPet[] = [];
  for (const name of names) {
    const hits = byKey.get(nameKey(name)) ?? [];
    if (hits.length === 0) {
      return { ok: false, reason: 'no-pets', detail: `No pet named ${name.trim()}` };
    }
    if (hits.length > 1) {
      // Never guess between two animals with the same name — the sitter sorts it out.
      return {
        ok: false,
        reason: 'ambiguous-pet',
        detail: `${name.trim()} matches ${hits.length} pets`,
      };
    }
    resolved.push(hits[0]);
  }
  return { ok: true, pets: resolved };
}
