import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

/**
 * Confirming a pending request re-checks the sitter's COMMITTED calendar.
 *
 * A pending request occupies capacity, but nothing re-validated when the sitter CONFIRMED it — so
 * two pending requests for the same scarce day could both be confirmed, and a confirm could break a
 * rule that did not exist when the request was made (the 0006 handover rule, a blocked day added
 * since, a cap she has since lowered).
 *
 * The answer is NOT a hard refusal: it is her calendar, and refusing a double-booking she
 * deliberately wants would be worse than the hole. So the confirm WARNS and requires an explicit
 * acknowledgement (`overrideCapacity: true`) — she can always say yes, and she can never end up over
 * capacity without having been told.
 *
 * "Committed" means confirmed bookings, blocked days and materialized Google events — NOT other
 * pending requests. A pending request is not a commitment; it is the thing she is adjudicating, and
 * warning about it would fire on the FIRST of two competing requests, where confirming is exactly
 * the right thing to do. Under that rule the first confirm is clean and the SECOND one warns, which
 * is precisely the hole closed.
 */

const bookBoarding = async (
  env: Env,
  petId: string,
  startDate = '2028-10-01',
  endDate = '2028-10-03',
): Promise<string> => {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  const res = await app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'boarding', startDate, endDate, petIds: [petId] }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};

const setStatus = async (
  env: Env,
  id: string,
  status: 'confirmed' | 'declined' | 'cancelled',
  extra: Record<string, unknown> = {},
): Promise<Response> =>
  app.request(
    `/api/sunny-paws/admin/bookings/${id}/status`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ...extra }),
    },
    env,
  );

const statusOf = (raw: DatabaseSync, id: string): string =>
  (raw.prepare('SELECT Status FROM BookingRequests WHERE Id = ?').get(id) as { Status: string })
    .Status;

const lowerBoardingCapTo = (raw: DatabaseSync, cap: number) =>
  raw.exec(
    `UPDATE TenantServices SET MaxConcurrentPets = ${cap}
      WHERE TenantId = '${TENANT_A}' AND ServiceType = 'boarding'`,
  );

const blockOff = (raw: DatabaseSync, start: string, end: string) =>
  raw.exec(
    `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, Status)
     VALUES ('bk_block_${start.replaceAll('-', '')}', '${TENANT_A}', NULL, 'blocked', '${start}', '${end}', 1, 'confirmed')`,
  );

describe('confirm re-checks the committed calendar', () => {
  it('the SECOND confirm on a scarce day is refused with an override prompt', async () => {
    const { env, raw } = createTestEnv();
    // Both requests arrive while Boarding seats two pets a day, so both are legitimately taken.
    const bella = await bookBoarding(env, 'pet_sp_bella');
    const mochi = await bookBoarding(env, 'pet_sp_mochi');
    // …then the sitter lowers her own cap to one pet a day.
    lowerBoardingCapTo(raw, 1);

    // The first confirm stands: nothing is committed on those nights yet.
    expect((await setStatus(env, bella, 'confirmed')).status).toBe(200);

    // The second WOULD put two pets in a one-pet pool. Refused, pending — until she says so.
    const second = await setStatus(env, mochi, 'confirmed');
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      error: string;
      code: string;
      requiresOverride: boolean;
    };
    expect(body.code).toBe('capacity_conflict');
    expect(body.requiresOverride).toBe(true);
    expect(body.error).toContain('Boarding');
    expect(body.error).toContain('1 pet');
    expect(statusOf(raw, mochi)).toBe('pending');
  });

  it('another PENDING request never triggers the warning — only commitments do', async () => {
    const { env, raw } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella');
    await bookBoarding(env, 'pet_sp_mochi');
    lowerBoardingCapTo(raw, 1);
    // Mochi's request sits on the same night and is over the (new) cap, but it is a REQUEST, not a
    // commitment: confirming Bella is the right move and must not be second-guessed.
    expect((await setStatus(env, bella, 'confirmed')).status).toBe(200);
    expect(statusOf(raw, bella)).toBe('confirmed');
  });

  it('a day blocked off AFTER the request was made warns on confirm', async () => {
    const { env, raw } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella', '2028-11-01', '2028-11-04');
    blockOff(raw, '2028-11-02', '2028-11-03');
    const res = await setStatus(env, bella, 'confirmed');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('capacity_conflict');
    expect(body.error.toLowerCase()).toContain('blocked');
    expect(statusOf(raw, bella)).toBe('pending');
  });

  it('she remains the authority: overrideCapacity confirms it anyway', async () => {
    const { env, raw } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella', '2028-11-01', '2028-11-04');
    blockOff(raw, '2028-11-02', '2028-11-03');
    const res = await setStatus(env, bella, 'confirmed', { overrideCapacity: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'confirmed',
      notified: false,
      cancellationFee: null,
    });
    expect(statusOf(raw, bella)).toBe('confirmed');
  });

  it('the 0006 handover rule is re-asked too, in its own words', async () => {
    const { env, raw } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella', '2028-12-01', '2028-12-05');
    // A house sit CONFIRMED over the same nights — the sitter cannot be in two places, and this
    // overlap is nothing like a handover.
    raw.exec(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, Status)
       VALUES ('bk_sit_dec', '${TENANT_A}', 'eu_sp_jess', 'housesitting', '2028-12-01', '2028-12-05', 'standard', 1, 'confirmed')`,
    );
    const res = await setStatus(env, bella, 'confirmed');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('capacity_conflict');
    expect(body.error.toLowerCase()).toContain('house-sitting');
    expect(body.error.toLowerCase()).toContain('handover');
  });

  it("a single-day service's slot cap is re-asked as well", async () => {
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const walk = async (petId: string): Promise<string> => {
      const res = await app.request(
        '/api/sunny-paws/bookings',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            type: 'walk',
            startDate: '2028-10-04', // a Wednesday
            optionKey: 'd30',
            petIds: [petId],
          }),
        },
        env,
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const first = await walk('pet_sp_bella');
    const second = await walk('pet_sp_mochi');
    // The sitter decides that 8:30 slot fits one dog after all.
    raw.exec(
      `UPDATE TenantServiceOptions SET Capacity = 1
        WHERE TenantId = '${TENANT_A}' AND ServiceType = 'walk' AND OptionKey = 'd30'`,
    );
    expect((await setStatus(env, first, 'confirmed')).status).toBe(200);
    const res = await setStatus(env, second, 'confirmed');
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'capacity_conflict',
      requiresOverride: true,
    });
  });

  it('a clear calendar confirms first time, with no acknowledgement needed', async () => {
    const { env, raw } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella', '2028-09-10', '2028-09-12');
    expect((await setStatus(env, bella, 'confirmed')).status).toBe(200);
    expect(statusOf(raw, bella)).toBe('confirmed');
  });

  it('DECLINE is never re-checked — only the confirm direction', async () => {
    const { env, raw } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella', '2028-11-01', '2028-11-04');
    blockOff(raw, '2028-11-02', '2028-11-03');
    expect((await setStatus(env, bella, 'declined')).status).toBe(200);
    expect(statusOf(raw, bella)).toBe('declined');
  });

  it('CANCEL is never re-checked either', async () => {
    const { env, raw } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella', '2028-11-01', '2028-11-04');
    expect((await setStatus(env, bella, 'confirmed')).status).toBe(200);
    blockOff(raw, '2028-11-02', '2028-11-03');
    expect((await setStatus(env, bella, 'cancelled')).status).toBe(200);
    expect(statusOf(raw, bella)).toBe('cancelled');
  });

  it('re-confirming an ALREADY-confirmed booking stays a quiet no-op', async () => {
    const { env, raw } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella', '2028-11-01', '2028-11-04');
    expect((await setStatus(env, bella, 'confirmed')).status).toBe(200);
    // The calendar changed underneath it, but nothing about this row is CHANGING, so there is
    // nothing to warn about — and re-confirming must not start refusing.
    blockOff(raw, '2028-11-02', '2028-11-03');
    expect((await setStatus(env, bella, 'confirmed')).status).toBe(200);
    expect(statusOf(raw, bella)).toBe('confirmed');
  });

  it('a terminal row is still a 404, not a capacity warning', async () => {
    const { env } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella', '2028-11-01', '2028-11-04');
    expect((await setStatus(env, bella, 'declined')).status).toBe(200);
    expect((await setStatus(env, bella, 'confirmed')).status).toBe(404);
  });

  it("another tenant's booking id is a 404, never a leak of its dates", async () => {
    const { env } = createTestEnv();
    const bella = await bookBoarding(env, 'pet_sp_bella');
    const res = await app.request(
      `/api/happy-tails/admin/bookings/${bella}/status`,
      {
        method: 'POST',
        headers: {
          ...(await adminHeaders('tnt_happytails')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'confirmed' }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});
