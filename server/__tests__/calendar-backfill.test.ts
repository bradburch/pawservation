import { describe, expect, it } from 'vitest';
import {
  classifyEvent,
  parseEventSummary,
  resolveHousehold,
  resolvePetsByName,
  resolveService,
} from '../lib/calendar-backfill';

describe('parseEventSummary', () => {
  it('splits one pet and a service word', () => {
    expect(parseEventSummary('Sadie Walk')).toEqual({
      petNames: ['Sadie'],
      serviceHint: 'walk',
      cancelled: false,
    });
  });

  it('splits pets joined by "and"', () => {
    expect(parseEventSummary('Pedro and Remy')).toEqual({
      petNames: ['Pedro', 'Remy'],
      serviceHint: null,
      cancelled: false,
    });
  });

  it('reads a trailing CANCELLED marker and drops it from the names', () => {
    expect(parseEventSummary('Summer and Chia Walk - CANCELLED')).toEqual({
      petNames: ['Summer', 'Chia'],
      serviceHint: 'walk',
      cancelled: true,
    });
  });

  it("reads pawservation's own leading [CANCELLED] marker", () => {
    expect(parseEventSummary('[CANCELLED] Bella — Boarding')).toEqual({
      petNames: ['Bella'],
      serviceHint: 'boarding',
      cancelled: true,
    });
  });

  it('treats a [REQUEST] marker as not cancelled', () => {
    expect(parseEventSummary('[REQUEST] Bella — Boarding').cancelled).toBe(false);
  });

  it('returns no names for an empty summary', () => {
    expect(parseEventSummary('')).toEqual({ petNames: [], serviceHint: null, cancelled: false });
  });

  it('does not read a service word out of the middle of a pet name', () => {
    expect(parseEventSummary('Walker')).toEqual({
      petNames: ['Walker'],
      serviceHint: null,
      cancelled: false,
    });
  });

  it('leaves a non-service title as a single unmatched name', () => {
    // "Brad Unavailable" is a real title from the sitter's calendar. It names no service and no
    // known pet; it must survive parsing intact so the pet resolver can flag it, not vanish here.
    expect(parseEventSummary('Brad Unavailable')).toEqual({
      petNames: ['Brad Unavailable'],
      serviceHint: null,
      cancelled: false,
    });
  });
});

const PETS = [
  { id: 'p1', name: 'Sadie', petType: 'dog' },
  { id: 'p2', name: 'Remy', petType: 'dog' },
  { id: 'p3', name: 'Bella', petType: 'cat' },
  { id: 'p4', name: 'Bella', petType: 'dog' }, // a SECOND Bella — the ambiguity case
];

describe('resolvePetsByName', () => {
  it('resolves a single unambiguous name, case-insensitively', () => {
    expect(resolvePetsByName(['sadie'], PETS)).toEqual({
      ok: true,
      pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
    });
  });

  it('resolves several names', () => {
    const out = resolvePetsByName(['Sadie', 'Remy'], PETS);
    expect(out.ok).toBe(true);
    expect(out.ok && out.pets.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('REFUSES a name matching two pets rather than picking one', () => {
    expect(resolvePetsByName(['Bella'], PETS)).toEqual({
      ok: false,
      reason: 'ambiguous-pet',
      detail: 'Bella matches 2 pets',
    });
  });

  it('reports no-pets when nothing matches', () => {
    expect(resolvePetsByName(['Nobody'], PETS)).toEqual({
      ok: false,
      reason: 'no-pets',
      detail: 'No pet named Nobody',
    });
  });

  it('reports no-pets for an empty name list', () => {
    expect(resolvePetsByName([], PETS)).toEqual({
      ok: false,
      reason: 'no-pets',
      detail: 'No pet names in the title',
    });
  });

  it('reports the ambiguity even when another name resolved fine', () => {
    expect(resolvePetsByName(['Sadie', 'Bella'], PETS).ok).toBe(false);
  });

  it('counts a co-owned pet once, not as an ambiguity', () => {
    // listAllEndUserPetsByTenant JOINs PetOwners, so a pet with two owners arrives TWICE with the
    // same id. That is one animal, not two — it must resolve, not flag.
    const coOwned = [
      { id: 'p1', name: 'Sadie', petType: 'dog' },
      { id: 'p1', name: 'Sadie', petType: 'dog' },
    ];
    expect(resolvePetsByName(['Sadie'], coOwned)).toEqual({
      ok: true,
      pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
    });
  });

  it('still refuses two DIFFERENT pets that share a name', () => {
    const twins = [
      { id: 'p1', name: 'Bella', petType: 'cat' },
      { id: 'p2', name: 'Bella', petType: 'dog' },
    ];
    expect(resolvePetsByName(['Bella'], twins)).toEqual({
      ok: false,
      reason: 'ambiguous-pet',
      detail: 'Bella matches 2 pets',
    });
  });
});

const LINKS = [
  { EndUserId: 'u1', PetId: 'p1' },
  { EndUserId: 'u1', PetId: 'p2' },
  { EndUserId: 'u2', PetId: 'p3' },
];
const pet = (id: string) => ({ id, name: id, petType: 'dog' });

describe('resolveHousehold', () => {
  it('resolves pets that share one owner', () => {
    expect(resolveHousehold([pet('p1'), pet('p2')], LINKS)).toEqual({ ok: true, endUserId: 'u1' });
  });

  it('REFUSES pets spanning two households', () => {
    expect(resolveHousehold([pet('p1'), pet('p3')], LINKS)).toEqual({
      ok: false,
      reason: 'multiple-households',
      detail: 'These pets belong to 2 different clients',
    });
  });

  it('refuses a pet with no owner link at all', () => {
    expect(resolveHousehold([pet('p9')], LINKS).ok).toBe(false);
  });

  it('refuses when ONE pet of several has no owner link', () => {
    // Reachable in real data: listAllEndUserPetsByTenant does not filter deceased pets, but
    // listOwnerPetLinks does — so a pet that has died arrives with no links. Attributing the stay
    // to the surviving pet's owner would be a silent guess about whose booking this was.
    const out = resolveHousehold([pet('p1'), pet('p9')], LINKS);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('multiple-households');
    expect(out.ok === false && out.detail).toContain('p9');
  });

  it('still resolves when every pet has a link to the same owner', () => {
    expect(resolveHousehold([pet('p1'), pet('p2')], LINKS)).toEqual({ ok: true, endUserId: 'u1' });
  });

  it('treats a pet co-owned by two people as ONE household', () => {
    // src/shared/invoicing/accounts.ts: "Two customers who share a single pet are one household
    // and get one statement." Two owner rows for one pet is co-ownership, not two clients.
    const coOwned = [
      { EndUserId: 'u1', PetId: 'p1' },
      { EndUserId: 'u2', PetId: 'p1' },
    ];
    expect(resolveHousehold([pet('p1')], coOwned)).toEqual({ ok: true, endUserId: 'u1' });
  });

  it('treats two people joined through a shared pet as one household', () => {
    // u1 owns p1 and p2; u2 also owns p2. All three ids are one connected component.
    const joined = [
      { EndUserId: 'u1', PetId: 'p1' },
      { EndUserId: 'u1', PetId: 'p2' },
      { EndUserId: 'u2', PetId: 'p2' },
    ];
    expect(resolveHousehold([pet('p1'), pet('p2')], joined)).toEqual({ ok: true, endUserId: 'u1' });
  });

  it('still refuses pets in two genuinely separate households', () => {
    const out = resolveHousehold([pet('p1'), pet('p3')], LINKS);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.detail).toBe('These pets belong to 2 different clients');
  });
});

const SERVICES = [
  { serviceType: 'boarding', label: 'Boarding', optionKey: 'overnight', shape: 'range' as const },
  { serviceType: 'walk', label: 'Dog Walk', optionKey: 'standard', shape: 'single' as const },
];

describe('resolveService', () => {
  it('matches a hint against the service type', () => {
    expect(resolveService('walk', SERVICES)).toEqual({ ok: true, service: SERVICES[1] });
  });

  it('matches a hint against the tenant label', () => {
    expect(resolveService('boarding', SERVICES)).toEqual({ ok: true, service: SERVICES[0] });
  });

  it('refuses a null hint', () => {
    expect(resolveService(null, SERVICES)).toEqual({
      ok: false,
      reason: 'unknown-service',
      detail: 'No service named in the title',
    });
  });

  it('refuses a hint the tenant does not offer', () => {
    expect(resolveService('grooming', SERVICES).ok).toBe(false);
  });
});

const CTX = {
  pets: [
    { id: 'p1', name: 'Sadie', petType: 'dog' },
    { id: 'p3', name: 'Bella', petType: 'cat' },
    { id: 'p4', name: 'Bella', petType: 'dog' },
  ],
  links: [
    { EndUserId: 'u1', PetId: 'p1' },
    { EndUserId: 'u2', PetId: 'p3' },
    { EndUserId: 'u3', PetId: 'p4' },
  ],
  services: [{ serviceType: 'walk', label: 'Dog Walk', optionKey: 'standard', shape: 'single' as const }],
  adoptedEventIds: new Set<string>(),
  priceFor: () => ({ priced: true as const, cost: 25 }),
};

const event = (over: Partial<{ id: string; summary: string; start: string; end: string; private: Record<string, string> }> = {}) => ({
  id: over.id ?? 'ev1',
  summary: over.summary ?? 'Sadie Walk',
  start: over.start ?? '2026-07-01',
  end: over.end ?? '2026-07-02',
  allDay: true,
  status: 'confirmed',
  updated: '2026-07-01T00:00:00Z',
  private: over.private ?? {},
});

describe('classifyEvent', () => {
  it('adopts a fully resolved event', () => {
    expect(classifyEvent(event(), CTX)).toEqual({
      kind: 'adopt',
      eventId: 'ev1',
      summary: 'Sadie Walk',
      startDate: '2026-07-01',
      endDate: null,
      endUserId: 'u1',
      serviceType: 'walk',
      optionKey: 'standard',
      petIds: ['p1'],
      estCost: 25,
      cancelled: false,
    });
  });

  it("skips pawservation's own event", () => {
    const out = classifyEvent(event({ private: { bookingId: 'bk1' } }), CTX);
    expect(out).toEqual({ kind: 'skip', eventId: 'ev1', why: 'pawservation-own' });
  });

  it('skips an event already adopted', () => {
    const out = classifyEvent(event(), { ...CTX, adoptedEventIds: new Set(['ev1']) });
    expect(out).toEqual({ kind: 'skip', eventId: 'ev1', why: 'already-adopted' });
  });

  it('flags an ambiguous pet name', () => {
    const out = classifyEvent(event({ summary: 'Bella Walk' }), CTX);
    expect(out).toMatchObject({ kind: 'flag', reason: 'ambiguous-pet' });
  });

  it('flags an unknown service', () => {
    // 'boarding' IS a recognised service word (it ends the pet-name run), but this tenant's CTX
    // only offers 'walk' — so this exercises resolveService's refusal, not parseEventSummary's
    // vocabulary. ('Sadie Grooming' doesn't isolate a service hint at all, since 'grooming' isn't
    // in parseEventSummary's SERVICE_WORDS, so it fails one stage earlier with 'no-pets'.)
    const out = classifyEvent(event({ summary: 'Sadie Boarding' }), CTX);
    expect(out).toMatchObject({ kind: 'flag', reason: 'unknown-service' });
  });

  it('flags an unpriced pet set and carries NO cost', () => {
    const out = classifyEvent(event(), {
      ...CTX,
      priceFor: () => ({ priced: false as const, reason: 'unpriced-pet-set' as const, groupKey: 'p1', mixKey: 'dog:1' }),
    });
    expect(out).toMatchObject({ kind: 'needs-price' });
    expect(out).not.toHaveProperty('estCost');
  });

  it('returns needs-price with everything resolved when only the rate is missing', () => {
    const out = classifyEvent(event(), {
      ...CTX,
      priceFor: () => ({ priced: false as const, reason: 'unpriced-pet-set' as const, groupKey: 'p1', mixKey: 'dog:1' }),
    });
    expect(out).toMatchObject({
      kind: 'needs-price',
      eventId: 'ev1',
      endUserId: 'u1',
      serviceType: 'walk',
      optionKey: 'standard',
      petIds: ['p1'],
      cancelled: false,
    });
    // The server still invents nothing: the key is absent, not null and not zero.
    expect(out).not.toHaveProperty('estCost');
  });

  it('does not reach needs-price when an earlier step failed', () => {
    // An unresolvable pet is still a flag — needs-price means "only the money is missing".
    const out = classifyEvent(event({ summary: 'Bella Walk' }), {
      ...CTX,
      priceFor: () => ({ priced: false as const, reason: 'unpriced-pet-set' as const, groupKey: '', mixKey: '' }),
    });
    expect(out).toMatchObject({ kind: 'flag', reason: 'ambiguous-pet' });
  });

  it("keeps the exclusive end date for a range-shaped service, whatever its slug", () => {
    // Slugs are frozen at creation time from a label that can be renamed later (see
    // BackfillService's doc comment) — 'overnight-stay' here stands in for that: it is NOT one of
    // the old hardcoded RANGE_SHAPED strings ('boarding' | 'house-sit' | 'housesit'), and it does
    // not equal the built-in "House sitting" template's real generated slug ('house-sitting')
    // either, precisely to show the shape decision no longer depends on recognizing any particular
    // slug string at all. The service's LABEL is 'House sit' so parseEventSummary's recognized
    // word ('house sit' -> hint 'house-sit') still resolves it via resolveService's label match —
    // that lookup is unrelated to, and unaffected by, this fix.
    const ctx = {
      ...CTX,
      services: [
        { serviceType: 'overnight-stay', label: 'House sit', optionKey: 'standard', shape: 'range' as const },
      ],
    };
    const out = classifyEvent(
      event({ summary: 'Sadie House sit', start: '2026-07-01', end: '2026-07-05' }),
      ctx,
    );
    expect(out).toMatchObject({ kind: 'adopt', endDate: '2026-07-05' });
  });

  it('drops the end date for a single-shaped service', () => {
    const out = classifyEvent(event({ start: '2026-07-01', end: '2026-07-02' }), CTX);
    expect(out).toMatchObject({ kind: 'adopt', endDate: null });
  });
});
