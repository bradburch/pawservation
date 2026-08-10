import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { insertBackfilledBooking, replaceServicePetRates, setProviderTokens } from '../db/repo';
// Namespace import alongside the named one above, used only to spy on a single repo function
// (forcing a mid-loop write failure) without touching every other test's real DB behavior.
import * as repoModule from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { buildMixKey, mixFromPetTypes } from '../../src/shared/index.js';
import { adminHeaders, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Classified } from '../lib/calendar-backfill';

// Fixed by sql/seed.sql for tnt_sunnypaws / slug sunny-paws: owner eu_sp_jess with pets Bella
// (dog, pet_sp_bella) and Mochi (cat, pet_sp_mochi); services 'boarding' (range/night, one
// option 'standard' @ $50) and 'walk' (single, options ordered by DurationMinutes — 'd30' @ $20
// is first and is what a title naming no duration resolves to).

// Copied from calendar-reconcile.test.ts (:32, :50) — Google is stubbed at fetch, there is no
// injection seam for listCalendarEvents.
async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z', // far future — no refresh-token fetch needed
    calendarId: 'primary',
  });
}

type FakeEvent = {
  id?: string;
  summary?: string;
  status?: string;
  bookingId?: string; // present → a Pawservation event
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

function calendarResponse(events: FakeEvent[]) {
  return new Response(
    JSON.stringify({
      items: events.map((e) => ({
        id: e.id ?? 'evt_anon',
        summary: e.summary ?? 'Boarding',
        status: e.status ?? 'confirmed',
        updated: '2026-07-27T00:00:00Z',
        start: e.start ?? { date: '2026-06-10' },
        end: e.end ?? { date: '2026-06-13' },
        ...(e.bookingId
          ? {
              extendedProperties: {
                private: { pawservation: 'true', category: 'boarding', bookingId: e.bookingId },
              },
            }
          : {}),
      })),
    }),
    { status: 200 },
  );
}

afterEach(() => vi.restoreAllMocks());

type PreviewBody = {
  adopt: Classified[];
  needsPrice: Classified[];
  flags: Classified[];
  skipped: number;
};

async function preview(env: Env, from = '2026-06-01', to = '2026-06-30'): Promise<PreviewBody> {
  const res = await app.request(
    '/api/sunny-paws/admin/calendar/backfill/preview',
    {
      method: 'POST',
      headers: await adminHeaders(TENANT_A),
      body: JSON.stringify({ from, to }),
    },
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PreviewBody;
}

describe('POST /:slug/admin/calendar/backfill/preview', () => {
  it('refuses a range with more events than the cap, naming the count', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    // 201 events, one over MAX_BACKFILL_EVENTS.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse(
        Array.from({ length: 201 }, (_, i) => ({ id: `ev${i}`, summary: 'Sadie Walk' })),
      ),
    );

    const res = await app.request(
      '/api/sunny-paws/admin/calendar/backfill/preview',
      {
        method: 'POST',
        headers: await adminHeaders(TENANT_A),
        body: JSON.stringify({ from: '2026-01-01', to: '2026-12-31' }),
      },
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('201');
  });

  it('refuses a malformed range', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    const res = await app.request(
      '/api/sunny-paws/admin/calendar/backfill/preview',
      {
        method: 'POST',
        headers: await adminHeaders(TENANT_A),
        body: JSON.stringify({ from: '2026-12-31', to: '2026-01-01' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('classifies a real single-pet event into adopt, and a single-shape service has endDate: null', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([
        {
          id: 'ev_bella_walk',
          summary: 'Bella Walk',
          start: { date: '2026-06-10' },
          end: { date: '2026-06-10' },
        },
      ]),
    );

    const body = await preview(env);
    expect(body.adopt).toHaveLength(1);
    const row = body.adopt[0] as Extract<Classified, { kind: 'adopt' }>;
    expect(row.endUserId).toBe('eu_sp_jess');
    expect(row.serviceType).toBe('walk');
    expect(row.optionKey).toBe('d30');
    expect(row.petIds).toEqual(['pet_sp_bella']);
    expect(row.estCost).toBe(20); // 'd30' option's flat rate — single pet, no group/mix rate
    expect(row.endDate).toBeNull(); // shape: 'single' — never carries an end date
  });

  it('prices from the resolved service\'s own option and rate card, not another service\'s', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    // Same pet-set mix (Bella + Mochi = one dog, one cat) priced differently under two services —
    // if `priceFor` ever cross-wired a service to another's option/rates, one of these two prices
    // would come out wrong (or fall back to the flat option rate) instead of matching its own card.
    const mixKey = buildMixKey(mixFromPetTypes(['dog', 'cat']));
    await replaceServicePetRates(env.PAWSERVATION_DB, TENANT_A, 'boarding', 'standard', [
      { mixKey, rate: 999 },
    ]);
    await replaceServicePetRates(env.PAWSERVATION_DB, TENANT_A, 'walk', 'd30', [
      { mixKey, rate: 42 },
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([
        {
          id: 'ev_board',
          summary: 'Bella and Mochi Boarding',
          start: { date: '2026-06-10' },
          end: { date: '2026-06-13' }, // 3 nights
        },
        {
          id: 'ev_walk',
          summary: 'Bella and Mochi Walk',
          start: { date: '2026-06-15' },
          end: { date: '2026-06-15' },
        },
      ]),
    );

    const body = await preview(env);
    const byId = new Map(body.adopt.map((r) => [(r as { eventId: string }).eventId, r]));
    const boarding = byId.get('ev_board') as Extract<Classified, { kind: 'adopt' }>;
    const walk = byId.get('ev_walk') as Extract<Classified, { kind: 'adopt' }>;
    expect(boarding).toBeDefined();
    expect(walk).toBeDefined();
    expect(boarding.serviceType).toBe('boarding');
    expect(boarding.optionKey).toBe('standard');
    expect(boarding.estCost).toBe(999 * 3); // boarding's own mix rate, times 3 nights
    expect(walk.serviceType).toBe('walk');
    expect(walk.optionKey).toBe('d30');
    expect(walk.estCost).toBe(42); // walk's own mix rate, one unit — never boarding's 999
  });

  it('a needs-price row has no estCost key at all after JSON serialization', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    // Two pets, no group/mix rate seeded anywhere for this tenant, PetRateMode default 'exact' —
    // estimateCost refuses rather than inventing a number (CLAUDE.md's unpriced-pet-set trap).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([
        {
          id: 'ev_needs_price',
          summary: 'Bella and Mochi Walk',
          start: { date: '2026-06-10' },
          end: { date: '2026-06-10' },
        },
      ]),
    );

    const res = await app.request(
      '/api/sunny-paws/admin/calendar/backfill/preview',
      {
        method: 'POST',
        headers: await adminHeaders(TENANT_A),
        body: JSON.stringify({ from: '2026-06-01', to: '2026-06-30' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { needsPrice: Record<string, unknown>[] };
    expect(parsed.needsPrice).toHaveLength(1);
    const row = parsed.needsPrice[0];
    expect(row.serviceType).toBe('walk');
    expect(row.petIds).toEqual(['pet_sp_bella', 'pet_sp_mochi']);
    // Not `estCost: undefined` — the KEY itself must be absent from the parsed JSON.
    expect(Object.prototype.hasOwnProperty.call(row, 'estCost')).toBe(false);
  });

  it('an adopted-then-cancelled event is still skipped, not offered for re-adoption', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    await insertBackfilledBooking(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: 'eu_sp_jess',
      serviceType: 'walk',
      startDate: '2026-06-10',
      endDate: null,
      optionKey: 'd30',
      petCount: 1,
      estCost: 20,
      status: 'cancelled', // the booking was cancelled; the Google event is still on the calendar
      gcalEventId: 'ev_already_adopted',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([
        {
          id: 'ev_already_adopted',
          summary: 'Bella Walk',
          start: { date: '2026-06-10' },
          end: { date: '2026-06-10' },
        },
      ]),
    );

    const body = await preview(env);
    // listAdoptedEventIds (unfiltered by status) must still catch this — listActiveAdoptedEventIds
    // would not, and that is exactly the re-adoption bug this test exists to catch.
    expect(body.adopt).toHaveLength(0);
    expect(body.needsPrice).toHaveLength(0);
    expect(body.flags).toHaveLength(0);
    expect(body.skipped).toBe(1);
  });
});

type ImportBody = { imported: number; skipped: { eventId: string; reason: string }[] };

async function runImport(
  env: Env,
  events: unknown[],
  from = '2026-06-01',
  to = '2026-06-30',
): Promise<Response> {
  return app.request(
    '/api/sunny-paws/admin/calendar/backfill/import',
    {
      method: 'POST',
      headers: await adminHeaders(TENANT_A),
      body: JSON.stringify({ from, to, events }),
    },
    env,
  );
}

async function getBooking(env: Env, gcalEventId: string) {
  return env.PAWSERVATION_DB.prepare(
    'SELECT * FROM BookingRequests WHERE TenantId = ? AND GCalEventId = ?',
  )
    .bind(TENANT_A, gcalEventId)
    .first<{
      Id: string;
      EstCost: number;
      EndUserId: string;
      Status: string;
      GCalEventId: string;
      Source: string;
      SyncPending: number;
      ServiceType: string;
      PetCount: number;
    }>();
}

async function getBookingPetIds(env: Env, bookingId: string): Promise<string[]> {
  const { results } = await env.PAWSERVATION_DB.prepare(
    'SELECT PetId FROM BookingRequestPets WHERE BookingRequestId = ?',
  )
    .bind(bookingId)
    .all<{ PetId: string }>();
  return results.map((r) => r.PetId);
}

// Scoped to Source = 'calendar-backfill' rather than the whole table: the seed fixture already
// carries a handful of ordinary BookingRequests rows for TENANT_A, so a bare table count would
// never be zero even on a request that wrote nothing.
async function countBackfilledBookings(env: Env): Promise<number> {
  const row = await env.PAWSERVATION_DB.prepare(
    "SELECT COUNT(*) AS n FROM BookingRequests WHERE TenantId = ? AND Source = 'calendar-backfill'",
  )
    .bind(TENANT_A)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// A single-pet, flat-rate event: same fixture as the preview test 'classifies a real single-pet
// event into adopt' (ev_bella_walk, $20 via walk/d30).
const BELLA_WALK_EVENT = {
  id: 'ev_bella_walk',
  summary: 'Bella Walk',
  start: { date: '2026-06-10' },
  end: { date: '2026-06-10' },
};

// Two pets with no group/mix rate seeded — resolves everything but the price, same as the preview
// test 'a needs-price row has no estCost key at all after JSON serialization'.
const NEEDS_PRICE_EVENT = {
  id: 'ev_needs_price',
  summary: 'Bella and Mochi Walk',
  start: { date: '2026-06-10' },
  end: { date: '2026-06-10' },
};

// "Rex" is not a seeded pet name — classifies as a FLAG ('no-pets'), not adopt/needs-price. This
// is present in the calendar, unlike a plain unknown id, so it exercises the real "the browser
// asked for something the fresh classification refuses" case.
const FLAGGED_EVENT = {
  id: 'ev_flagged',
  summary: 'Rex Walk',
  start: { date: '2026-06-10' },
  end: { date: '2026-06-10' },
};

// The same animal named twice in one title — must resolve, and price, as ONE pet.
const DUPLICATE_NAME_EVENT = {
  id: 'ev_duplicate_name',
  summary: 'Bella and Bella Walk',
  start: { date: '2026-06-10' },
  end: { date: '2026-06-10' },
};

describe('POST /:slug/admin/calendar/backfill/import', () => {
  it('writes an adoptable event with the correct row', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([BELLA_WALK_EVENT]));

    const res = await runImport(env, [{ eventId: 'ev_bella_walk' }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportBody;
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual([]);

    const row = await getBooking(env, 'ev_bella_walk');
    expect(row).toMatchObject({
      EstCost: 20, // 'd30' option's flat rate — same as the preview test
      EndUserId: 'eu_sp_jess',
      Status: 'confirmed',
      GCalEventId: 'ev_bella_walk',
      Source: 'calendar-backfill',
      SyncPending: 0, // never 1 — insertBackfilledBooking, not insertBookingRequest
    });
  });

  it('writes BookingRequestPets rows for the adopted booking', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([BELLA_WALK_EVENT]));

    await runImport(env, [{ eventId: 'ev_bella_walk' }]);

    const row = await getBooking(env, 'ev_bella_walk');
    expect(row).toBeTruthy();
    const petIds = await getBookingPetIds(env, row!.Id);
    expect(petIds).toEqual(['pet_sp_bella']);
  });

  it('adopts nothing on a second run over the same range', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    // A fresh Response per call: a Response body can only be read once, and this test (unlike
    // every other one here) drives the route through fetch twice.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      calendarResponse([BELLA_WALK_EVENT]),
    );

    const first = (await (await runImport(env, [{ eventId: 'ev_bella_walk' }])).json()) as ImportBody;
    expect(first.imported).toBe(1);

    const secondRes = await runImport(env, [{ eventId: 'ev_bella_walk' }]);
    const second = (await secondRes.json()) as ImportBody;
    expect(second.imported).toBe(0);
    expect(second.skipped).toEqual([{ eventId: 'ev_bella_walk', reason: 'Already imported' }]);

    expect(await countBackfilledBookings(env)).toBe(1);
  });

  it('skips an id the fresh classification refuses as a flag, without writing it', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    // FLAGGED_EVENT IS on the calendar — unlike an id absent altogether, this is the real case:
    // the browser asked for an id that a fresh classification actively refuses.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([BELLA_WALK_EVENT, FLAGGED_EVENT]),
    );

    const res = await runImport(env, [{ eventId: 'ev_bella_walk' }, { eventId: 'ev_flagged' }]);
    const body = (await res.json()) as ImportBody;
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual([
      { eventId: 'ev_flagged', reason: 'That event is no longer adoptable' },
    ]);
    expect(await getBooking(env, 'ev_flagged')).toBeNull();
  });

  it('reports an already-adopted id distinctly, so a re-run never reads as data loss', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    await insertBackfilledBooking(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: 'eu_sp_jess',
      serviceType: 'walk',
      startDate: '2026-06-10',
      endDate: null,
      optionKey: 'd30',
      petCount: 1,
      estCost: 20,
      status: 'confirmed',
      gcalEventId: 'ev_bella_walk',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([BELLA_WALK_EVENT]));

    const res = await runImport(env, [{ eventId: 'ev_bella_walk' }]);
    const body = (await res.json()) as ImportBody;
    expect(body.imported).toBe(0);
    expect(body.skipped).toEqual([{ eventId: 'ev_bella_walk', reason: 'Already imported' }]);
  });

  it('counts a pet named twice in one title once: PetCount 1, one BookingRequestPets row', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([DUPLICATE_NAME_EVENT]));

    const res = await runImport(env, [{ eventId: 'ev_duplicate_name' }]);
    const body = (await res.json()) as ImportBody;
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual([]);

    const row = await getBooking(env, 'ev_duplicate_name');
    expect(row?.PetCount).toBe(1);
    // Pricing changed as a result of the dedupe too — one dog, not a 2-dog mix — so pin it, or a
    // future change to how a deduped pet set is priced could regress silently.
    expect(row?.EstCost).toBe(20); // 'd30' option's flat single-pet rate, same as BELLA_WALK_EVENT
    const petIds = await getBookingPetIds(env, row!.Id);
    expect(petIds).toEqual(['pet_sp_bella']);
  });

  it('reports earlier/other successes when one row fails mid-import, instead of a bare 500', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([BELLA_WALK_EVENT, NEEDS_PRICE_EVENT]),
    );
    // Force the FIRST row's own write to throw, as if D1 hiccuped mid-import — while the second
    // row's write is untouched. Proves one event's failure can't crash the whole response or
    // hide the events that DID succeed (and, per Task 7's own idempotency test, can never turn
    // into a booking that's silently un-retryable — nothing was written for it at all).
    vi.spyOn(repoModule, 'insertBackfilledBooking').mockRejectedValueOnce(
      new Error('simulated D1 failure'),
    );

    const res = await runImport(env, [
      { eventId: 'ev_bella_walk' },
      { eventId: 'ev_needs_price', estCost: 50 },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportBody;
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual([
      { eventId: 'ev_bella_walk', reason: 'Could not import that event' },
    ]);
    expect(await getBooking(env, 'ev_bella_walk')).toBeNull();
    expect(await getBooking(env, 'ev_needs_price')).toBeTruthy();
  });

  it('removes the orphaned booking when the pet-link write fails, restoring retryability', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    // A fresh Response per call — this test, like the idempotency test above, drives the route
    // through fetch twice.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      calendarResponse([BELLA_WALK_EVENT]),
    );
    // insertBackfilledBooking succeeds (the booking row commits) and THEN addBookingPets throws
    // — e.g. a transient D1 error, unrelated to the duplicate-name PK case fixed in round 1. The
    // booking row must not be left behind bearing GCalEventId, or it becomes permanently
    // un-retryable (every later run would report "Already imported" for a pet-less booking).
    vi.spyOn(repoModule, 'addBookingPets').mockRejectedValueOnce(
      new Error('simulated pet-link failure'),
    );

    const firstRes = await runImport(env, [{ eventId: 'ev_bella_walk' }]);
    expect(firstRes.status).toBe(200);
    const first = (await firstRes.json()) as ImportBody;
    expect(first.imported).toBe(0);
    expect(first.skipped).toEqual([
      { eventId: 'ev_bella_walk', reason: 'Could not import that event' },
    ]);
    // The orphan is gone, not left behind with GCalEventId stamped.
    expect(await getBooking(env, 'ev_bella_walk')).toBeNull();

    // A second import over the same range — addBookingPets is no longer mocked to fail — must
    // adopt it cleanly. This is the whole point of removing the orphan: were it left behind,
    // listAdoptedEventIds would report it as already-adopted forever, with no pets and no way
    // for the sitter to fix it by importing again.
    const secondRes = await runImport(env, [{ eventId: 'ev_bella_walk' }]);
    const second = (await secondRes.json()) as ImportBody;
    expect(second.imported).toBe(1);
    expect(second.skipped).toEqual([]);
    const row = await getBooking(env, 'ev_bella_walk');
    expect(row).toBeTruthy();
    const petIds = await getBookingPetIds(env, row!.Id);
    expect(petIds).toEqual(['pet_sp_bella']);
  });

  it('an event entry that is not an object is a 400, not a crash', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    // No fetch stub needed — this is refused by body validation before any Google call.
    const res = await runImport(env, [null]);
    expect(res.status).toBe(400);
    expect(await countBackfilledBookings(env)).toBe(0);
  });

  it('adopts a needs-price event only when a price is supplied, at that figure', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([NEEDS_PRICE_EVENT]));

    const res = await runImport(env, [{ eventId: 'ev_needs_price', estCost: 75 }]);
    const body = (await res.json()) as ImportBody;
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual([]);

    const row = await getBooking(env, 'ev_needs_price');
    expect(row?.EstCost).toBe(75); // the sitter's figure — never invented by the server
    expect(row?.ServiceType).toBe('walk');
    const petIds = await getBookingPetIds(env, row!.Id);
    expect([...petIds].sort()).toEqual(['pet_sp_bella', 'pet_sp_mochi']);
  });

  it('skips a needs-price event with no supplied price, writing nothing for it', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([NEEDS_PRICE_EVENT]));

    const res = await runImport(env, [{ eventId: 'ev_needs_price' }]);
    const body = (await res.json()) as ImportBody;
    expect(body.imported).toBe(0);
    expect(body.skipped).toEqual([
      { eventId: 'ev_needs_price', reason: 'That event still needs a price' },
    ]);
    expect(await getBooking(env, 'ev_needs_price')).toBeNull();
  });

  it('overrides the rate card price on an ordinary adopt event when a price is supplied', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([BELLA_WALK_EVENT]));

    const res = await runImport(env, [{ eventId: 'ev_bella_walk', estCost: 99 }]);
    const body = (await res.json()) as ImportBody;
    expect(body.imported).toBe(1);

    const row = await getBooking(env, 'ev_bella_walk');
    expect(row?.EstCost).toBe(99); // sitter's figure, not the rate card's 20
  });

  it.each([0.5, 0, -5, 1_000_001])(
    'a bad estCost (%s) fails the whole request with 400 and writes nothing at all',
    async (badCost) => {
      const { env } = await createTestEnv();
      await connectCalendar(env);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([BELLA_WALK_EVENT]));

      // One perfectly good event alongside the bad one — proves the bad estCost fails the WHOLE
      // request rather than just its own row.
      const res = await runImport(env, [
        { eventId: 'ev_bella_walk' },
        { eventId: 'ev_other', estCost: badCost },
      ]);
      expect(res.status).toBe(400);
      expect(await countBackfilledBookings(env)).toBe(0);
    },
  );

  // Pins today's behavior for every non-integer shape estCost can arrive as, not just the
  // out-of-range numbers above. NaN and Infinity round-trip through JSON.stringify as `null` (JSON
  // has no literal for either), so those two cases exercise the same "no estCost" path as an
  // explicit null over the wire — still worth pinning, since a coercion bug could turn any of
  // these into a truthy, accepted amount.
  it.each(['50', null, true, NaN, Infinity])(
    'a non-integer estCost (%s) is rejected, not coerced',
    async (badCost) => {
      const { env } = await createTestEnv();
      await connectCalendar(env);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([BELLA_WALK_EVENT]));

      const res = await runImport(env, [{ eventId: 'ev_bella_walk', estCost: badCost }]);
      expect(res.status).toBe(400);
      expect(await countBackfilledBookings(env)).toBe(0);
    },
  );
});
