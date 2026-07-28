import { describe, expect, it } from 'vitest';
import { insertBookingRequest } from '../db/repo';
import app from '../index';
import { createTestEnv, demoToken, endUserToken, TENANT_A } from './helpers';

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
