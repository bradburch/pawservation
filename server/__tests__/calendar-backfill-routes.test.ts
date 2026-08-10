import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { insertBackfilledBooking, replaceServicePetRates, setProviderTokens } from '../db/repo';
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
