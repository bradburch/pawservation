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
  const lower = text.toLowerCase();
  let serviceHint: string | null = null;
  let namesPart = text;
  for (const word of SERVICE_WORDS) {
    const at = lower.lastIndexOf(word);
    if (at === -1) continue;
    // Longest match wins ('check-in' over 'check'), and the LAST occurrence, so a pet called
    // "Walker" before the service word is not mistaken for it.
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
