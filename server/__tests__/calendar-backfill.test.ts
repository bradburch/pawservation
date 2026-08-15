import { describe, expect, it } from 'vitest';
import { nightsBetween } from '../../src/shared/index.js';
import {
  classifyEvent,
  parseEventDescription,
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

describe('parseEventDescription', () => {
  // Verbatim from a real production event (see the calendar-backfill design doc): 54 of 55
  // events on that calendar carry this shape.
  const REAL_DESCRIPTION =
    'Owner: Lauren Kotin, Ian Fisher\n' +
    'Owner ID: aaefb00f-c993-4de1-8d44-b335ecc3adb4, 47da31e8-8cd4-4198-bebc-cddaf7cd01de\n' +
    'Cost: 40\n' +
    'Booking: walk\n' +
    'v: 1';

  it('reads cost, booking and owner ids from the real description shape', () => {
    expect(parseEventDescription(REAL_DESCRIPTION)).toEqual({
      cost: 40,
      booking: 'walk',
      ownerIds: ['aaefb00f-c993-4de1-8d44-b335ecc3adb4', '47da31e8-8cd4-4198-bebc-cddaf7cd01de'],
    });
  });

  it('matches keys case-insensitively', () => {
    expect(parseEventDescription('cost: 40\nBOOKING: walk\nowner id: abc')).toEqual({
      cost: 40,
      booking: 'walk',
      ownerIds: ['abc'],
    });
  });

  it('ignores unknown keys', () => {
    expect(parseEventDescription('Notes: fed twice\nCost: 40')).toEqual({
      cost: 40,
      booking: null,
      ownerIds: [],
    });
  });

  it('returns all-empty for a description with only Owner: (no Cost/Booking)', () => {
    // Pedro and Remy — a real event that carries only the owner names, no cost/service.
    expect(parseEventDescription('Owner: Pedro Alvarez')).toEqual({
      cost: null,
      booking: null,
      ownerIds: [],
    });
  });

  it('returns all-empty for an empty description', () => {
    expect(parseEventDescription('')).toEqual({ cost: null, booking: null, ownerIds: [] });
  });

  it('tolerates a blank (whitespace-only) description', () => {
    expect(parseEventDescription('   \n  ')).toEqual({ cost: null, booking: null, ownerIds: [] });
  });

  it('rejects a fractional cost rather than rounding it', () => {
    expect(parseEventDescription('Cost: 40.50').cost).toBeNull();
  });

  it('rejects a non-numeric cost', () => {
    expect(parseEventDescription('Cost: abc').cost).toBeNull();
  });

  it('rejects a zero cost', () => {
    expect(parseEventDescription('Cost: 0').cost).toBeNull();
  });

  it('rejects a negative cost', () => {
    expect(parseEventDescription('Cost: -5').cost).toBeNull();
  });

  it('splits multiple owner ids and trims whitespace, dropping empties', () => {
    expect(parseEventDescription('Owner ID: id-1,  id-2 ,, id-3').ownerIds).toEqual([
      'id-1',
      'id-2',
      'id-3',
    ]);
  });

  it('trims the raw Booking value', () => {
    expect(parseEventDescription('Booking:   walk  ').booking).toBe('walk');
  });

  it('parses CRLF line endings — Google can return \\r\\n', () => {
    expect(parseEventDescription('Owner: Lauren Kotin\r\nCost: 40\r\nBooking: walk\r\n')).toEqual({
      cost: 40,
      booking: 'walk',
      ownerIds: [],
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

  it('counts a pet named twice in one title once', () => {
    // 'Bella and Bella Walk' — one animal, named twice. Two entries would write PetCount=2 and
    // then violate BookingRequestPets' primary key, leaving a booking with no pets at all.
    expect(
      resolvePetsByName(['Bella', 'Bella'], [{ id: 'p1', name: 'Bella', petType: 'dog' }]),
    ).toEqual({
      ok: true,
      pets: [{ id: 'p1', name: 'Bella', petType: 'dog' }],
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

// A real production tenant's four services — the reason this widened match exists. Their titles
// are dominated by "Sadie Walk" / "Teddy Walk" / "Daisy Walk" and house-sits, and under the old
// EXACT-only match every one of those flagged unknown-service: 'house-sit' != 'housesitting' and
// 'walk' != 'packwalks'. This fixture is that tenant's real four rows, not a synthetic example.
const REAL_SERVICES = [
  { serviceType: 'boarding', label: 'Boarding', optionKey: 'standard', shape: 'range' as const },
  { serviceType: 'check-in', label: 'Check-in', optionKey: 'standard', shape: 'single' as const },
  {
    serviceType: 'house-sitting',
    label: 'House sitting',
    optionKey: 'standard',
    shape: 'range' as const,
  },
  {
    serviceType: 'pack-walks',
    label: 'Pack Walks',
    optionKey: 'standard',
    shape: 'single' as const,
  },
];

describe('resolveService — widened matching against a real tenant', () => {
  it('resolves "walk" to Pack Walks via the label TOKEN-prefix tier', () => {
    expect(resolveService('walk', REAL_SERVICES)).toEqual({
      ok: true,
      service: REAL_SERVICES[3],
    });
  });

  it('resolves "house-sit" to House sitting via the label-prefix tier', () => {
    expect(resolveService('house-sit', REAL_SERVICES)).toEqual({
      ok: true,
      service: REAL_SERVICES[2],
    });
  });

  it('still resolves "boarding" and "check-in" exactly — no regression', () => {
    expect(resolveService('boarding', REAL_SERVICES)).toEqual({
      ok: true,
      service: REAL_SERVICES[0],
    });
    expect(resolveService('check-in', REAL_SERVICES)).toEqual({
      ok: true,
      service: REAL_SERVICES[1],
    });
  });

  it('an EXACT match wins over a looser one, never refused as ambiguous', () => {
    const services = [
      { serviceType: 'walk', label: 'Walk', optionKey: 'standard', shape: 'single' as const },
      {
        serviceType: 'pack-walks',
        label: 'Pack Walks',
        optionKey: 'standard',
        shape: 'single' as const,
      },
    ];
    expect(resolveService('walk', services)).toEqual({ ok: true, service: services[0] });
  });

  it('REFUSES when a loose tier matches two services, naming both candidates', () => {
    const services = [
      {
        serviceType: 'pack-walks',
        label: 'Pack Walks',
        optionKey: 'standard',
        shape: 'single' as const,
      },
      {
        serviceType: 'solo-walk',
        label: 'Solo Walk',
        optionKey: 'standard',
        shape: 'single' as const,
      },
    ];
    const out = resolveService('walk', services);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('unknown-service');
    expect(out.ok === false && out.detail).toContain('Pack Walks');
    expect(out.ok === false && out.detail).toContain('Solo Walk');
  });

  it('still refuses a service the tenant does not offer at all', () => {
    expect(resolveService('grooming', REAL_SERVICES).ok).toBe(false);
  });

  it('does NOT match "walk" against a label via substring-anywhere, only prefix-of-token', () => {
    const services = [
      {
        serviceType: 'boardwalk-special',
        label: 'Boardwalk Special',
        optionKey: 'standard',
        shape: 'single' as const,
      },
    ];
    expect(resolveService('walk', services).ok).toBe(false);
  });

  it('a null hint still refuses with the existing message', () => {
    expect(resolveService(null, REAL_SERVICES)).toEqual({
      ok: false,
      reason: 'unknown-service',
      detail: 'No service named in the title',
    });
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
  services: [
    { serviceType: 'walk', label: 'Dog Walk', optionKey: 'standard', shape: 'single' as const },
  ],
  adoptedEventIds: new Set<string>(),
  priceFor: () => ({ priced: true as const, cost: 25 }),
};

const event = (
  over: Partial<{
    id: string;
    summary: string;
    description: string;
    start: string;
    end: string;
    allDay: boolean;
    private: Record<string, string>;
  }> = {},
) => ({
  id: over.id ?? 'ev1',
  summary: over.summary ?? 'Sadie Walk',
  description: over.description ?? '',
  start: over.start ?? '2026-07-01',
  end: over.end ?? '2026-07-02',
  allDay: over.allDay ?? true,
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
      priceFor: () => ({
        priced: false as const,
        reason: 'unpriced-pet-set' as const,
        groupKey: 'p1',
        mixKey: 'dog:1',
      }),
    });
    expect(out).toMatchObject({ kind: 'needs-price' });
    expect(out).not.toHaveProperty('estCost');
  });

  it('returns needs-price with everything resolved when only the rate is missing', () => {
    const out = classifyEvent(event(), {
      ...CTX,
      priceFor: () => ({
        priced: false as const,
        reason: 'unpriced-pet-set' as const,
        groupKey: 'p1',
        mixKey: 'dog:1',
      }),
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
      priceFor: () => ({
        priced: false as const,
        reason: 'unpriced-pet-set' as const,
        groupKey: '',
        mixKey: '',
      }),
    });
    expect(out).toMatchObject({ kind: 'flag', reason: 'ambiguous-pet' });
  });

  it('keeps the exclusive end date for a range-shaped service, whatever its slug', () => {
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
        {
          serviceType: 'overnight-stay',
          label: 'House sit',
          optionKey: 'standard',
          shape: 'range' as const,
        },
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

/**
 * The sitter's own structured description — real cost, service, and client — is preferred over
 * our reading of the title, per docs/superpowers/sdd/2026-08-10-calendar-backfill. See the design
 * doc's motivating example: an event titled "Summer and Chia Walk - CANCELLED" carries `Cost: 40`
 * in its description, but the rate card prices two dogs at $80 — the description is what was
 * actually charged.
 */
describe('classifyEvent — the description is preferred over the title', () => {
  // Verbatim from a real production event.
  const REAL_DESCRIPTION =
    'Owner: Lauren Kotin, Ian Fisher\n' +
    'Owner ID: aaefb00f-c993-4de1-8d44-b335ecc3adb4, 47da31e8-8cd4-4198-bebc-cddaf7cd01de\n' +
    'Cost: 40\n' +
    'Booking: walk\n' +
    'v: 1';

  it('adopts the real Sadie Walk event at cost 40, service resolved from Booking: walk', () => {
    const out = classifyEvent(event({ summary: 'Sadie Walk', description: REAL_DESCRIPTION }), {
      ...CTX,
      // If the rate card were consulted it would answer 25 (CTX.priceFor) — the description's
      // Cost: 40 must win regardless.
      priceFor: () => ({ priced: true as const, cost: 25 }),
    });
    expect(out).toMatchObject({
      kind: 'adopt',
      serviceType: 'walk',
      optionKey: 'standard',
      estCost: 40,
    });
  });

  it('adopts "Summer and Chia Walk - CANCELLED" at 40, not the rate card\'s 80 — the bug that motivated this change', () => {
    const summerChiaCtx = {
      pets: [
        { id: 'p10', name: 'Summer', petType: 'dog' },
        { id: 'p11', name: 'Chia', petType: 'dog' },
      ],
      links: [
        { EndUserId: 'u9', PetId: 'p10' },
        { EndUserId: 'u9', PetId: 'p11' },
      ],
      services: [
        { serviceType: 'walk', label: 'Dog Walk', optionKey: 'standard', shape: 'single' as const },
      ],
      adoptedEventIds: new Set<string>(),
      // The rate card's linear two-pet answer — $40/pet — which is the wrong number this change
      // exists to stop using.
      priceFor: () => ({ priced: true as const, cost: 80 }),
    };
    const out = classifyEvent(
      event({
        summary: 'Summer and Chia Walk - CANCELLED',
        description: 'Owner ID: u9\nCost: 40\nBooking: walk',
      }),
      summerChiaCtx,
    );
    expect(out).toMatchObject({ kind: 'adopt', estCost: 40, cancelled: true });
  });

  it('still prices from the rate card when the description gives no Cost', () => {
    const out = classifyEvent(
      event({ summary: 'Sadie Walk', description: 'Owner: Lauren Kotin' }),
      { ...CTX, priceFor: () => ({ priced: true as const, cost: 25 }) },
    );
    expect(out).toMatchObject({ kind: 'adopt', estCost: 25 });
  });

  it('behaves exactly as before for an event with no description at all', () => {
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

  it("refuses when the description's owner id resolves a DIFFERENT household than the title's pets", () => {
    const ctx = {
      pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
      links: [
        { EndUserId: 'u1', PetId: 'p1' },
        // A second client on the roster whose id happens to end with the legacy owner id below —
        // not an owner of Sadie at all.
        { EndUserId: 'eu_legacy_zzz999', PetId: 'p2' },
      ],
      services: [
        { serviceType: 'walk', label: 'Dog Walk', optionKey: 'standard', shape: 'single' as const },
      ],
      adoptedEventIds: new Set<string>(),
      priceFor: () => ({ priced: true as const, cost: 20 }),
    };
    const out = classifyEvent(
      event({
        summary: 'Sadie Walk',
        description: 'Owner ID: zzz999\nCost: 40\nBooking: walk',
      }),
      ctx,
    );
    expect(out).toMatchObject({ kind: 'flag', reason: 'multiple-households' });
  });

  it('a description Cost: lets an otherwise needs-price event adopt', () => {
    const out = classifyEvent(event({ description: 'Owner: Lauren Kotin\nCost: 40' }), {
      ...CTX,
      priceFor: () => ({
        priced: false as const,
        reason: 'unpriced-pet-set' as const,
        groupKey: 'p1',
        mixKey: 'dog:1',
      }),
    });
    expect(out).toMatchObject({ kind: 'adopt', estCost: 40 });
  });

  it('flags unknown-service when the description names a service the tenant does not offer, instead of silently falling back to the title', () => {
    // CTX only offers 'walk'. The title alone would resolve fine ('Sadie Walk' -> walk), but the
    // sitter's own record naming a service she does not offer is a fact worth surfacing, not
    // something the title should override.
    const out = classifyEvent(
      event({ summary: 'Sadie Walk', description: 'Booking: grooming' }),
      CTX,
    );
    expect(out).toMatchObject({ kind: 'flag', reason: 'unknown-service' });
  });

  // The two owner ids on the CANONICAL production description belong to ONE household (two
  // co-owners), not two — the headline "adopts the real Sadie Walk event" test above never
  // exercises the owner-id match path at all (CTX's u1/u2/u3 share no suffix with either UUID), so
  // these exercise it directly against a roster where the ids actually do.
  describe("resolving the description's owner ids to a billing ACCOUNT, not owner count", () => {
    const OWNER_A = 'aaefb00f-c993-4de1-8d44-b335ecc3adb4'; // Lauren Kotin
    const OWNER_B = '47da31e8-8cd4-4198-bebc-cddaf7cd01de'; // Ian Fisher
    const REAL_DESC_OWNER_IDS = `Owner ID: ${OWNER_A}, ${OWNER_B}\nCost: 40\nBooking: walk`;

    it('two co-owned clients (ids ending with both UUIDs, sharing a pet) fuse into ONE account and adopt', () => {
      const ctx = {
        pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
        links: [
          // Both clients own the SAME pet — buildAccounts fuses them into one account.
          { EndUserId: `eu_lauren_${OWNER_A}`, PetId: 'p1' },
          { EndUserId: `eu_ian_${OWNER_B}`, PetId: 'p1' },
        ],
        services: [
          {
            serviceType: 'walk',
            label: 'Dog Walk',
            optionKey: 'standard',
            shape: 'single' as const,
          },
        ],
        adoptedEventIds: new Set<string>(),
        priceFor: () => ({ priced: true as const, cost: 999 }),
      };
      const out = classifyEvent(
        event({ summary: 'Sadie Walk', description: REAL_DESC_OWNER_IDS }),
        ctx,
      );
      // The canonical representative is the lexicographically-first owner id in the fused
      // account — 'eu_ian_…' sorts before 'eu_lauren_…' — so the SAME household always writes
      // under the SAME EndUserId regardless of which co-owner an event happens to name.
      expect(out).toMatchObject({
        kind: 'adopt',
        endUserId: `eu_ian_${OWNER_B}`,
        estCost: 40,
      });
    });

    it('two clients in genuinely SEPARATE accounts (no shared pet) refuse multiple-households', () => {
      const ctx = {
        pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
        links: [
          { EndUserId: `eu_lauren_${OWNER_A}`, PetId: 'p1' }, // owns Sadie
          { EndUserId: `eu_ian_${OWNER_B}`, PetId: 'p2' }, // a wholly separate account
        ],
        services: [
          {
            serviceType: 'walk',
            label: 'Dog Walk',
            optionKey: 'standard',
            shape: 'single' as const,
          },
        ],
        adoptedEventIds: new Set<string>(),
        priceFor: () => ({ priced: true as const, cost: 999 }),
      };
      const out = classifyEvent(
        event({ summary: 'Sadie Walk', description: REAL_DESC_OWNER_IDS }),
        ctx,
      );
      expect(out).toMatchObject({ kind: 'flag', reason: 'multiple-households' });
    });

    it('matches an owner id case-insensitively', () => {
      const ctx = {
        pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
        links: [{ EndUserId: `eu_lauren_${OWNER_A}`, PetId: 'p1' }],
        services: [
          {
            serviceType: 'walk',
            label: 'Dog Walk',
            optionKey: 'standard',
            shape: 'single' as const,
          },
        ],
        adoptedEventIds: new Set<string>(),
        priceFor: () => ({ priced: true as const, cost: 999 }),
      };
      const out = classifyEvent(
        event({
          summary: 'Sadie Walk',
          description: `Owner ID: ${OWNER_A.toUpperCase()}\nCost: 40\nBooking: walk`,
        }),
        ctx,
      );
      expect(out).toMatchObject({ kind: 'adopt', endUserId: `eu_lauren_${OWNER_A}` });
    });

    it('does not tail-match an owner id across a non-boundary character', () => {
      const ctx = {
        pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
        links: [
          { EndUserId: 'u1', PetId: 'p1' }, // the pet-derived household
          // Ends with '1', but NOT at a boundary — the preceding char '0' is alphanumeric, so
          // owner id '1' must not tail-match this id.
          { EndUserId: 'eu_201', PetId: 'p2' },
        ],
        services: [
          {
            serviceType: 'walk',
            label: 'Dog Walk',
            optionKey: 'standard',
            shape: 'single' as const,
          },
        ],
        adoptedEventIds: new Set<string>(),
        priceFor: () => ({ priced: true as const, cost: 20 }),
      };
      const out = classifyEvent(
        event({ summary: 'Sadie Walk', description: 'Owner ID: 1\nCost: 40\nBooking: walk' }),
        ctx,
      );
      // No genuine match, so this falls back to the pet-derived household (u1) rather than a
      // false "different client" conflict against 'eu_201'.
      expect(out).toMatchObject({ kind: 'adopt', endUserId: 'u1' });
    });
  });
});

/**
 * Google's `end` is EXCLUSIVE for an all-day event and INCLUSIVE for a timed one. `externalSpan`
 * (server/lib/calendar-sync.ts) is where that rule already lives, and it is the source of truth:
 * it is what decides how many days the SAME event blocks while it is still a foreign 'external'
 * row. An adopted booking REPLACES that external row, so a classifier that took a timed `end` raw
 * shortened the stay by a day on adoption — freeing a day the sitter is genuinely occupied, and
 * billing one night fewer than the calendar said she worked.
 */
describe('classifyEvent — Google’s end date is inclusive on a TIMED event', () => {
  const boarding = {
    ...CTX,
    services: [
      {
        serviceType: 'boarding',
        label: 'Boarding',
        optionKey: 'standard',
        shape: 'range' as const,
      },
    ],
  };

  // $50/night, so the cost reports the billed night count directly.
  function classifyBoarding(over: Parameters<typeof event>[0]) {
    const priced: { startDate: string; endDateExclusive: string }[] = [];
    const out = classifyEvent(event({ summary: 'Sadie Boarding', ...over }), {
      ...boarding,
      priceFor: (_s, _p, startDate, endDateExclusive) => {
        priced.push({ startDate, endDateExclusive });
        return { priced: true as const, cost: 50 * nightsBetween(startDate, endDateExclusive) };
      },
    });
    return { out, priced };
  }

  it('a Fri 18:00 – Sun 09:00 stay keeps every day it occupies', () => {
    // Timed: Google reports end = Sunday, the day the stay is still running. externalSpan blocks
    // Fri/Sat/Sun for it, so the adopted booking must too — EndDate is exclusive, hence Monday.
    const { out, priced } = classifyBoarding({
      start: '2026-07-03',
      end: '2026-07-05',
      allDay: false,
    });

    expect(out).toMatchObject({ kind: 'adopt', startDate: '2026-07-03', endDate: '2026-07-06' });
    // Pricing must see the SAME normalized span, not the raw end — three nights, not two.
    expect(priced).toEqual([{ startDate: '2026-07-03', endDateExclusive: '2026-07-06' }]);
    expect(out).toMatchObject({ estCost: 150 });
  });

  it('a single-day timed visit still occupies its one day', () => {
    // A 14:00–15:00 event starts and ends on the same date; externalSpan blocks that one day.
    const { out, priced } = classifyBoarding({
      start: '2026-07-03',
      end: '2026-07-03',
      allDay: false,
    });

    expect(out).toMatchObject({ endDate: '2026-07-04', estCost: 50 });
    expect(priced).toEqual([{ startDate: '2026-07-03', endDateExclusive: '2026-07-04' }]);
  });

  it('an ALL-DAY event is unchanged — its end is already exclusive', () => {
    const { out, priced } = classifyBoarding({
      start: '2026-07-03',
      end: '2026-07-05',
      allDay: true,
    });

    expect(out).toMatchObject({ endDate: '2026-07-05', estCost: 100 });
    expect(priced).toEqual([{ startDate: '2026-07-03', endDateExclusive: '2026-07-05' }]);
  });
});

/**
 * A description `Cost:` on a RANGE-shaped service is the sitter's PER-NIGHT rate, not the total
 * for the stay — her own convention in her own calendar, confirmed by her directly. Reading it as
 * a total understated every multi-night stay she had already adopted: a 3-night boarding written
 * `Cost: 100` is $300 owed, not $100.
 *
 * Nights come from the repo's one night-counting helper (`nightsBetween`, over the same
 * `spanEndExclusive` span the rate card is asked for), so the backfill and the rate card can never
 * disagree about what a night is.
 */
describe('classifyEvent — a description Cost: on a RANGE service is a PER-NIGHT rate', () => {
  // Any priceFor answer here is deliberately absurd: a description Cost: must win outright, so if
  // one of these numbers ever shows up in an assertion the rate card was consulted when it
  // should not have been.
  const rangeCtx = (serviceType: string, label: string) => ({
    ...CTX,
    services: [{ serviceType, label, optionKey: 'standard', shape: 'range' as const }],
    priceFor: () => ({ priced: true as const, cost: 999 }),
  });

  it('a 3-night boarding described Cost: 100 adopts at 300, not 100', () => {
    // The sitter's live 2026-07-17 → 07-20 boarding, verbatim.
    const out = classifyEvent(
      event({
        summary: 'Sadie Boarding',
        description: 'Cost: 100',
        start: '2026-07-17',
        end: '2026-07-20',
        allDay: true,
      }),
      rangeCtx('boarding', 'Boarding'),
    );
    expect(out).toMatchObject({ kind: 'adopt', endDate: '2026-07-20', estCost: 300 });
  });

  it('a 3-night house sit described Cost: 110 adopts at 330', () => {
    const out = classifyEvent(
      event({
        summary: 'Sadie House sit',
        description: 'Cost: 110',
        start: '2026-07-17',
        end: '2026-07-20',
        allDay: true,
      }),
      rangeCtx('house-sitting', 'House sitting'),
    );
    expect(out).toMatchObject({ kind: 'adopt', estCost: 330 });
  });

  it('a 23-night house sit described Cost: 110 adopts at 2530, across a month boundary', () => {
    // The sitter's live 2026-07-29 → 08-21 sit. Any month-length assumption (30 or 31 days) or a
    // day-of-month subtraction lands somewhere other than 23 nights.
    const out = classifyEvent(
      event({
        summary: 'Sadie House sit',
        description: 'Cost: 110',
        start: '2026-07-29',
        end: '2026-08-21',
        allDay: true,
      }),
      rangeCtx('house-sitting', 'House sitting'),
    );
    expect(out).toMatchObject({ kind: 'adopt', estCost: 2530 });
  });

  it('a 1-night stay described Cost: 100 adopts at 100 — the multiplier is not off by one', () => {
    // nightsBetween('2026-07-17', '2026-07-18') === 1 (the repo's own definition of a night: the
    // end date is exclusive). Billing nights + 1 would read $200 here.
    expect(nightsBetween('2026-07-17', '2026-07-18')).toBe(1);
    const out = classifyEvent(
      event({
        summary: 'Sadie Boarding',
        description: 'Cost: 100',
        start: '2026-07-17',
        end: '2026-07-18',
        allDay: true,
      }),
      rangeCtx('boarding', 'Boarding'),
    );
    expect(out).toMatchObject({ kind: 'adopt', estCost: 100 });
  });

  it('multiplies over the NORMALIZED span of a timed event, not its raw inclusive end', () => {
    // Fri 18:00 – Sun 09:00: Google's end is inclusive on a timed event, so the stay is 3 nights
    // (Fri/Sat/Sun), not 2. Multiplying the raw end would read $100.
    const out = classifyEvent(
      event({
        summary: 'Sadie Boarding',
        description: 'Cost: 50',
        start: '2026-07-03',
        end: '2026-07-05',
        allDay: false,
      }),
      rangeCtx('boarding', 'Boarding'),
    );
    expect(out).toMatchObject({ kind: 'adopt', endDate: '2026-07-06', estCost: 150 });
  });

  it('a single-day service adopts its description Cost: unchanged', () => {
    // CTX's walk is shape: 'single' — there are no nights to multiply by and the figure is the
    // whole charge.
    const out = classifyEvent(event({ summary: 'Sadie Walk', description: 'Cost: 40' }), CTX);
    expect(out).toMatchObject({ kind: 'adopt', endDate: null, estCost: 40 });
  });

  it('a single-day service spanning several days STILL adopts its Cost: unchanged', () => {
    // The shape gate, isolated: this walk's span is 3 days wide, so an implementation that
    // multiplied without checking shape would read $120. A single-shaped row carries no end date
    // and therefore no nights at all.
    const out = classifyEvent(
      event({
        summary: 'Sadie Walk',
        description: 'Cost: 40',
        start: '2026-07-01',
        end: '2026-07-04',
        allDay: true,
      }),
      CTX,
    );
    expect(out).toMatchObject({ kind: 'adopt', endDate: null, estCost: 40 });
  });

  it('leaves the rate card path alone — its cost is already a total for the whole span', () => {
    // No description Cost: at all, so priceFor answers. That number is a computed total and must
    // be adopted as-is; multiplying it too would read $450.
    const out = classifyEvent(
      event({
        summary: 'Sadie Boarding',
        description: 'Owner: Lauren Kotin',
        start: '2026-07-17',
        end: '2026-07-20',
        allDay: true,
      }),
      {
        ...rangeCtx('boarding', 'Boarding'),
        priceFor: () => ({ priced: true as const, cost: 150 }),
      },
    );
    expect(out).toMatchObject({ kind: 'adopt', estCost: 150 });
  });

  it('refuses a range span with no whole night rather than adopting a $0 stay', () => {
    // A degenerate all-day event (end === start) yields 0 nights. There is no honest product to
    // adopt, so this takes the same needs-price arm an unpriced pet set takes — the sitter prices
    // it herself. No cost field is invented: not 0, not null, not the un-multiplied rate.
    const out = classifyEvent(
      event({
        summary: 'Sadie Boarding',
        description: 'Cost: 100',
        start: '2026-07-17',
        end: '2026-07-17',
        allDay: true,
      }),
      rangeCtx('boarding', 'Boarding'),
    );
    expect(out).toMatchObject({ kind: 'needs-price', startDate: '2026-07-17' });
    expect(out).not.toHaveProperty('estCost');
  });
});
