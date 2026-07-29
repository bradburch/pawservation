import { describe, expect, it } from 'vitest';
import app from '../index';
import { getTenantBySlug, insertBookingRequest, updateTenantSettings } from '../db/repo';
import { invalidateTenantCache } from '../lib/tenant-resolve';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

/**
 * The house-sit / boarding overlap allowance (migration 0006, owner directive 2026-07-29):
 * "House sits and boarding can only overlap by one day at the tail ends."
 *
 * `Tenants.HousesitBoardingOverlapDays` — 0 = never, 1 = the default tail touch, 2 = one at each
 * end, NULL = no limit. Enforced in the pure engine (`rangeConflictReason`) and reached through
 * `checkRange`, which every enforcement path shares: the availability quote and the booking POST.
 *
 * TWO THINGS THIS CHANGES about the pre-0006 behaviour, and both are proved below:
 *  1. the rule now runs in the BOARDING direction (it only ever checked house-sit requests), and
 *  2. an overlapping day must sit at the TAIL ENDS — an endpoint of the requested range AND a day
 *     the existing booking is not mid-stay on.
 */

const HOUSESIT_START = '2027-03-01';
const HOUSESIT_END = '2027-03-10'; // exclusive → occupies Mar 1–9

/** An existing, confirmed Sunny Paws house sit over HOUSESIT_START..HOUSESIT_END. */
async function seedHouseSit(env: Env, start = HOUSESIT_START, end = HOUSESIT_END): Promise<void> {
  await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
    endUserId: null,
    serviceType: 'housesitting',
    startDate: start,
    endDate: end,
    optionKey: 'standard',
    petCount: 1,
    estCost: null,
    status: 'confirmed',
  });
}

async function setAllowance(env: Env, days: number | null): Promise<void> {
  const t = (await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws'))!;
  await updateTenantSettings(env.PAWBOOK_DB, TENANT_A, {
    displayName: t.DisplayName,
    accentColor: t.AccentColor,
    timezone: t.Timezone,
    contactEmail: t.ContactEmail,
    contactPhone: t.ContactPhone,
    maxAdvanceMonths: t.MaxAdvanceMonths,
    housesitBoardingOverlapDays: days,
  });
  // The admin PUT does this too — tenant config is read through a 60s KV-cached seam, so a write
  // that skips the route has to drop the cached row or the next request reads the old allowance.
  await invalidateTenantCache('sunny-paws', env);
}

/** The authenticated boarding quote for Jess's dog. */
async function quoteBoarding(env: Env, start: string, end: string): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    `/api/sunny-paws/availability?type=boarding&start=${start}&end=${end}&petIds=pet_sp_bella`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

async function bookBoarding(env: Env, start: string, end: string): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        startDate: start,
        endDate: end,
        petIds: ['pet_sp_bella'],
      }),
    },
    env,
  );
}

describe('overlap allowance — storage + defaults', () => {
  it('every seeded tenant carries the schema DEFAULT of 1', async () => {
    // The migration adds the column with DEFAULT 1, so applying it makes the rule correct for
    // every existing business without a backfill. If this ever reads null, the rule silently
    // stops running everywhere and the rest of this file is testing nothing.
    const { env } = createTestEnv();
    const t = await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws');
    expect(t!.HousesitBoardingOverlapDays).toBe(1);
  });

  it('the admin settings PUT round-trips it, including the meaningful 0', async () => {
    const { env } = createTestEnv();
    const put = async (value: unknown): Promise<Response> =>
      app.request(
        '/api/sunny-paws/admin/settings',
        {
          method: 'PUT',
          headers: await adminHeaders(TENANT_A),
          body: JSON.stringify({ housesitBoardingOverlapDays: value }),
        },
        env,
      );

    expect((await put(0)).status).toBe(204);
    expect((await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws'))!.HousesitBoardingOverlapDays).toBe(
      0,
    );
    expect((await put(null)).status).toBe(204);
    expect((await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws'))!.HousesitBoardingOverlapDays).toBe(
      null,
    );
    // 3 is refused rather than stored: an overlapping day only counts at a range's two endpoints,
    // so a bigger number would promise something the engine can never grant.
    expect((await put(3)).status).toBe(400);
    expect((await put(1.5)).status).toBe(400);
    expect((await put('two')).status).toBe(400);
    // The GET publishes it back for the admin UI.
    const settings = (await (
      await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as { housesitBoardingOverlapDays: number | null };
    expect(settings.housesitBoardingOverlapDays).toBe(null);
  });
});

describe('overlap allowance — the availability quote', () => {
  it('REFUSES a boarding laid across an existing house sit (the direction that was never checked)', async () => {
    // ** THE BEHAVIOUR-CHANGE LOCK. ** Before 0006 the rule only fired when the HOUSE SIT was the
    // incoming request, so this quote came back available with a price. It is now refused, and with
    // a reason that says why rather than claiming the dates are full.
    const { env } = createTestEnv();
    await seedHouseSit(env);
    const res = await quoteBoarding(env, '2027-03-04', '2027-03-06');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: false,
      reason:
        'Your sitter is house-sitting on those dates — a boarding can only overlap it on the first or last day of the stay.',
      code: 'overlap_not_allowed',
    });
  });

  it('allows the tail touch the owner described (boarding starts on the sit’s last night)', async () => {
    const { env } = createTestEnv();
    await seedHouseSit(env, '2027-03-01', '2027-03-05'); // occupies Mar 1–4
    const res = await quoteBoarding(env, '2027-03-04', '2027-03-07');
    expect(res.status).toBe(200);
    expect((await res.json()) as { available: boolean }).toMatchObject({ available: true });
  });

  it('a boarding that starts on the CHECKOUT day never overlapped at all', async () => {
    // End dates are exclusive, so Mar 5 carries no house-sit occupancy. Legal even at allowance 0.
    const { env } = createTestEnv();
    await setAllowance(env, 0);
    await seedHouseSit(env, '2027-03-01', '2027-03-05');
    const res = await quoteBoarding(env, '2027-03-05', '2027-03-08');
    expect((await res.json()) as { available: boolean }).toMatchObject({ available: true });
  });

  it('a one-night boarding wholly INSIDE a house sit is refused', async () => {
    // Also new: a single-night stay is trivially "at its own endpoint", so only the existing
    // booking's side of the handover rules it out.
    const { env } = createTestEnv();
    await seedHouseSit(env);
    const res = await quoteBoarding(env, '2027-03-04', '2027-03-05');
    expect((await res.json()) as { code?: string }).toMatchObject({
      available: false,
      code: 'overlap_not_allowed',
    });
  });

  it('allowance 0 refuses even the tail touch; NULL allows the interior overlap', async () => {
    const { env } = createTestEnv();
    await seedHouseSit(env, '2027-03-01', '2027-03-05');
    await setAllowance(env, 0);
    expect(
      (await (await quoteBoarding(env, '2027-03-04', '2027-03-07')).json()) as { code?: string },
    ).toMatchObject({ available: false, code: 'overlap_not_allowed' });

    await setAllowance(env, null);
    expect(
      (await (await quoteBoarding(env, '2027-03-02', '2027-03-07')).json()) as {
        available: boolean;
      },
    ).toMatchObject({ available: true });
  });

  it('the house-sit direction still behaves exactly as it did', async () => {
    // The pre-0006 rule, unchanged: an existing boarding, a house-sit request over two of its days.
    const { env } = createTestEnv();
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2027-03-01',
      endDate: '2027-03-10',
      optionKey: 'standard',
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability?type=housesitting&start=2027-03-04&end=2027-03-06&petIds=pet_sp_bella',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect((await res.json()) as { reason?: string }).toMatchObject({
      available: false,
      code: 'overlap_not_allowed',
      reason:
        'Your sitter has boarding on those dates — a house sit can only overlap it on the first or last day of the stay.',
    });
  });
});

describe('overlap allowance — the booking POST', () => {
  it('409s with a stable code, and leaves no row behind', async () => {
    const { env, raw } = createTestEnv();
    await seedHouseSit(env);
    const res = await bookBoarding(env, '2027-03-04', '2027-03-06');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'Your sitter is house-sitting on those dates — a boarding can only overlap it on the first or last day of the stay.',
      code: 'overlap_not_allowed',
    });
    // The optimistic insert is rolled back — a refused request must not sit in the sitter's list.
    const rows = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM BookingRequests
          WHERE ServiceType = 'boarding' AND StartDate = '2027-03-04'`,
      )
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('accepts the tail touch and stores it', async () => {
    const { env, raw } = createTestEnv();
    await seedHouseSit(env, '2027-03-01', '2027-03-05');
    const res = await bookBoarding(env, '2027-03-04', '2027-03-07');
    expect(res.status).toBe(201);
    const row = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM BookingRequests
          WHERE ServiceType = 'boarding' AND StartDate = '2027-03-04' AND EndDate = '2027-03-07'`,
      )
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('a full pool still answers "filled up" — the overlap code is not a catch-all', async () => {
    // Sunny Paws boarding is capped at 2 pets; two confirmed pets fill it with no house sit in
    // sight, and that refusal keeps its own long-standing wording and code.
    const { env } = createTestEnv();
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2027-04-01',
      endDate: '2027-04-10',
      optionKey: 'standard',
      petCount: 2,
      estCost: null,
      status: 'confirmed',
    });
    const res = await bookBoarding(env, '2027-04-03', '2027-04-05');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Sorry — those dates just filled up.',
      code: 'capacity_conflict',
    });
  });
});
