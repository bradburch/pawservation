import { describe, expect, it } from 'vitest';
import app from '../index';
import { getTenantBySlug, insertBookingRequest, updateTenantSettings } from '../db/repo';
import { invalidateTenantCache } from '../lib/tenant-resolve';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

/**
 * A NIGHT HOLDS AT MOST ONE HOUSE SIT, end to end.
 *
 * The engine's own proofs live in `capacity.test.ts`; this file walks the four surfaces that must
 * agree about it, because a rule enforced in three places and painted in a fourth is a rule with
 * three chances to drift: the availability QUOTE, the month GRID, the booking POST, and the
 * sitter's CONFIRM re-check. Plus the edit path, which is where a stay meets itself.
 *
 * THE DEFECT THIS CLOSES: `rangeConflictReason` used to compare a house-sit request against the
 * OPPOSITE pool only, so two house sits at two different clients on one night were held apart by
 * nothing but `MaxConcurrentPets` — a cap that counts PETS. Sunny Paws' house-sitting service has
 * no cap at all (`MaxConcurrentPets IS NULL` in `sql/seed.sql`), which is why every refusal below
 * is the whereabouts rule and could not be anything else.
 *
 * It is the SAME rule that already governed boarding against house sitting (0006), widened by one
 * predicate (`kindsClash`) and with the HANDOVER CONCESSION WITHHELD for a same-kind pair: a
 * "handover day" is a night both stays occupy (`EventSpan.lastOccupied` is the last night slept,
 * not the checkout morning), which is a tolerance against a boarding and the double booking itself
 * against another house sit. So two house sits may never share a night at 0, 1 or 2.
 *
 * BACK-TO-BACK stays share no night at all and are untouched, at every allowance. `null` ("No
 * limit") still switches the whole rule off.
 */

const SLUG = 'sunny-paws';
const BELLA = 'pet_sp_bella';
const MOCHI = 'pet_sp_mochi';

/** An existing house sit on Sunny Paws' calendar, written straight to the DB so the POST rules
 *  under test never get a say in the fixture. */
async function seedHouseSit(
  env: Env,
  start: string,
  end: string,
  status: 'pending' | 'confirmed' = 'confirmed',
): Promise<string> {
  return insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
    endUserId: null,
    serviceType: 'housesitting',
    startDate: start,
    endDate: end,
    optionKey: 'standard',
    petCount: 1,
    estCost: null,
    status,
  });
}

async function setAllowance(env: Env, days: number | null): Promise<void> {
  const t = (await getTenantBySlug(env.PAWSERVATION_DB, SLUG))!;
  await updateTenantSettings(env.PAWSERVATION_DB, TENANT_A, {
    displayName: t.DisplayName,
    accentColor: t.AccentColor,
    timezone: t.Timezone,
    contactEmail: t.ContactEmail,
    contactPhone: t.ContactPhone,
    maxAdvanceMonths: t.MaxAdvanceMonths,
    housesitBoardingOverlapDays: days,
    calendarCostBasis: t.CalendarCostBasis,
    attributionSpillDays: t.AttributionSpillDays,
  });
  // Tenant config is read through a 60s KV-cached seam; a write that skips the admin route has to
  // drop the cached row or the next request still reads the old allowance.
  await invalidateTenantCache(SLUG, env);
}

async function quote(
  env: Env,
  start: string,
  end: string,
  petIds = [BELLA],
  type = 'housesitting',
): Promise<Response> {
  const token = await endUserToken(env, SLUG, 'jess@example.com');
  return app.request(
    `/api/${SLUG}/availability?type=${type}&start=${start}&end=${end}&petIds=${petIds.join(',')}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

async function book(
  env: Env,
  start: string,
  end: string,
  petIds = [BELLA],
  type = 'housesitting',
): Promise<Response> {
  const token = await endUserToken(env, SLUG, 'jess@example.com');
  return app.request(
    `/api/${SLUG}/bookings`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, startDate: start, endDate: end, petIds }),
    },
    env,
  );
}

type QuoteBody = { available: boolean; reason?: string; code?: string };

describe('house-sit exclusivity — the availability quote', () => {
  it('refuses a house sit laid across an existing house sit, with an accurate sentence', async () => {
    const { env } = createTestEnv();
    await seedHouseSit(env, '2028-09-01', '2028-09-10');

    const body = (await (await quote(env, '2028-09-03', '2028-09-06')).json()) as QuoteBody;
    expect(body.available).toBe(false);
    expect(body.code).toBe('overlap_not_allowed');
    // The customer is told the TRUE fact. Telling them "your sitter has boarding on those dates"
    // would be the wire code's older sentence applied to a case it does not describe.
    expect(body.reason).toContain('house-sitting on those dates');
    expect(body.reason).not.toContain('boarding');
    // Every sitter's own clients read this string, so it names no GENDER and no OTHER CLIENT (the
    // month grid says only "Sitter is house-sitting", and who else booked is not a customer's
    // business). It does name the way out, which is the back-to-back adjacency.
    expect(body.reason).not.toMatch(/\b(she|her|his|he)\b/i);
    expect(body.reason).not.toMatch(/another client/i);
    // THE TAIL, pinned. It used to offer "the day one is ending as the other begins", which under
    // the withheld same-kind concession IS the shared night and is refused at 0, 1 and 2 alike —
    // an escape route straight back into the same 409. Only the CHECKOUT day works.
    expect(body.reason).toContain(
      'The earliest a second one can start is the day the first one ends',
    );
    expect(body.reason).toMatch(/may touch, but not overlap/i);
    expect(body.reason).not.toMatch(/one is ending as the other begins/i);
    expect(body.reason).not.toMatch(/handover/i);
  });

  it('THE POINT: pet count is irrelevant — one pet blocks one pet, no cap involved', async () => {
    const { env } = createTestEnv();
    // Sunny Paws' house sitting has MaxConcurrentPets = NULL, so the pool cannot refuse anything.
    const t = await env.PAWSERVATION_DB.prepare(
      `SELECT MaxConcurrentPets AS cap FROM TenantServices
        WHERE TenantId = ? AND ServiceType = 'housesitting'`,
    )
      .bind(TENANT_A)
      .first<{ cap: number | null }>();
    expect(t!.cap).toBeNull();

    await seedHouseSit(env, '2028-09-01', '2028-09-10');
    const body = (await (await quote(env, '2028-09-03', '2028-09-06')).json()) as QuoteBody;
    expect(body.available).toBe(false);
    expect(body.code).toBe('overlap_not_allowed');
  });

  it('refuses the SHARED NIGHT that a cross-kind pair would be allowed to hand over', async () => {
    const { env } = createTestEnv();
    await seedHouseSit(env, '2028-09-01', '2028-09-05'); // occupies Sep 1-4

    // The Smiths/Joneses shape: the request arrives on the existing sit's last NIGHT. Against a
    // boarding this is the canonical handover; against a house sit it is two homes on one night.
    const body = (await (await quote(env, '2028-09-04', '2028-09-07')).json()) as QuoteBody;
    expect(body.available).toBe(false);
    expect(body.code).toBe('overlap_not_allowed');
  });

  it('BACK-TO-BACK is allowed at every allowance, which is her normal working week', async () => {
    // Out of the first house on Friday morning, into the second that evening. The first sit's last
    // night is Sep 4 and the second's first night is Sep 5: no shared night, nothing to allow.
    for (const allowance of [0, 1, 2]) {
      const { env } = createTestEnv();
      await seedHouseSit(env, '2028-09-01', '2028-09-05');
      await setAllowance(env, allowance);
      expect(
        ((await (await quote(env, '2028-09-05', '2028-09-08')).json()) as QuoteBody).available,
      ).toBe(true);
    }
  });

  it('CROSS-KIND handovers are unchanged: a house sit may still meet a boarding', async () => {
    // The pin that stops the same-kind rule tightening the boarding side. A boarding occupies
    // Sep 1-4; the house sit arrives on Sep 4, its last night, and keeps Sep 5 and Sep 6.
    for (const allowance of [1, 2]) {
      const { env } = createTestEnv();
      await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
        endUserId: null,
        serviceType: 'boarding',
        startDate: '2028-09-01',
        endDate: '2028-09-05',
        optionKey: 'standard',
        petCount: 1,
        estCost: null,
        status: 'confirmed',
      });
      await setAllowance(env, allowance);
      expect(
        ((await (await quote(env, '2028-09-04', '2028-09-07')).json()) as QuoteBody).available,
      ).toBe(true);
    }
  });

  it('"No limit" switches this off too, exactly as it already does for boarding', async () => {
    const { env } = createTestEnv();
    await seedHouseSit(env, '2028-09-01', '2028-09-10');
    await setAllowance(env, null);
    expect(
      ((await (await quote(env, '2028-09-03', '2028-09-06')).json()) as QuoteBody).available,
    ).toBe(true);
  });

  it('the shared night is refused at 0, 1 and 2 alike — the allowance does not buy it', async () => {
    for (const allowance of [0, 1, 2]) {
      const { env } = createTestEnv();
      await seedHouseSit(env, '2028-09-01', '2028-09-05');
      await setAllowance(env, allowance);
      expect(
        ((await (await quote(env, '2028-09-04', '2028-09-07')).json()) as QuoteBody).available,
      ).toBe(false);
    }
  });

  it('BOARDING is untouched: several stays a night, bounded only by the pool cap', async () => {
    const { env } = createTestEnv();
    // Sunny Paws boarding seats 2 pets a day. One pet is already boarding across these nights.
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2028-09-01',
      endDate: '2028-09-10',
      optionKey: 'standard',
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    // A second, separate boarding for one more pet fits: her own house holds both.
    const ok = (await (
      await quote(env, '2028-09-03', '2028-09-06', [BELLA], 'boarding')
    ).json()) as QuoteBody;
    expect(ok.available).toBe(true);
    // A third pet does not, and that refusal is the POOL, not the whereabouts rule.
    const full = (await (
      await quote(env, '2028-09-03', '2028-09-06', [BELLA, MOCHI], 'boarding')
    ).json()) as QuoteBody;
    expect(full.available).toBe(false);
    expect(full.code).toBeUndefined();
  });
});

describe('house-sit exclusivity — the booking POST', () => {
  it('409s with the stable overlap code and leaves no row behind', async () => {
    const { env, raw } = createTestEnv();
    await seedHouseSit(env, '2028-09-01', '2028-09-10');

    const res = await book(env, '2028-09-03', '2028-09-06');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('overlap_not_allowed');
    expect(body.error).toContain('house-sitting on those dates');

    const rows = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM BookingRequests
          WHERE TenantId = ? AND ServiceType = 'housesitting' AND EndUserId IS NOT NULL`,
      )
      .get(TENANT_A) as { n: number };
    expect(rows.n).toBe(0);
  });

  it('THE SAME PAIR IN THE OPPOSITE ORDER gives the identical verdict', async () => {
    // Order independence at the API, not just in the engine sweep. Stay A is Sep 1-9, stay B is
    // Sep 3-5; whichever is on the calendar first, the other is refused.
    const aFirst = createTestEnv();
    await seedHouseSit(aFirst.env, '2028-09-01', '2028-09-10');
    const bSecond = await book(aFirst.env, '2028-09-03', '2028-09-06');

    const bFirst = createTestEnv();
    await seedHouseSit(bFirst.env, '2028-09-03', '2028-09-06');
    const aSecond = await book(bFirst.env, '2028-09-01', '2028-09-10');

    expect(bSecond.status).toBe(409);
    expect(aSecond.status).toBe(409);
    expect(((await aSecond.json()) as { code: string }).code).toBe('overlap_not_allowed');
  });

  it('TWO ONE-NIGHT SITS ON ONE NIGHT are refused, in either order', async () => {
    // Each is its own arrival and its own departure, so the handover condition passes on the only
    // day either of them has. What refuses it is "the stay kept no night of its own".
    const first = createTestEnv();
    await seedHouseSit(first.env, '2028-09-04', '2028-09-05');
    expect((await book(first.env, '2028-09-04', '2028-09-05')).status).toBe(409);

    // …and the mirror: a LONG sit arriving on a one-night sit's only night is refused too, because
    // handing over would leave that neighbour with nothing.
    const second = createTestEnv();
    await seedHouseSit(second.env, '2028-09-04', '2028-09-05');
    expect((await book(second.env, '2028-09-04', '2028-09-08')).status).toBe(409);
  });

  it('409s on the shared night, and accepts the BACK-TO-BACK stay right beside it', async () => {
    const { env, raw } = createTestEnv();
    await seedHouseSit(env, '2028-09-01', '2028-09-05'); // occupies Sep 1-4

    // Sharing the night of Sep 4 is refused…
    expect((await book(env, '2028-09-04', '2028-09-07')).status).toBe(409);

    // …and moving in by one day, so the stays merely touch, is accepted and stored.
    const res = await book(env, '2028-09-05', '2028-09-08');
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const row = raw
      .prepare('SELECT StartDate, EndDate FROM BookingRequests WHERE Id = ?')
      .get(id) as { StartDate: string; EndDate: string };
    expect(row).toEqual({ StartDate: '2028-09-05', EndDate: '2028-09-08' });
  });
});

describe('house-sit exclusivity — the month grid', () => {
  type MonthBody = {
    days: { date: string; status: string; reason: string | null }[];
  };

  const grid = async (env: Env, month: string, type = 'housesitting'): Promise<MonthBody> => {
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const res = await app.request(
      `/api/${SLUG}/availability/month?type=${type}&month=${month}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MonthBody;
  };

  it('strikes out EVERY night of the sit, and leaves its checkout day open', async () => {
    const { env } = createTestEnv();
    await seedHouseSit(env, '2028-09-01', '2028-09-05'); // occupies Sep 1-4
    const byDate = new Map((await grid(env, '2028-09')).days.map((d) => [d.date, d]));

    // Same-kind has no handover to concede, so the paint is EXACT here: a night a sit occupies is
    // unusable by every house-sit request, its own arrival night and last night included.
    for (const date of ['2028-09-01', '2028-09-02', '2028-09-03', '2028-09-04']) {
      expect(byDate.get(date)).toMatchObject({
        status: 'unavailable',
        reason: 'Sitter is house-sitting',
      });
    }
    // The checkout day carries no occupancy at all, which is what makes back-to-back bookable.
    expect(byDate.get('2028-09-05')!.status).toBe('available');
  });

  it('a BOARDING day still leaves its handover nights open to a house sit', async () => {
    // Cross-kind paint, pinned so the same-kind rule cannot tighten it. The boarding occupies
    // Sep 1-4; its first and last nights are both legal handover days for a house sit.
    const { env } = createTestEnv();
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2028-09-01',
      endDate: '2028-09-05',
      optionKey: 'standard',
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    const byDate = new Map((await grid(env, '2028-09')).days.map((d) => [d.date, d]));
    expect(byDate.get('2028-09-01')!.status).not.toBe('unavailable');
    expect(byDate.get('2028-09-04')!.status).not.toBe('unavailable');
    expect(byDate.get('2028-09-02')).toMatchObject({
      status: 'unavailable',
      reason: 'Sitter has boarders',
    });
  });

  it('the grid and the quote agree on the day the quote refuses', async () => {
    // The property the paint exists for: a day painted `available` that the quote then refuses is
    // the defect `whereaboutsDayBlocked` was written to prevent.
    const { env } = createTestEnv();
    await seedHouseSit(env, '2028-09-01', '2028-09-10');
    const byDate = new Map((await grid(env, '2028-09')).days.map((d) => [d.date, d]));
    expect(byDate.get('2028-09-05')!.status).toBe('unavailable');
    expect(
      ((await (await quote(env, '2028-09-05', '2028-09-06')).json()) as QuoteBody).available,
    ).toBe(false);
  });

  it('a ONE-NIGHT sit strikes out its own night, which nothing can hand over', async () => {
    const { env } = createTestEnv();
    await seedHouseSit(env, '2028-09-04', '2028-09-05');
    const byDate = new Map((await grid(env, '2028-09')).days.map((d) => [d.date, d]));
    expect(byDate.get('2028-09-04')).toMatchObject({
      status: 'unavailable',
      reason: 'Sitter is house-sitting',
    });
  });

  it('a BOARDING grid is unchanged by boarding, and still struck out by a house sit', async () => {
    const { env } = createTestEnv();
    await seedHouseSit(env, '2028-09-01', '2028-09-10');
    const byDate = new Map((await grid(env, '2028-09', 'boarding')).days.map((d) => [d.date, d]));
    // The pre-existing cross-kind paint, untouched: the reason names the house sit, not boarders.
    expect(byDate.get('2028-09-05')).toMatchObject({
      status: 'unavailable',
      reason: 'Sitter is house-sitting',
    });
  });

  it('a house-sit grid struck out by BOARDING still says "Sitter has boarders"', async () => {
    const { env } = createTestEnv();
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2028-09-01',
      endDate: '2028-09-10',
      optionKey: 'standard',
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    const byDate = new Map((await grid(env, '2028-09')).days.map((d) => [d.date, d]));
    expect(byDate.get('2028-09-05')).toMatchObject({
      status: 'unavailable',
      reason: 'Sitter has boarders',
    });
  });
});

describe('house-sit exclusivity — the widened capacity read', () => {
  it('sees a neighbour sit that starts well BEFORE the requested window', async () => {
    // `overlapReadWindow` widens `checkRange`'s capacity read to the union of the touched spans,
    // and only a real D1 round trip exercises it: the engine tests hand the whole map in at once.
    // The neighbour runs Aug 20 to Sep 3, so its span reaches back a month before the request and
    // out of any month the first read would have covered.
    const { env } = createTestEnv();
    await seedHouseSit(env, '2028-08-20', '2028-09-03'); // occupies Aug 20 - Sep 2
    const body = (await (await quote(env, '2028-09-02', '2028-09-06')).json()) as QuoteBody;
    expect(body.available).toBe(false);
    expect(body.code).toBe('overlap_not_allowed');
    // …and one day later, on the neighbour's checkout day, is a clean back-to-back.
    expect(
      ((await (await quote(env, '2028-09-03', '2028-09-06')).json()) as QuoteBody).available,
    ).toBe(true);
  });
});

describe('house-sit exclusivity — the sitter’s confirm', () => {
  it('warns on the SECOND confirm, and she can still override', async () => {
    const { env } = createTestEnv();
    // Both requests were made while the allowance was NULL (the rule off), so both are legitimately
    // pending. Then she sets a real allowance — the exact "a rule that did not exist when the
    // request was made" shape `confirmOverbookWarning` exists for.
    const first = await seedHouseSit(env, '2028-09-01', '2028-09-10', 'pending');
    const second = await seedHouseSit(env, '2028-09-03', '2028-09-06', 'pending');

    const setStatus = async (id: string, extra: Record<string, unknown> = {}): Promise<Response> =>
      app.request(
        `/api/${SLUG}/admin/bookings/${id}/status`,
        {
          method: 'POST',
          headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'confirmed', ...extra }),
        },
        env,
      );

    // The first confirm is silent: the scope is COMMITTED-ONLY, and the other row is still pending.
    expect((await setStatus(first)).status).toBe(200);

    const res = await setStatus(second);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      code: string;
      requiresOverride: boolean;
    };
    expect(body.code).toBe('capacity_conflict');
    expect(body.requiresOverride).toBe(true);
    // The SITTER's wording, which may say "you" and does not have to be shy about the reason.
    expect(body.error).toContain('You are already house-sitting over those nights');
    expect(body.error).toContain('Two house sits can never share a night');
    // She reads this at the moment she decides whether to override, so the remedy it names has to
    // be one that actually works. "Two house sits can meet on a handover day" was flatly false.
    expect(body.error).toContain(
      'the earliest a second one can start is the day the first one ends',
    );
    expect(body.error).not.toMatch(/handover day/i);
    expect(body.error).toContain('Confirming anyway will double-book you.');

    // She is the authority over her own calendar: told, never refused.
    expect((await setStatus(second, { overrideCapacity: true })).status).toBe(200);
  });
});

describe('house-sit exclusivity — a stay must not collide with itself', () => {
  it('an edit shifting a house sit by one day is not refused by its own row', async () => {
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const created = await book(env, '2028-09-10', '2028-09-14');
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;

    // Sep 11-14 overlaps Sep 10-13 on three nights. Without `excludeBookingId` reaching the
    // same-kind span set, the stay would now clash with itself and become uneditable.
    const res = await app.request(
      `/api/${SLUG}/bookings/${id}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: '2028-09-11',
          endDate: '2028-09-15',
          petIds: [BELLA],
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const row = raw
      .prepare('SELECT StartDate, EndDate FROM BookingRequests WHERE Id = ?')
      .get(id) as { StartDate: string; EndDate: string };
    expect(row).toEqual({ StartDate: '2028-09-11', EndDate: '2028-09-15' });
  });

  it('…but SOMEONE ELSE’S house sit still refuses the edit', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const created = await book(env, '2028-09-10', '2028-09-14');
    const id = ((await created.json()) as { id: string }).id;
    await seedHouseSit(env, '2028-09-20', '2028-09-30');

    const res = await app.request(
      `/api/${SLUG}/bookings/${id}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: '2028-09-22',
          endDate: '2028-09-26',
          petIds: [BELLA],
        }),
      },
      env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('overlap_not_allowed');
  });

  it('an edit changing ONLY the pets is not refused by its own row', async () => {
    // The dates stay put, so every night of the stay carries this booking's own house-sit span.
    // Without `excludeBookingId` reaching the same-kind span set, the stay clashes with itself and
    // a customer who simply swapped which animal is coming can never save. One pet swapped for
    // one pet, deliberately: a two-pet set on the base fixture is refused for a different reason
    // entirely (`unpriced_pet_set`, PetRateMode 'exact'), which would prove nothing about capacity.
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const created = await book(env, '2028-09-10', '2028-09-14');
    const id = ((await created.json()) as { id: string }).id;

    const res = await app.request(
      `/api/${SLUG}/bookings/${id}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: '2028-09-10',
          endDate: '2028-09-14',
          petIds: [MOCHI],
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const pets = raw
      .prepare('SELECT PetId FROM BookingRequestPets WHERE BookingRequestId = ?')
      .all(id) as { PetId: string }[];
    expect(pets.map((p) => p.PetId)).toEqual([MOCHI]);
  });

  it('the month grid excludes the booking being edited from its own days', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const created = await book(env, '2028-09-10', '2028-09-14');
    const id = ((await created.json()) as { id: string }).id;

    const res = await app.request(
      `/api/${SLUG}/availability/month?type=housesitting&month=2028-09&excludeBookingId=${id}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const days = ((await res.json()) as { days: { date: string; status: string }[] }).days;
    const byDate = new Map(days.map((d) => [d.date, d]));
    expect(byDate.get('2028-09-11')!.status).toBe('available');
  });
});
