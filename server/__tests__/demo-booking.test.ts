import { describe, expect, it } from 'vitest';
import { insertBookingRequest } from '../db/repo';
import app from '../index';
import { createTestEnv, demoToken, endUserToken, seedPets, TENANT_A } from './helpers';

const SLUG_C = 'paws-and-relax';
const TENANT_C = 'tnt_pawsandrelax';

const countRows = (raw: import('node:sqlite').DatabaseSync, table: string, tenantId: string) =>
  (
    raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE TenantId = ?`).get(tenantId) as {
      n: number;
    }
  ).n;

function book(env: Env, slug: string, token: string, body: Record<string, unknown>) {
  return app.request(
    `/api/${slug}/bookings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('demo booking POST', () => {
  it('returns a realistic 201 with the real server price and persists NOTHING', async () => {
    const { env, raw } = createTestEnv();
    const token = await demoToken(env, SLUG_C);
    const bookingsBefore = countRows(raw, 'BookingRequests', TENANT_C);
    const petsBefore = (
      raw.prepare('SELECT COUNT(*) AS n FROM BookingRequestPets').get() as { n: number }
    ).n;
    const demoPetId = (
      raw
        .prepare(
          `SELECT p.Id FROM EndUserPets p JOIN EndUsers u ON u.Id = p.EndUserId
            WHERE u.TenantId = ? AND u.Email = 'demo@pawservation.com'`,
        )
        .get(TENANT_C) as { Id: string }
    ).Id;

    const res = await book(env, SLUG_C, token, {
      type: 'boarding',
      startDate: '2028-09-01',
      endDate: '2028-09-03',
      petIds: [demoPetId],
      answers: {},
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      estCost: number;
      status: string;
      demo?: boolean;
      note?: string;
    };
    expect(body.estCost).toBe(90); // 2 nights × $45 — same estimateCost as a real booking
    expect(body.status).toBe('pending');
    expect(body.demo).toBe(true);
    expect(body.note).toBe('This was a demo — no booking was created.');
    expect(body.id.startsWith('demo_')).toBe(true);

    // Zero pollution: no booking row, no pet links, no GCal event id anywhere.
    expect(countRows(raw, 'BookingRequests', TENANT_C)).toBe(bookingsBefore);
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM BookingRequestPets').get() as { n: number }).n,
    ).toBe(petsBefore);
  });

  it('still enforces real validation (bad range 400 with a stable code)', async () => {
    const { env } = createTestEnv();
    const token = await demoToken(env, SLUG_C);
    const res = await book(env, SLUG_C, token, {
      type: 'boarding',
      startDate: '2028-09-03',
      endDate: '2028-09-01',
      petIds: ['whatever'],
      answers: {},
    });
    expect(res.status).toBe(400);
  });

  it('still 409s capacity_conflict when the dates are genuinely full', async () => {
    const { env, raw } = createTestEnv();
    // sunny-paws boarding MaxConcurrentPets=2; seed already has 1 pet on 2028-06-20..25.
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: 'eu_sp_jess',
      serviceType: 'boarding',
      startDate: '2028-06-20',
      endDate: '2028-06-25',
      optionKey: 'standard',
      petCount: 1,
      startTime: null,
      estCost: 250,
      status: 'confirmed',
      answers: {},
      idempotencyKey: null,
    });
    const token = await demoToken(env, 'sunny-paws');
    const demoPetId = (
      raw
        .prepare(
          `SELECT p.Id FROM EndUserPets p JOIN EndUsers u ON u.Id = p.EndUserId
            WHERE u.TenantId = ? AND u.Email = 'demo@pawservation.com'`,
        )
        .get(TENANT_A) as { Id: string }
    ).Id;
    const res = await book(env, 'sunny-paws', token, {
      type: 'boarding',
      startDate: '2028-06-21',
      endDate: '2028-06-23',
      petIds: [demoPetId],
      answers: {},
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('capacity_conflict');
    // And the failed attempt persisted nothing either:
    const demoRows = raw
      .prepare(
        `SELECT b.Id FROM BookingRequests b JOIN EndUsers u ON u.Id = b.EndUserId
          WHERE u.Email = 'demo@pawservation.com'`,
      )
      .all();
    expect(demoRows).toEqual([]);
  });

  it("an unpriced 2-pet set is refused for the demo user too — same code, same pipeline (mode 'exact')", async () => {
    const { env, raw } = createTestEnv();
    const token = await demoToken(env, SLUG_C);
    const demoUser = raw
      .prepare(`SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = 'demo@pawservation.com'`)
      .get(TENANT_C) as { Id: string };
    const demoPetId = (
      raw
        .prepare(`SELECT Id FROM EndUserPets WHERE TenantId = ? AND EndUserId = ?`)
        .get(TENANT_C, demoUser.Id) as { Id: string }
    ).Id;
    // The demo identity's seeded pet (Biscuit) is a dog; give it a second dog with no dog:2 rate
    // configured for paws-and-relax boarding — the demo user runs the SAME validation pipeline as
    // a real customer, so this must refuse identically, before the demo's own zero-persistence
    // short-circuit ever runs.
    const [secondPetId] = seedPets(raw, TENANT_C, demoUser.Id, [
      { id: 'pet_demo_second', petType: 'dog' },
    ]);

    const res = await book(env, SLUG_C, token, {
      type: 'boarding',
      startDate: '2028-09-05',
      endDate: '2028-09-07',
      petIds: [demoPetId, secondPetId],
      answers: {},
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'unpriced_pet_set' });
    // Nothing was ever going to persist for the demo identity, but confirm no BookingRequests row
    // exists for this window either way.
    const rows = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM BookingRequests WHERE TenantId = ? AND StartDate = '2028-09-05'`,
      )
      .get(TENANT_C) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("…and under the sitter's stored 'linear' mode the demo user gets the multiplied price, still persisting NOTHING", async () => {
    // The sibling of the refusal above. The demo identity runs the SAME pricing pipeline as a real
    // customer, so it must follow the mode both ways — and the zero-persistence rule is
    // unconditional, so a PRICED demo booking must still leave the database untouched.
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `UPDATE TenantServices SET PetRateMode='linear' WHERE TenantId=? AND ServiceType='boarding'`,
      )
      .run(TENANT_C);
    const token = await demoToken(env, SLUG_C);
    const demoUser = raw
      .prepare(`SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = 'demo@pawservation.com'`)
      .get(TENANT_C) as { Id: string };
    const demoPetId = (
      raw
        .prepare(`SELECT Id FROM EndUserPets WHERE TenantId = ? AND EndUserId = ?`)
        .get(TENANT_C, demoUser.Id) as { Id: string }
    ).Id;
    const [secondPetId] = seedPets(raw, TENANT_C, demoUser.Id, [
      { id: 'pet_demo_linear', petType: 'dog' },
    ]);
    const bookingsBefore = countRows(raw, 'BookingRequests', TENANT_C);

    const res = await book(env, SLUG_C, token, {
      type: 'boarding',
      startDate: '2028-09-11',
      endDate: '2028-09-13',
      petIds: [demoPetId, secondPetId],
      answers: {},
    });
    expect(res.status).toBe(201);
    // 2 nights × $45 = $90 for one pet; two pets on a 'linear' service = $180.
    expect(await res.json()).toMatchObject({ estCost: 180, demo: true });
    expect(countRows(raw, 'BookingRequests', TENANT_C)).toBe(bookingsBefore);
  });

  it('real customers on the same tenant still create real bookings', async () => {
    const { env, raw } = createTestEnv();
    await demoToken(env, SLUG_C); // demo provisioned — must not affect jess
    const jessToken = await endUserToken(env, SLUG_C, 'jess@example.com');
    const res = await book(env, SLUG_C, jessToken, {
      type: 'boarding',
      startDate: '2028-10-01',
      endDate: '2028-10-03',
      petIds: ['pet_pr_luna'],
      answers: {},
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; demo?: boolean };
    expect(body.demo).toBeUndefined();
    expect(raw.prepare(`SELECT Id FROM BookingRequests WHERE Id = ?`).get(body.id)).toBeDefined();
  });
});
