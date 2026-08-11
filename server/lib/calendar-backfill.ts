/**
 * Reading a sitter's own calendar as a ledger of stays (see
 * docs/superpowers/specs/2026-08-09-calendar-backfill-design.md).
 *
 * PURE. No D1, no env, no fetch — every function takes plain data and returns plain data, so
 * `server/db/repo.ts` stays the only module that touches the database. `src/shared/` is itself
 * pure and dependency-free, so importing `buildAccounts` from it does not violate that rule.
 */

import { addDays, buildAccounts } from '../../src/shared/index.js';
import type { CalendarEvent } from './google-calendar';
import type { PriceResult } from './availability';

export type ParsedSummary = {
  petNames: string[];
  serviceHint: string | null;
  cancelled: boolean;
};

/** Service words we recognise in a title, lowercased. Matched against the tenant's own labels
 *  in `resolveService` — this list only decides where the pet names stop. */
const SERVICE_WORDS = [
  'boarding',
  'house-sit',
  'housesit',
  'house sit',
  'walk',
  'check-in',
  'check in',
];

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
  // Kept in this closed union so other code that switches over FlagReason still compiles, but
  // classifyEvent no longer produces it: an event that resolves in every other respect and is
  // only missing a rate now returns `kind: 'needs-price'` instead — that is a question for the
  // sitter, not a failure.
  | 'unpriced-set';

export type PetResolution =
  | { ok: true; pets: BackfillPet[] }
  | { ok: false; reason: 'no-pets' | 'ambiguous-pet'; detail: string };

/** Lowercased and stripped of non-alphanumerics, so "Sadie" meets "sadie" and "Mr. Bo" meets
 *  "mr bo". Deliberately lossy — which is exactly why a key matching two pets is REFUSED below
 *  rather than resolved. */
const nameKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export function resolvePetsByName(names: string[], pets: BackfillPet[]): PetResolution {
  if (names.length === 0) {
    return { ok: false, reason: 'no-pets', detail: 'No pet names in the title' };
  }
  // Callers may feed rows from a query that JOINs an owner table (e.g.
  // listAllEndUserPetsByTenant in server/db/repo.ts), which emits one row per owner link — so a
  // co-owned pet arrives more than once with the SAME id. Dedupe by id per name key so ambiguity
  // is judged on distinct animals, not owner links.
  const byKey = new Map<string, Map<string, BackfillPet>>();
  for (const pet of pets) {
    const key = nameKey(pet.name);
    if (key === '') continue;
    const byId = byKey.get(key) ?? new Map<string, BackfillPet>();
    byId.set(pet.id, pet);
    byKey.set(key, byId);
  }

  const resolved: BackfillPet[] = [];
  // Same animal named twice in one title ("Bella and Bella Walk") must resolve to ONE pet, not
  // two — a caller (the import route) turns `pets.length` directly into `PetCount` and a
  // `BookingRequestPets` row per entry, and that table's primary key is (BookingRequestId,
  // PetId): two entries for the same id would violate it mid-write, after the booking row
  // itself is already committed, leaving a permanent orphan booking with no pets at all. This is
  // strictly about the same id recurring; two DIFFERENT pets that happen to share a name are
  // still refused above as ambiguous, per name occurrence, before dedup ever sees them.
  const seenIds = new Set<string>();
  for (const name of names) {
    const hits = [...(byKey.get(nameKey(name))?.values() ?? [])];
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
    const pet = hits[0];
    if (!seenIds.has(pet.id)) {
      seenIds.add(pet.id);
      resolved.push(pet);
    }
  }
  return { ok: true, pets: resolved };
}

export type PetOwnerLink = { EndUserId: string; PetId: string };

/**
 * One household or nothing. A household here is the same thing `src/shared/invoicing/accounts.ts`
 * defines it as: a connected component over the owner<->pet graph, i.e. a billing account — NOT a
 * single owner id. Two owners who co-own one pet are one household with one statement, so that
 * must resolve, not refuse; pets that fall into two genuinely separate accounts is the real
 * "shared walk across two clients" case this import cannot represent as one booking, so THAT is
 * reported, not split by guesswork.
 */
export function resolveHousehold(
  pets: BackfillPet[],
  links: PetOwnerLink[],
): { ok: true; endUserId: string } | { ok: false; reason: 'multiple-households'; detail: string } {
  const accounts = buildAccounts(
    links.map((link) => ({ ownerId: link.EndUserId, petId: link.PetId })),
  );

  const matchedAccountIds = new Set<string>();
  for (const pet of pets) {
    // listAllEndUserPetsByTenant does not filter deceased pets, but listOwnerPetLinks does — so a
    // pet that has since died can arrive here in no account at all. That is a missing fact, not
    // "no household disagreement", and must refuse on its own rather than being silently dropped
    // (which would let a surviving pet's account absorb the whole booking).
    const account = accounts.find((a) => a.petIds.includes(pet.id));
    if (!account) {
      return {
        ok: false,
        reason: 'multiple-households',
        detail: `${pet.name} has no client on record`,
      };
    }
    matchedAccountIds.add(account.id);
  }

  if (matchedAccountIds.size === 1) {
    const account = accounts.find((a) => matchedAccountIds.has(a.id))!;
    // ownerIds is sorted by buildAccounts, so this pick is deterministic. BookingRequests.EndUserId
    // is a single column, but household balances roll up by ACCOUNT rather than by that column, so
    // any owner of the right account attributes the money correctly — there is no "more correct"
    // owner to prefer among co-owners.
    return { ok: true, endUserId: account.ownerIds[0]! };
  }
  return {
    ok: false,
    reason: 'multiple-households',
    detail: `These pets belong to ${matchedAccountIds.size} different clients`,
  };
}

export type BackfillService = {
  serviceType: string;
  label: string;
  optionKey: string;
  /** From TenantServices.Shape — the schema's own answer. Never inferred from the slug: slugs
   *  are per-tenant text derived from a renameable label, so 'House sitting' becomes
   *  'house-sitting' and any hardcoded list of slugs silently misses it. */
  shape: 'range' | 'single';
};

/**
 * Matched against the tenant's OWN services — a hint the sitter does not offer is refused, never
 * mapped onto a near neighbour. Tenants name services freely ("Pack Walks", "House sitting"), so
 * a title-derived hint like 'walk' or 'house-sit' rarely equals a slug or label exactly. Three
 * tiers, widest confidence first, STOPPING at the first tier that produces exactly one match:
 *
 *   1. exact      — nameKey(serviceType) === hint or nameKey(label) === hint.
 *   2. label-prefix — nameKey(label).startsWith(hint). Catches 'housesit' -> 'housesitting'.
 *   3. label-token-prefix — split the label on whitespace; any token whose nameKey starts with
 *      the hint. Catches 'walk' -> the 'walks' token of "Pack Walks".
 *
 * Never the other direction (hint starts with label) and never substring-anywhere — 'walk' must
 * not match a label "Boardwalk Special". Prefix-of-token only.
 *
 * A tier matching two or more services is refused, not resolved by picking one — same posture as
 * every other ambiguity in this module (see resolvePetsByName, resolveHousehold).
 */
export function resolveService(
  hint: string | null,
  services: BackfillService[],
):
  | { ok: true; service: BackfillService }
  | { ok: false; reason: 'unknown-service'; detail: string } {
  if (hint === null || hint.trim() === '') {
    return { ok: false, reason: 'unknown-service', detail: 'No service named in the title' };
  }
  const key = nameKey(hint);

  const refuse = (
    matches: BackfillService[],
  ): { ok: false; reason: 'unknown-service'; detail: string } => ({
    ok: false,
    reason: 'unknown-service',
    detail: `"${hint.trim()}" matches more than one service you offer: ${matches
      .map((s) => s.label)
      .join(', ')}`,
  });

  const exact = services.filter((s) => nameKey(s.serviceType) === key || nameKey(s.label) === key);
  if (exact.length === 1) return { ok: true, service: exact[0] };
  if (exact.length > 1) return refuse(exact);

  const labelPrefix = services.filter((s) => nameKey(s.label).startsWith(key));
  if (labelPrefix.length === 1) return { ok: true, service: labelPrefix[0] };
  if (labelPrefix.length > 1) return refuse(labelPrefix);

  const tokenPrefix = services.filter((s) =>
    s.label
      .split(/\s+/)
      .map((token) => nameKey(token))
      .some((token) => token !== '' && token.startsWith(key)),
  );
  if (tokenPrefix.length === 1) return { ok: true, service: tokenPrefix[0] };
  if (tokenPrefix.length > 1) return refuse(tokenPrefix);

  return { ok: false, reason: 'unknown-service', detail: `You do not offer "${hint.trim()}"` };
}

export type BackfillContext = {
  pets: BackfillPet[];
  links: PetOwnerLink[];
  services: BackfillService[];
  /** Event ids already adopted for this tenant — the idempotency key. */
  adoptedEventIds: Set<string>;
  priceFor: (
    service: BackfillService,
    pets: BackfillPet[],
    startDate: string,
    endDateExclusive: string,
  ) => PriceResult;
};

export type Classified =
  | {
      kind: 'adopt';
      eventId: string;
      summary: string;
      startDate: string;
      endDate: string | null;
      endUserId: string;
      serviceType: string;
      optionKey: string;
      petIds: string[];
      estCost: number;
      cancelled: boolean;
    }
  | {
      kind: 'flag';
      eventId: string;
      summary: string;
      startDate: string;
      reason: FlagReason;
      detail: string;
    }
  | { kind: 'skip'; eventId: string; why: 'pawservation-own' | 'already-adopted' }
  // Everything resolved — pets, household, service, dates — except a rate. This is a question
  // only the sitter can answer, not a failure: it carries the same fields as 'adopt' minus
  // estCost, so the import route can adopt it the moment a price is supplied. NO cost field is
  // ever present here — never estCost: null or estCost: 0.
  | {
      kind: 'needs-price';
      eventId: string;
      summary: string;
      startDate: string;
      endDate: string | null;
      endUserId: string;
      serviceType: string;
      optionKey: string;
      petIds: string[];
      cancelled: boolean;
    };

/**
 * The event's end as an EXCLUSIVE date — the form both `BookingRequests.EndDate` and the pricing
 * helpers take.
 *
 * Google's `end` is exclusive for an all-day event and INCLUSIVE for a timed one, so a timed
 * event occupies every calendar day it touches: a Fri 18:00 – Sun 09:00 boarding occupies
 * Fri/Sat/Sun, and a 14:00–15:00 visit occupies that one day.
 *
 * `externalSpan` in server/lib/calendar-sync.ts is the SOURCE OF TRUTH for this rule — it is what
 * decides how many days that same event blocks while it is still a foreign `'external'` row, and
 * an adopted booking REPLACES that row. This is a deliberate replication, not an independent
 * derivation: importing it would drag D1 into this module, which is pure by contract (see the
 * file header). Change one and change the other, or an adopted stay stops covering the days its
 * external row did — silently freeing a day the sitter is genuinely occupied and billing a night
 * fewer than the calendar says she worked.
 */
function spanEndExclusive(event: CalendarEvent): string {
  if (event.allDay) return event.end;
  const lastDay = event.end >= event.start ? event.end : event.start;
  return addDays(lastDay, 1);
}

export function classifyEvent(event: CalendarEvent, ctx: BackfillContext): Classified {
  // Pawservation wrote this one — reconcile already owns it.
  if (event.private?.bookingId) return { kind: 'skip', eventId: event.id, why: 'pawservation-own' };
  if (ctx.adoptedEventIds.has(event.id))
    return { kind: 'skip', eventId: event.id, why: 'already-adopted' };

  const flag = (reason: FlagReason, detail: string): Classified => ({
    kind: 'flag',
    eventId: event.id,
    summary: event.summary,
    startDate: event.start,
    reason,
    detail,
  });

  const parsed = parseEventSummary(event.summary);

  const pets = resolvePetsByName(parsed.petNames, ctx.pets);
  if (!pets.ok) return flag(pets.reason, pets.detail);

  const household = resolveHousehold(pets.pets, ctx.links);
  if (!household.ok) return flag(household.reason, household.detail);

  const service = resolveService(parsed.serviceHint, ctx.services);
  if (!service.ok) return flag(service.reason, service.detail);

  // The schema's own answer, never inferred from the (renameable, per-tenant) slug.
  const endDate = service.service.shape === 'range' ? spanEndExclusive(event) : null;
  const petIds = pets.pets.map((p) => p.id);

  const price = ctx.priceFor(service.service, pets.pets, event.start, spanEndExclusive(event));
  if (!price.priced) {
    // The free product's own "available but not priced" outcome — but everything else DID
    // resolve, so this is a question for the sitter, not a failure. No number is invented here:
    // there is no estCost field at all, not null and not zero.
    return {
      kind: 'needs-price',
      eventId: event.id,
      summary: event.summary,
      startDate: event.start,
      endDate,
      endUserId: household.endUserId,
      serviceType: service.service.serviceType,
      optionKey: service.service.optionKey,
      petIds,
      cancelled: parsed.cancelled,
    };
  }

  return {
    kind: 'adopt',
    eventId: event.id,
    summary: event.summary,
    startDate: event.start,
    endDate,
    endUserId: household.endUserId,
    serviceType: service.service.serviceType,
    optionKey: service.service.optionKey,
    petIds,
    estCost: price.cost,
    cancelled: parsed.cancelled,
  };
}
