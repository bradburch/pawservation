/**
 * `PUT /api/:slug/bookings/:id` — the customer edits their own booking.
 *
 * Written BEFORE the implementation (TDD), because the whole risk of this feature is that an edit
 * skips a validation a create performs. Each test below pins one rule the create path enforces and
 * asserts the edit enforces it too — and, where the edit is refused, that the stored booking is
 * left exactly as it was.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  addBookingPets,
  insertBookingCharge,
  insertBookingRequest,
  insertPayment,
  setBookingGCalEventId,
  setProviderTokens,
} from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import {
  adminHeaders,
  createTestEnv,
  endUserToken,
  seedPets,
  TENANT_A,
  TEST_SECRET,
} from './helpers';
import type { AnalyticsPayload } from '../../app/shared-ui/api';
import type { DatabaseSync } from 'node:sqlite';

const SLUG = 'sunny-paws';
const JESS = 'eu_sp_jess';
const BELLA = 'pet_sp_bella'; // dog
const MOCHI = 'pet_sp_mochi'; // cat
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

/** Sunny Paws boarding: $50/night, pool cap 2 pets/day, PetRateMode 'exact'. */
const START = addDays(TODAY, 40);
const END = addDays(TODAY, 43); // 3 nights → $150 for one pet

type Over = {
  status?: 'pending' | 'confirmed';
  serviceType?: string;
  startDate?: string;
  endDate?: string | null;
  optionKey?: string | null;
  endUserId?: string | null;
  petIds?: string[];
  petCount?: number;
  estCost?: number | null;
  startTime?: string | null;
  answers?: Record<string, string>;
};

async function seedBooking(env: Env, over: Over = {}): Promise<string> {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
    endUserId: over.endUserId === undefined ? JESS : over.endUserId,
    serviceType: over.serviceType ?? 'boarding',
    startDate: over.startDate ?? START,
    endDate: over.endDate === undefined ? END : over.endDate,
    optionKey: over.optionKey === undefined ? 'standard' : over.optionKey,
    petCount: over.petCount ?? (over.petIds?.length || 1),
    startTime: over.startTime ?? null,
    estCost: over.estCost === undefined ? 150 : over.estCost,
    status: over.status ?? 'pending',
    answers: over.answers,
  });
  await addBookingPets(env.PAWSERVATION_DB, TENANT_A, id, over.petIds ?? [BELLA]);
  return id;
}

type EditBody = {
  startDate?: string;
  endDate?: string;
  startTime?: string;
  departureTime?: string;
  petIds?: string[];
  answers?: Record<string, string>;
  // Not part of the contract — present only so a test can prove it is IGNORED.
  type?: string;
  optionKey?: string;
};

async function edit(env: Env, token: string, id: string, body: EditBody): Promise<Response> {
  return app.request(
    `/api/${SLUG}/bookings/${id}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function row(env: Env, id: string) {
  return (await env.PAWSERVATION_DB.prepare(
    `SELECT StartDate, EndDate, StartTime, DepartureTime, PetCount, EstCost, Status, Answers,
            CancellationFee, GCalEventId, SyncPending
       FROM BookingRequests WHERE Id = ?`,
  )
    .bind(id)
    .first<{
      StartDate: string;
      EndDate: string | null;
      StartTime: string | null;
      DepartureTime: string | null;
      PetCount: number;
      EstCost: number | null;
      Status: string;
      Answers: string;
      CancellationFee: number | null;
      GCalEventId: string | null;
      SyncPending: number;
    }>())!;
}

async function bookingPetIds(env: Env, id: string): Promise<string[]> {
  const { results } = await env.PAWSERVATION_DB.prepare(
    'SELECT PetId FROM BookingRequestPets WHERE BookingRequestId = ? ORDER BY PetId',
  )
    .bind(id)
    .all<{ PetId: string }>();
  return results.map((r) => r.PetId);
}

function setService(raw: DatabaseSync, sets: string, serviceType = 'boarding'): void {
  raw.exec(
    `UPDATE TenantServices SET ${sets} WHERE TenantId = '${TENANT_A}' AND ServiceType = '${serviceType}'`,
  );
}

const ONE_QUESTION = JSON.stringify([
  { id: 'q1', label: 'Feeding routine', type: 'text', required: true },
]);

async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

describe('PUT /:slug/bookings/:id — the customer changes their own booking', () => {
  afterEach(() => vi.restoreAllMocks());

  it('moves the dates and re-stamps EstCost from the new span', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: addDays(TODAY, 50),
      endDate: addDays(TODAY, 55), // 5 nights
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, estCost: 250, status: 'pending' });
    const after = await row(env, id);
    expect(after.StartDate).toBe(addDays(TODAY, 50));
    expect(after.EndDate).toBe(addDays(TODAY, 55));
    // Re-stamped, deliberately: EstCost is the price OF the booking as it stands, and a moved or
    // lengthened stay costs a different amount. See booking-ops.ts's `editBooking` doc block.
    expect(after.EstCost).toBe(250);
    expect(after.SyncPending).toBe(1);
  });

  it('sends a CONFIRMED booking back to pending, with no cancellation fee', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, { status: 'confirmed' });

    const res = await edit(env, token, id, {
      startDate: addDays(TODAY, 41),
      endDate: addDays(TODAY, 44),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('pending');
    const after = await row(env, id);
    expect(after.Status).toBe('pending');
    // Rescheduling keeps the sitter's work; charging for it would push customers to cancel.
    expect(after.CancellationFee).toBeNull();
  });

  it('replaces the pet set and re-prices it (linear mode doubles for two pets)', async () => {
    const { env, raw } = createTestEnv();
    setService(raw, "PetRateMode = 'linear'");
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [BELLA, MOCHI],
      answers: {},
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { estCost: number }).estCost).toBe(300); // 3 nights × $50 × 2
    expect(await bookingPetIds(env, id)).toEqual([BELLA, MOCHI].sort());
    expect((await row(env, id)).PetCount).toBe(2);
  });

  it('refuses an unpriced pet set under the default exact mode, leaving the booking untouched', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [BELLA, MOCHI],
      answers: {},
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unpriced_pet_set');
    expect(await bookingPetIds(env, id)).toEqual([BELLA]);
    expect((await row(env, id)).EstCost).toBe(150);
  });

  /**
   * The re-quote is what makes an edit honest, but it must not be able to make an editable booking
   * UNEDITABLE. `/bookings/mine` advertises `editable: true` from status + start date alone, so a
   * re-price that can fail on a set the customer is not changing is a booking the widget offers to
   * edit and the server always refuses — the customer's only exit being a cancellation, possibly
   * with a fee.
   *
   * The trigger needs no bad data: the sitter flipping `PetRateMode` back to 'exact', a
   * `replaceServiceOptions` that scrubs the pet-set rate rows, or a `deleteService`/re-create all
   * strand every existing multi-pet booking the same way.
   *
   * PRICE-RELEVANT = the dates and the pet id set (the only two `estimateCost` inputs an edit can
   * change; the service and its option come from the stored row). When neither moved, the stored
   * `EstCost` is still the price of exactly this request and is kept as-is.
   */
  it('keeps the stored price when nothing price-relevant changed, even if the set is no longer quotable', async () => {
    const { env, raw } = createTestEnv();
    // Priced when the service was 'linear': 3 nights × $50 × 2 pets.
    setService(raw, "PetRateMode = 'linear'");
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, { petIds: [BELLA, MOCHI], estCost: 300 });
    // …and the sitter flips the service back to 'exact' with no two-pet rate stored, so this exact
    // set can no longer be quoted at all.
    setService(raw, "PetRateMode = 'exact'");

    const res = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [MOCHI, BELLA], // same SET, different order — a set, not a list
      startTime: '14:30', // the only thing actually changing
      answers: {},
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, estCost: 300, status: 'pending' });
    const after = await row(env, id);
    expect(after.EstCost).toBe(300);
    expect(after.StartTime).toBe('14:30');
  });

  it('still re-prices when the DATES move, holiday rate and all', async () => {
    const { env, raw } = createTestEnv();
    // A holiday rate makes the re-quote observable in a way a flat rate could not: moving onto
    // Christmas must cost the holiday rate, not the stored number.
    setService(raw, 'HolidayRate = 90');
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    // Dec 26 → Dec 28: two ordinary nights, $100.
    const year = Number(TODAY.slice(0, 4)) + 1;
    const id = await seedBooking(env, {
      startDate: `${year}-12-26`,
      endDate: `${year}-12-28`,
      estCost: 100,
    });

    const res = await edit(env, token, id, {
      startDate: `${year}-12-24`, // moved BACK onto Christmas Eve + Christmas Day
      endDate: `${year}-12-27`, // nights of the 24th, 25th, 26th
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(200);
    // $90 (Christmas Eve) + $90 (Christmas Day) + $50 — re-quoted, not the stored 100.
    expect(((await res.json()) as { estCost: number }).estCost).toBe(230);
    expect((await row(env, id)).EstCost).toBe(230);
  });

  it('still re-prices when the PET SET changes under linear mode', async () => {
    const { env, raw } = createTestEnv();
    setService(raw, "PetRateMode = 'linear'");
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, { estCost: 150 });

    const res = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [BELLA, MOCHI], // the set MOVED — re-price
      answers: {},
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { estCost: number }).estCost).toBe(300);
  });

  it('re-prices a never-priced booking rather than keeping its NULL EstCost', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, { estCost: null });

    const res = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [BELLA],
      startTime: '09:00',
      answers: {},
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { estCost: number }).estCost).toBe(150);
  });

  it('re-runs the booking window: too soon', async () => {
    const { env, raw } = createTestEnv();
    setService(raw, 'MinLeadDays = 5');
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: addDays(TODAY, 1),
      endDate: addDays(TODAY, 3),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('too_soon');
    expect((await row(env, id)).StartDate).toBe(START);
  });

  it('re-runs the booking window: too far ahead', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET MaxAdvanceMonths = 2 WHERE Id = '${TENANT_A}'`);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: addDays(TODAY, 300),
      endDate: addDays(TODAY, 302),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('too_far_ahead');
  });

  it('refuses dates in the past', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: addDays(TODAY, -3),
      endDate: addDays(TODAY, -1),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('date_in_past');
  });

  it('refuses a capacity conflict and PUTS THE ORIGINAL BOOKING BACK', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const mine = await seedBooking(env);
    // The pool caps boarding at 2 pets/day; someone else already has both slots on these dates.
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: addDays(TODAY, 60),
      endDate: addDays(TODAY, 64),
      optionKey: 'standard',
      petCount: 2,
      estCost: 400,
      status: 'confirmed',
    });

    const res = await edit(env, token, mine, {
      startDate: addDays(TODAY, 61),
      endDate: addDays(TODAY, 63),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('capacity_conflict');
    const after = await row(env, mine);
    expect(after.StartDate).toBe(START);
    expect(after.EndDate).toBe(END);
    expect(after.EstCost).toBe(150);
    expect(await bookingPetIds(env, mine)).toEqual([BELLA]);
  });

  it('re-runs the house-sit / boarding handover rule', async () => {
    const { env, raw } = createTestEnv();
    // Never overlap: a boarding may not share a single day with a house sit.
    raw.exec(`UPDATE Tenants SET HousesitBoardingOverlapDays = 0 WHERE Id = '${TENANT_A}'`);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const mine = await seedBooking(env);
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'housesitting',
      startDate: addDays(TODAY, 70),
      endDate: addDays(TODAY, 75),
      optionKey: 'standard',
      petCount: 1,
      estCost: 350,
      status: 'confirmed',
    });

    const res = await edit(env, token, mine, {
      startDate: addDays(TODAY, 71),
      endDate: addDays(TODAY, 73),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('overlap_not_allowed');
    expect((await row(env, mine)).StartDate).toBe(START);
  });

  it('re-runs per-service pet-type acceptance', async () => {
    const { env, raw } = createTestEnv();
    setService(raw, `AcceptedPetTypes = '["dog"]'`);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [MOCHI], // a cat
      answers: {},
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('pet_type_not_accepted');
    expect(await bookingPetIds(env, id)).toEqual([BELLA]);
  });

  it('re-runs MaxPetCount', async () => {
    const { env, raw } = createTestEnv();
    setService(raw, "MaxPetCount = 1, PetRateMode = 'linear'");
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [BELLA, MOCHI],
      answers: {},
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('service_constraint');
  });

  it('re-runs MaxNights', async () => {
    const { env, raw } = createTestEnv();
    setService(raw, 'MaxNights = 4');
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      startDate: START,
      endDate: addDays(TODAY, 50), // 10 nights
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('stay_too_long');
  });

  it('re-validates intake answers, and a valid edit updates BOTH the booking and the saved pre-fill', async () => {
    const { env, raw } = createTestEnv();
    setService(raw, `Questions = '${ONE_QUESTION}'`);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, { answers: { q1: 'Two cups, 7am' } });

    const bad = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [BELLA],
      answers: {}, // required question left blank
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('invalid_answers');

    const good = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [BELLA],
      answers: { q1: 'One cup, 6pm' },
    });
    expect(good.status).toBe(200);
    expect(JSON.parse((await row(env, id)).Answers)).toEqual({ q1: 'One cup, 6pm' });
    const saved = await env.PAWSERVATION_DB.prepare(
      'SELECT Value FROM SavedAnswers WHERE TenantId = ? AND EndUserId = ? AND ServiceType = ? AND QuestionId = ?',
    )
      .bind(TENANT_A, JESS, 'boarding', 'q1')
      .first<{ Value: string }>();
    expect(saved?.Value).toBe('One cup, 6pm');
  });

  it('cannot change the service, even when the body names another one', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);

    const res = await edit(env, token, id, {
      type: 'daycare',
      optionKey: 'standard',
      startDate: addDays(TODAY, 45),
      endDate: addDays(TODAY, 47),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(200);
    const stored = await env.PAWSERVATION_DB.prepare(
      'SELECT ServiceType, OptionKey FROM BookingRequests WHERE Id = ?',
    )
      .bind(id)
      .first<{ ServiceType: string; OptionKey: string }>();
    // Still a boarding, still on its own option — the service is read from the row, never the body.
    expect(stored).toEqual({ ServiceType: 'boarding', OptionKey: 'standard' });
  });

  it('is customer-scoped: another customer’s booking is an indistinguishable 404', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT OR REPLACE INTO EndUsers (Id, TenantId, Email, Name, Status)
       VALUES ('eu_sp_other', '${TENANT_A}', 'other@example.com', 'Other', 'active')`,
    );
    seedPets(raw, TENANT_A, 'eu_sp_other', [{ id: 'pet_other', petType: 'dog' }]);
    const theirs = await seedBooking(env, { endUserId: 'eu_sp_other', petIds: ['pet_other'] });
    const token = await endUserToken(env, SLUG, 'jess@example.com');

    const res = await edit(env, token, theirs, {
      startDate: addDays(TODAY, 45),
      endDate: addDays(TODAY, 47),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('unknown_booking');
    expect((await row(env, theirs)).StartDate).toBe(START);
  });

  it('refuses a terminal booking and one whose stay has already started', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const cancelled = await seedBooking(env, { status: 'pending' });
    await env.PAWSERVATION_DB.prepare(
      "UPDATE BookingRequests SET Status = 'cancelled' WHERE Id = ?",
    )
      .bind(cancelled)
      .run();
    const started = await seedBooking(env, {
      status: 'confirmed',
      startDate: addDays(TODAY, -2),
      endDate: addDays(TODAY, 3),
    });

    for (const id of [cancelled, started]) {
      const res = await edit(env, token, id, {
        startDate: addDays(TODAY, 45),
        endDate: addDays(TODAY, 47),
        petIds: [BELLA],
        answers: {},
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('not_editable');
    }
  });

  it('leaves the sitter’s extra charges alone', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: id,
      label: 'Medication',
      amount: 15,
    });

    const res = await edit(env, token, id, {
      startDate: addDays(TODAY, 50),
      endDate: addDays(TODAY, 52),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(200);
    const charges = await env.PAWSERVATION_DB.prepare(
      'SELECT Label, Amount FROM BookingCharges WHERE BookingRequestId = ?',
    )
      .bind(id)
      .all<{ Label: string; Amount: number }>();
    expect(charges.results).toEqual([{ Label: 'Medication', Amount: 15 }]);
    // The estimate is re-stamped and the charge is still additive on top of it.
    expect((await row(env, id)).EstCost).toBe(100);
  });

  /**
   * The other half of "EstCost is re-stamped": a stay already PAID FOR, then shortened. `EstCost`
   * drops, the row returns to 'pending', and the money already banked exceeds what the booking may
   * keep. `OUTSTANDING_WHERE_SQL` asks only whether something is still OWED, so before this the
   * $150 of over-payment appeared on no screen at all — and after re-confirmation `100 > 250` is
   * false, so it never came back as outstanding either. The Earnings page names it instead.
   */
  it('an edit that lowers the price below what was already paid surfaces the overpayment', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    // 5 nights at $50 = $250, confirmed and paid in full.
    const id = await seedBooking(env, {
      status: 'confirmed',
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 45),
      estCost: 250,
    });
    expect(
      await insertPayment(env.PAWSERVATION_DB, TENANT_A, {
        bookingRequestId: id,
        amount: 250,
        method: 'cash',
        paidDate: TODAY,
        note: null,
        externalRef: null,
      }),
    ).not.toBeNull();

    const res = await edit(env, token, id, {
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 42), // 2 nights → $100
      petIds: [BELLA],
      answers: {},
    });
    expect(res.status).toBe(200);
    expect((await row(env, id)).EstCost).toBe(100);

    const earnings = (await (
      await app.request(
        `/api/${SLUG}/admin/analytics`,
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as AnalyticsPayload;
    expect(earnings.credits.find((c) => c.bookingId === id)).toMatchObject({
      credit: 150,
      paidTotal: 250,
      keepable: 100,
      status: 'pending',
    });
    expect(earnings.tiles.creditTotal).toBe(150);
    // And it is NOT also reported as owing — the two predicates are mutually exclusive.
    expect(earnings.outstanding.find((o) => o.bookingId === id)).toBeUndefined();
  });

  it('accepts and clears an arrival time, and refuses a malformed one', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, { startTime: '09:00' });

    const bad = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      startTime: '25:99',
      petIds: [BELLA],
      answers: {},
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('invalid_start_time');

    const good = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      startTime: '16:30',
      petIds: [BELLA],
      answers: {},
    });
    expect(good.status).toBe(200);
    expect((await row(env, id)).StartTime).toBe('16:30');

    const cleared = await edit(env, token, id, {
      startDate: START,
      endDate: END,
      petIds: [BELLA],
      answers: {},
    });
    expect(cleared.status).toBe(200);
    expect((await row(env, id)).StartTime).toBeNull();
  });

  it('moves the Google event and keeps its id', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, { status: 'confirmed' });
    await setBookingGCalEventId(env.PAWSERVATION_DB, TENANT_A, id, 'evt_1', null);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_1' }), { status: 200 }));

    const res = await edit(env, token, id, {
      startDate: addDays(TODAY, 50),
      endDate: addDays(TODAY, 52),
      petIds: [BELLA],
      answers: {},
    });

    expect(res.status).toBe(200);
    const call = spy.mock.calls.find(([url]) => String(url).includes('/events/evt_1'));
    expect(call).toBeTruthy();
    const body = JSON.parse(String((call![1] as RequestInit).body)) as {
      summary: string;
      start: { date: string };
    };
    // Back to a REQUEST — she has to re-approve the new dates — and moved to them.
    expect(body.summary.startsWith('[REQUEST]')).toBe(true);
    expect(body.start.date).toBe(addDays(TODAY, 50));
    expect((await row(env, id)).GCalEventId).toBe('evt_1');
  });

  it('/bookings/mine tells the widget what it needs to open the edit form', async () => {
    const { env, raw } = createTestEnv();
    setService(raw, `Questions = '${ONE_QUESTION}'`);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, { startTime: '09:00', answers: { q1: 'Two cups' } });

    const res = await app.request(
      `/api/${SLUG}/bookings/mine`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const { bookings } = (await res.json()) as {
      bookings: {
        id: string;
        editable: boolean;
        petIds: string[];
        startTime: string | null;
        answers: Record<string, string>;
      }[];
    };
    const mine = bookings.find((b) => b.id === id)!;
    expect(mine.editable).toBe(true);
    expect(mine.petIds).toEqual([BELLA]);
    expect(mine.startTime).toBe('09:00');
    expect(mine.answers).toEqual({ q1: 'Two cups' });
  });

  it('the quote and the grid can exclude the booking being edited, so a stay never blocks itself', async () => {
    const { env, raw } = createTestEnv();
    // Cap the pool at ONE pet, so Jess's own two-night stay fills it by itself.
    setService(raw, 'MaxConcurrentPets = 1');
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env);
    const qs = new URLSearchParams({
      type: 'boarding',
      option: 'standard',
      start: START,
      end: END,
      petIds: BELLA,
    });
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    const blocked = await app.request(`/api/${SLUG}/availability?${qs}`, auth, env);
    expect(((await blocked.json()) as { available: boolean }).available).toBe(false);

    const clear = await app.request(
      `/api/${SLUG}/availability?${qs}&excludeBookingId=${id}`,
      auth,
      env,
    );
    expect(await clear.json()).toMatchObject({ available: true, priced: true, estCost: 150 });

    const grid = await app.request(
      `/api/${SLUG}/availability/month?type=boarding&month=${START.slice(0, 7)}&excludeBookingId=${id}`,
      auth,
      env,
    );
    const { days } = (await grid.json()) as { days: { date: string; status: string }[] };
    expect(days.find((d) => d.date === START)?.status).toBe('available');
  });

  it('refuses an exclusion id the caller does not own', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT OR REPLACE INTO EndUsers (Id, TenantId, Email, Name, Status)
       VALUES ('eu_sp_other', '${TENANT_A}', 'other@example.com', 'Other', 'active')`,
    );
    seedPets(raw, TENANT_A, 'eu_sp_other', [{ id: 'pet_other2', petType: 'dog' }]);
    const theirs = await seedBooking(env, { endUserId: 'eu_sp_other', petIds: ['pet_other2'] });
    const token = await endUserToken(env, SLUG, 'jess@example.com');

    const res = await app.request(
      `/api/${SLUG}/availability?type=boarding&option=standard&start=${START}&end=${END}&petIds=${BELLA}&excludeBookingId=${theirs}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unknown_booking');
  });

  /**
   * DELIBERATE BEHAVIOUR CHANGE (0008). This test used to assert that a DAYCARE edit rejected an
   * arrival time, under the old rule "the option owns the clock on a single-day service". Daycare's
   * option never owned a clock — it is a whole day with no fixed appointment and simply had no time
   * at all — so it now takes owner-set times like a stay does. The rule survives, narrowed to the
   * services it is actually true of (`HasDuration = 1`: walks and check-ins, whose option slot IS
   * the appointment) and pinned below on a walk, with the daycare case rewritten to assert the new
   * behaviour rather than deleted.
   */
  it('a single-day service edits its one date and takes both owner-set times', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, {
      serviceType: 'daycare',
      endDate: null,
      estCost: 40,
    });

    // Both times on ONE day, so the departure must be strictly later than the arrival.
    const bad = await edit(env, token, id, {
      startDate: addDays(TODAY, 45),
      startTime: '10:00',
      departureTime: '09:00',
      petIds: [BELLA],
      answers: {},
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('invalid_departure_time');

    const good = await edit(env, token, id, {
      startDate: addDays(TODAY, 45),
      startTime: '08:00',
      departureTime: '17:00',
      petIds: [BELLA],
      answers: {},
    });
    expect(good.status).toBe(200);
    const after = await row(env, id);
    expect(after.StartDate).toBe(addDays(TODAY, 45));
    expect(after.EndDate).toBeNull();
    expect(after.StartTime).toBe('08:00');
    expect(after.DepartureTime).toBe('17:00');
    // A time is not price-relevant: the stored estimate is kept verbatim.
    expect(after.EstCost).toBe(40);
  });

  it('a duration-priced option still owns the clock — a walk edit rejects an arrival time', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const id = await seedBooking(env, {
      serviceType: 'walk',
      optionKey: 'd30',
      endDate: null,
      estCost: 25,
    });

    const bad = await edit(env, token, id, {
      startDate: addDays(TODAY, 45),
      startTime: '10:00',
      petIds: [BELLA],
      answers: {},
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('invalid_start_time');
  });
});
