/**
 * The EXTRA-TIME SURCHARGE (0009): the sitter stores the hours a stay normally starts and ends,
 * plus two independent flat fees, and an arrival before / a departure after adds one.
 *
 * Written BEFORE the implementation (TDD). The FIRST test is the one that matters most: the number
 * the customer is PREVIEWED in the quote and the number the server STAMPS as a `BookingCharges` row
 * must come from one function, the way `feeToCancelToday` already serves both the
 * `/bookings/mine` preview and the cancel route's stamp. Everything else in this file guards the
 * money invariants around it.
 */
import { describe, expect, it } from 'vitest';
import app from '../index';
import type { DatabaseSync } from 'node:sqlite';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import {
  adminHeaders,
  createTestEnv,
  demoToken,
  endUserToken,
  TENANT_A,
  TENANT_B,
} from './helpers';

const SLUG = 'sunny-paws';
const BELLA = 'pet_sp_bella'; // dog
const MOCHI = 'pet_sp_mochi'; // cat
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

/** Sunny Paws boarding: $50/night, pool cap 2 pets/day, PetRateMode 'exact'. */
function configure(raw: DatabaseSync, sets: string, serviceType = 'boarding', tenant = TENANT_A) {
  raw.exec(
    `UPDATE TenantServices SET ${sets} WHERE TenantId = '${tenant}' AND ServiceType = '${serviceType}'`,
  );
}

/** Arrivals before 09:00 cost $20; departures after 11:00 cost $15. */
const STANDARD_HOURS =
  "StandardArrivalTime = '09:00', EarlyArrivalFee = 20, StandardDepartureTime = '11:00', LateDepartureFee = 15";

async function token(env: Env) {
  return endUserToken(env, SLUG, 'jess@example.com');
}

type QuoteExtras = {
  available: boolean;
  priced?: boolean;
  estCost?: number;
  extraTimeFees?: { label: string; amount: number }[];
  extraTimeTotal?: number;
};

async function quote(
  env: Env,
  params: Record<string, string>,
): Promise<{ status: number; body: QuoteExtras }> {
  const res = await app.request(
    `/api/${SLUG}/availability?${new URLSearchParams(params)}`,
    { headers: { Authorization: `Bearer ${await token(env)}` } },
    env,
  );
  return { status: res.status, body: (await res.json()) as QuoteExtras };
}

async function book(env: Env, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/api/${SLUG}/bookings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(env)}` },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function charges(
  env: Env,
  bookingId: string,
): Promise<{ Label: string; Amount: number; Origin: string | null }[]> {
  const { results } = await env.PAWBOOK_DB.prepare(
    'SELECT Label, Amount, Origin FROM BookingCharges WHERE BookingRequestId = ? ORDER BY Origin, Label',
  )
    .bind(bookingId)
    .all<{ Label: string; Amount: number; Origin: string | null }>();
  return results;
}

async function mine(env: Env, id: string) {
  const res = await app.request(
    `/api/${SLUG}/bookings/mine`,
    { headers: { Authorization: `Bearer ${await token(env)}` } },
    env,
  );
  const body = (await res.json()) as {
    bookings: {
      id: string;
      estCost: number | null;
      chargesTotal: number;
      charges: { label: string; amount: number }[];
    }[];
  };
  return body.bookings.find((b) => b.id === id)!;
}

describe('the previewed surcharge and the stamped one are the same number', () => {
  it('quotes exactly what it later writes as charges', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const start = addDays(TODAY, 40);
    const end = addDays(TODAY, 43);

    const previewed = await quote(env, {
      type: 'boarding',
      option: 'standard',
      start,
      end,
      petIds: BELLA,
      startTime: '07:00',
      departureTime: '13:00',
    });
    expect(previewed.status).toBe(200);
    expect(previewed.body.extraTimeFees).toEqual([
      { label: 'Early arrival (07:00)', amount: 20 },
      { label: 'Late departure (13:00)', amount: 15 },
    ]);
    expect(previewed.body.extraTimeTotal).toBe(35);
    // The stay's own price is untouched by the surcharge: 3 nights x $50.
    expect(previewed.body.estCost).toBe(150);

    const res = await book(env, {
      type: 'boarding',
      startDate: start,
      endDate: end,
      petIds: [BELLA],
      startTime: '07:00',
      departureTime: '13:00',
    });
    expect(res.status).toBe(201);
    const { id, estCost } = (await res.json()) as { id: string; estCost: number };

    // THE PARITY LOCK: the stamped rows carry exactly the previewed labels and amounts.
    const stamped = await charges(env, id);
    expect(stamped.map(({ Label, Amount }) => ({ label: Label, amount: Amount }))).toEqual(
      previewed.body.extraTimeFees,
    );
    // EstCost is the stay, never the surcharge — total due is EstCost + chargesTotal.
    expect(estCost).toBe(150);
    const row = await mine(env, id);
    expect(row.estCost).toBe(150);
    expect(row.chargesTotal).toBe(previewed.body.extraTimeTotal);
  });
});

describe('NULL config is the feature switched off', () => {
  it('adds nothing, and the quote payload is exactly what it was before the feature', async () => {
    const { env } = createTestEnv();
    const start = addDays(TODAY, 40);
    const end = addDays(TODAY, 43);
    const q = await quote(env, {
      type: 'boarding',
      option: 'standard',
      start,
      end,
      petIds: BELLA,
      startTime: '05:00',
      departureTime: '23:00',
    });
    expect(q.body).not.toHaveProperty('extraTimeFees');
    expect(q.body).not.toHaveProperty('extraTimeTotal');

    const res = await book(env, {
      type: 'boarding',
      startDate: start,
      endDate: end,
      petIds: [BELLA],
      startTime: '05:00',
      departureTime: '23:00',
    });
    const { id } = (await res.json()) as { id: string };
    expect(await charges(env, id)).toEqual([]);
  });

  it('needs BOTH a standard time and its fee — either alone charges nothing', async () => {
    for (const sets of [
      "StandardArrivalTime = '09:00', StandardDepartureTime = '11:00'", // times, no fees
      'EarlyArrivalFee = 20, LateDepartureFee = 15', // fees, no times
    ]) {
      const { env, raw } = createTestEnv();
      configure(raw, sets);
      const res = await book(env, {
        type: 'boarding',
        startDate: addDays(TODAY, 40),
        endDate: addDays(TODAY, 43),
        petIds: [BELLA],
        startTime: '07:00',
        departureTime: '13:00',
      });
      const { id } = (await res.json()) as { id: string };
      expect(await charges(env, id)).toEqual([]);
    }
  });

  it('charges nothing for a time exactly ON the standard hour, or inside it', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const res = await book(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 43),
      petIds: [BELLA],
      startTime: '09:00', // exactly the standard arrival — not EARLY
      departureTime: '11:00', // exactly the standard departure — not LATE
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await charges(env, id)).toEqual([]);
  });

  it('charges nothing when the owner gave no time at all', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const res = await book(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 43),
      petIds: [BELLA],
    });
    const { id } = (await res.json()) as { id: string };
    expect(await charges(env, id)).toEqual([]);
  });
});

describe('flat, per stay, and never scaled', () => {
  it('charges a ten-night stay the same $20 as a one-night stay', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const long = await book(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 50), // 10 nights
      petIds: [BELLA],
      startTime: '07:00',
    });
    const { id } = (await long.json()) as { id: string };
    expect(await charges(env, id)).toEqual([
      { Label: 'Early arrival (07:00)', Amount: 20, Origin: 'extra_time_early' },
    ]);
  });

  it('is NOT multiplied by the pet count, even under PetRateMode linear', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, `${STANDARD_HOURS}, PetRateMode = 'linear'`);
    const res = await book(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 43),
      petIds: [BELLA, MOCHI],
      startTime: '07:00',
      departureTime: '13:00',
    });
    expect(res.status).toBe(201);
    const { id, estCost } = (await res.json()) as { id: string; estCost: number };
    // The STAY doubles under 'linear' (3 nights x $50 x 2 pets) …
    expect(estCost).toBe(300);
    // … and the surcharge does not. A per-pet fee nobody typed is the defect the no-inferred-
    // pricing invariant exists to prevent, and it is exactly what placing this inside
    // `estimateCost` would have produced.
    expect(await charges(env, id)).toEqual([
      { Label: 'Early arrival (07:00)', Amount: 20, Origin: 'extra_time_early' },
      { Label: 'Late departure (13:00)', Amount: 15, Origin: 'extra_time_late' },
    ]);
  });
});

describe('daycare, whose clock the owner also sets, gets the same surcharge', () => {
  it('charges an early drop-off and a late pick-up on a single day', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, "StandardArrivalTime = '08:00', EarlyArrivalFee = 10", 'daycare');
    const res = await book(env, {
      type: 'daycare',
      startDate: addDays(TODAY, 40),
      petIds: [BELLA],
      startTime: '06:30',
      departureTime: '17:00',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await charges(env, id)).toEqual([
      { Label: 'Early arrival (06:30)', Amount: 10, Origin: 'extra_time_early' },
    ]);
  });
});

describe('an edit re-derives the surcharge only when the TIMES moved', () => {
  async function seed(env: Env): Promise<string> {
    const res = await book(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 43),
      petIds: [BELLA],
      startTime: '07:00',
    });
    return ((await res.json()) as { id: string }).id;
  }

  async function edit(env: Env, id: string, body: Record<string, unknown>): Promise<Response> {
    return app.request(
      `/api/${SLUG}/bookings/${id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await token(env)}`,
        },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  it('drops the fee when the arrival moves back inside the standard hours', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const id = await seed(env);
    expect(await charges(env, id)).toHaveLength(1);

    const res = await edit(env, id, {
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 43),
      petIds: [BELLA],
      answers: {},
      startTime: '10:00',
    });
    expect(res.status).toBe(200);
    expect(await charges(env, id)).toEqual([]);
  });

  it('adds the late-departure fee when the edit introduces a late departure', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const id = await seed(env);

    const res = await edit(env, id, {
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 43),
      petIds: [BELLA],
      answers: {},
      startTime: '07:00',
      departureTime: '13:00',
    });
    expect(res.status).toBe(200);
    expect(await charges(env, id)).toEqual([
      { Label: 'Early arrival (07:00)', Amount: 20, Origin: 'extra_time_early' },
      { Label: 'Late departure (13:00)', Amount: 15, Origin: 'extra_time_late' },
    ]);
  });

  it("leaves a sitter's WAIVER alone when the edit does not move the times", async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const id = await seed(env);
    // The sitter waives it (deleting is the only correction mechanism BookingCharges has).
    raw.exec(`DELETE FROM BookingCharges WHERE BookingRequestId = '${id}'`);

    // An edit that moves only the DATES must not resurrect the fee she chose to drop.
    const res = await edit(env, id, {
      startDate: addDays(TODAY, 44),
      endDate: addDays(TODAY, 47),
      petIds: [BELLA],
      answers: {},
      startTime: '07:00',
    });
    expect(res.status).toBe(200);
    expect(await charges(env, id)).toEqual([]);
  });

  it('never touches a charge the sitter typed herself, even when the times move', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const id = await seed(env);
    const add = await app.request(
      `/api/${SLUG}/admin/bookings/${id}/charges`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Vet visit', amount: 45 }),
      },
      env,
    );
    expect(add.status).toBe(201);

    const res = await edit(env, id, {
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 43),
      petIds: [BELLA],
      answers: {},
      startTime: '10:00', // inside standard hours now — the AUTO fee goes
    });
    expect(res.status).toBe(200);
    expect(await charges(env, id)).toEqual([{ Label: 'Vet visit', Amount: 45, Origin: null }]);
  });
});

describe('the admin settings PUT is the trust boundary', () => {
  async function put(env: Env, service: Record<string, unknown>): Promise<Response> {
    const current = (await (
      await app.request(
        `/api/${SLUG}/admin/settings`,
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as { services: { type: string; enabled: boolean; options: unknown[] }[] };
    const target = current.services.find((s) => s.type === service.type)!;
    return app.request(
      `/api/${SLUG}/admin/settings`,
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          services: [{ ...target, ...service }],
        }),
      },
      env,
    );
  }

  it('stores standard hours and fees on a service whose clock the owner sets', async () => {
    const { env, raw } = createTestEnv();
    const res = await put(env, {
      type: 'boarding',
      standardArrivalTime: '09:00',
      standardDepartureTime: '11:00',
      earlyArrivalFee: 20,
      lateDepartureFee: 15,
    });
    expect(res.status).toBe(204);
    const row = raw
      .prepare(
        `SELECT StandardArrivalTime, StandardDepartureTime, EarlyArrivalFee, LateDepartureFee
           FROM TenantServices WHERE TenantId = ? AND ServiceType = 'boarding'`,
      )
      .get(TENANT_A) as Record<string, unknown>;
    expect(row).toEqual({
      StandardArrivalTime: '09:00',
      StandardDepartureTime: '11:00',
      EarlyArrivalFee: 20,
      LateDepartureFee: 15,
    });
  });

  it('refuses them on a duration-priced service, where the OPTION owns the clock', async () => {
    const { env } = createTestEnv();
    const res = await put(env, {
      type: 'walk',
      standardArrivalTime: '09:00',
      earlyArrivalFee: 20,
    });
    expect(res.status).toBe(400);
  });

  it('refuses a malformed time and a non-whole-dollar fee', async () => {
    const { env } = createTestEnv();
    expect((await put(env, { type: 'boarding', standardArrivalTime: '9am' })).status).toBe(400);
    expect((await put(env, { type: 'boarding', earlyArrivalFee: 0 })).status).toBe(400);
    expect((await put(env, { type: 'boarding', lateDepartureFee: 2.5 })).status).toBe(400);
  });

  it('scopes the write to this tenant only', async () => {
    const { env, raw } = createTestEnv();
    await put(env, {
      type: 'boarding',
      standardArrivalTime: '09:00',
      earlyArrivalFee: 20,
    });
    const other = raw
      .prepare(
        `SELECT StandardArrivalTime, EarlyArrivalFee FROM TenantServices
           WHERE TenantId = ? AND ServiceType = 'boarding'`,
      )
      .get(TENANT_B) as Record<string, unknown>;
    expect(other).toEqual({ StandardArrivalTime: null, EarlyArrivalFee: null });
  });
});

describe('the demo identity still persists nothing', () => {
  it('writes no charge for a demo booking that would attract one', async () => {
    const { env, raw } = createTestEnv();
    configure(raw, STANDARD_HOURS);
    const token = await demoToken(env, SLUG);
    const demoPetId = (
      raw
        .prepare(
          `SELECT p.Id FROM EndUserPets p JOIN EndUsers u ON u.Id = p.EndUserId
            WHERE u.TenantId = ? AND u.Email = 'demo@pawservation.com'`,
        )
        .get(TENANT_A) as { Id: string }
    ).Id;
    const res = await app.request(
      `/api/${SLUG}/bookings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'boarding',
          startDate: addDays(TODAY, 40),
          endDate: addDays(TODAY, 43),
          petIds: [demoPetId],
          answers: {},
          startTime: '07:00',
        }),
      },
      env,
    );
    // A realistic success with nothing persisted — the demo path returns before any write.
    expect(res.status).toBe(201);
    expect((await res.json()) as { demo?: boolean }).toMatchObject({ demo: true });
    const { results } = await env.PAWBOOK_DB.prepare(
      'SELECT Id FROM BookingCharges WHERE TenantId = ?',
    )
      .bind(TENANT_A)
      .all();
    expect(results).toEqual([]);
  });
});
