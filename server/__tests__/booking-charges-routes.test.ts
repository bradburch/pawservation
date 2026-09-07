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
    estCost: 10000, // repo seed: cents (0015), as the route bodies and responses now are too.
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

// CENTS on the wire (0015) — $45.00.
const goodBody = { label: 'Vet visit', amountCents: 4500 };

describe('admin booking-charge routes', () => {
  it('adds a charge and returns it with the new charges total', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await postCharge(env, bookingId, goodBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      charge: { id: string; label: string; amountCents: number };
      chargesTotalCents: number;
    };
    expect(body.charge).toMatchObject({ label: 'Vet visit', amountCents: 4500 });
    expect(body.chargesTotalCents).toBe(4500);
  });

  it('a second charge sums into chargesTotalCents', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await postCharge(env, bookingId, goodBody);
    const res = await postCharge(env, bookingId, { label: 'Bath', amountCents: 2000 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { chargesTotalCents: number };
    expect(body.chargesTotalCents).toBe(6500);
  });

  it('deletes a charge (204) and the total drops', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const first = (await (await postCharge(env, bookingId, goodBody)).json()) as {
      charge: { id: string };
    };
    await postCharge(env, bookingId, { label: 'Bath', amountCents: 2000 });
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
    const body = (await res.json()) as { charges: { amountCents: number }[] };
    expect(body.charges.reduce((sum, ch) => sum + ch.amountCents, 0)).toBe(2000);
  });

  it('400s on a zero, negative, or fractional amountCents, and on the old dollar body', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    for (const amountCents of [0, -1, 12.5, '4000', undefined]) {
      const res = await postCharge(env, bookingId, { ...goodBody, amountCents });
      expect(res.status).toBe(400);
    }
    // The retired whole-dollar body is refused outright, never read as 45 cents.
    const old = await postCharge(env, bookingId, { label: 'Vet visit', amount: 45 });
    expect(old.status).toBe(400);
  });

  // A charge may now carry cents — the credit `keepBookingCredit` writes into this column is
  // derived from payments, and a payment is what a person actually sent.
  it('accepts a charge of amountCents that is not a whole dollar', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await postCharge(env, bookingId, { label: 'Vet run', amountCents: 1250 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      charge: { label: string; amountCents: number };
      chargesTotalCents: number;
    };
    expect(body.charge).toMatchObject({ label: 'Vet run', amountCents: 1250 });
    expect(body.chargesTotalCents).toBe(1250);
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
    const body = (await res.json()) as { charges: { label: string; amountCents: number }[] };
    expect(body.charges).toHaveLength(1);
    expect(body.charges[0]).toMatchObject({ label: 'Vet visit', amountCents: 4500 });
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
      amount: 4500, // repo seed: cents
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
        charges: { label: string; amountCents: number }[];
        chargesTotalCents: number;
      }[];
    };
    const row = bookings.find((b) => b.id === 'seed_sp_board1')!;
    expect(row.chargesTotalCents).toBe(4500);
    expect(row.charges).toEqual([{ label: 'Vet visit', amountCents: 4500 }]);

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
      bookings: { id: string; charges: unknown[]; chargesTotalCents: number }[];
    };
    expect(otherBookings.find((b) => b.id === 'seed_sp_board1')).toBeUndefined();
    expect(otherBookings.every((b) => b.chargesTotalCents === 0)).toBe(true);
  });
});
