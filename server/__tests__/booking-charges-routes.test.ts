import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertBookingCharge, insertBookingRequest, insertInvitedCustomer } from '../db/repo';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A, TENANT_B } from './helpers';

const makeBooking = (env: Env, tenantId: string, status: 'pending' | 'confirmed' = 'confirmed') =>
  insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost: 100,
    status,
  });

const postCharge = async (env: Env, bookingId: string, body: unknown) =>
  app.request(
    `/api/sunny-paws/admin/bookings/${bookingId}/charges`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

const goodBody = { label: 'Vet visit', amount: 45 };

describe('admin booking-charge routes', () => {
  it('adds a charge and returns it with the new charges total', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await postCharge(env, bookingId, goodBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      charge: { id: string; label: string; amount: number };
      chargesTotal: number;
    };
    expect(body.charge).toMatchObject({ label: 'Vet visit', amount: 45 });
    expect(body.chargesTotal).toBe(45);
  });

  it('a second charge sums into chargesTotal', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await postCharge(env, bookingId, goodBody);
    const res = await postCharge(env, bookingId, { label: 'Bath', amount: 20 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { chargesTotal: number };
    expect(body.chargesTotal).toBe(65);
  });

  it('deletes a charge (204) and the total drops', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const first = (await (await postCharge(env, bookingId, goodBody)).json()) as {
      charge: { id: string };
    };
    await postCharge(env, bookingId, { label: 'Bath', amount: 20 });
    const del = await app.request(
      `/api/sunny-paws/admin/bookings/${bookingId}/charges/${first.charge.id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(del.status).toBe(204);
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${bookingId}/charges`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const body = (await res.json()) as { charges: { amount: number }[] };
    expect(body.charges.reduce((sum, ch) => sum + ch.amount, 0)).toBe(20);
  });

  it('400s on a zero, negative, or fractional amount', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    for (const amount of [0, -1, 12.5, '40', undefined]) {
      const res = await postCharge(env, bookingId, { ...goodBody, amount });
      expect(res.status).toBe(400);
    }
  });

  it('400s on an empty or whitespace-only label', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    for (const label of ['', '   ', undefined]) {
      const res = await postCharge(env, bookingId, { ...goodBody, label });
      expect(res.status).toBe(400);
    }
  });

  it('400s on a label longer than 60 characters', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await postCharge(env, bookingId, { ...goodBody, label: 'x'.repeat(61) });
    expect(res.status).toBe(400);
  });

  it("404s adding a charge against another tenant's booking", async () => {
    const { env } = createTestEnv();
    const foreignId = await makeBooking(env, TENANT_B);
    expect((await postCharge(env, foreignId, goodBody)).status).toBe(404);
  });

  it('404s adding a charge against a blocked sentinel row', async () => {
    const { env } = createTestEnv();
    const blockedId = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: '2030-02-01',
      endDate: '2030-02-03',
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    expect((await postCharge(env, blockedId, goodBody)).status).toBe(404);
  });

  it('404s deleting a charge with the wrong booking id in the path', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const otherBookingId = await makeBooking(env, TENANT_A);
    const created = (await (await postCharge(env, bookingId, goodBody)).json()) as {
      charge: { id: string };
    };
    const del = await app.request(
      `/api/sunny-paws/admin/bookings/${otherBookingId}/charges/${created.charge.id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(del.status).toBe(404);
  });

  it("lists a booking's charges", async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await postCharge(env, bookingId, goodBody);
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${bookingId}/charges`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { charges: { label: string; amount: number }[] };
    expect(body.charges).toHaveLength(1);
    expect(body.charges[0]).toMatchObject({ label: 'Vet visit', amount: 45 });
  });

  it('401s without a token', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${bookingId}/charges`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(goodBody),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /:slug/bookings/mine exposes charges', () => {
  it("shows a booking's charges to the customer who owns it, and never another customer's", async () => {
    const { env } = createTestEnv();
    // seed_sp_board1 is jess@example.com's seeded confirmed sunny-paws booking (sql/seed.sql).
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: 'seed_sp_board1',
      label: 'Vet visit',
      amount: 45,
    });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    const { bookings } = (await res.json()) as {
      bookings: {
        id: string;
        charges: { label: string; amount: number }[];
        chargesTotal: number;
      }[];
    };
    const row = bookings.find((b) => b.id === 'seed_sp_board1')!;
    expect(row.chargesTotal).toBe(45);
    expect(row.charges).toEqual([{ label: 'Vet visit', amount: 45 }]);

    // A second sunny-paws customer, with their own booking, must never see jess's charge.
    const other = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'other@example.com',
      'Other Customer',
    );
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: other.Id,
      serviceType: 'boarding',
      startDate: '2030-01-01',
      endDate: '2030-01-03',
      optionKey: 'standard',
      petCount: 1,
      estCost: 100,
      status: 'confirmed',
    });
    const otherToken = await endUserToken(env, 'sunny-paws', 'other@example.com');
    const otherRes = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { authorization: `Bearer ${otherToken}` } },
      env,
    );
    const { bookings: otherBookings } = (await otherRes.json()) as {
      bookings: { id: string; charges: unknown[]; chargesTotal: number }[];
    };
    expect(otherBookings.find((b) => b.id === 'seed_sp_board1')).toBeUndefined();
    expect(otherBookings.every((b) => b.chargesTotal === 0)).toBe(true);
  });
});
