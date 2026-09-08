import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertBookingRequest, insertPayment, updateBookingStatus } from '../db/repo';
import { adminHeaders, createTestEnv, TENANT_A, TENANT_B } from './helpers';

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

const postPayment = async (env: Env, bookingId: string, body: unknown) =>
  app.request(
    `/api/sunny-paws/admin/bookings/${bookingId}/payments`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

// CENTS on the wire (0015) — $40.00.
const goodBody = { amountCents: 4000, method: 'venmo', paidDate: '2026-07-11', note: 'deposit' };

describe('admin payment routes', () => {
  it('records a payment and returns it with the new paid total', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await insertPayment(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: bookingId,
      amount: 1000, // repo call: CENTS (0015), as the route body below now is too.
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    const res = await postPayment(env, bookingId, goodBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: {
        id: string;
        amountCents: number;
        method: string;
        paidDate: string;
        note: string | null;
      };
      paidTotalCents: number;
    };
    expect(body.payment).toMatchObject({
      amountCents: 4000,
      method: 'venmo',
      paidDate: '2026-07-11',
      note: 'deposit',
    });
    expect(body.paidTotalCents).toBe(5000);
  });

  it('allows recording against a PENDING booking (deposits)', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A, 'pending');
    const res = await postPayment(env, bookingId, goodBody);
    expect(res.status).toBe(201);
  });

  it('400s on a non-integer, zero, or missing amount', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    for (const amountCents of [12.5, 0, -3, '4000', undefined]) {
      const res = await postPayment(env, bookingId, { ...goodBody, amountCents });
      expect(res.status).toBe(400);
    }
  });

  /**
   * THE CEILING. `isValidCents` bounds nothing above, so a fat-fingered `9007199254740991` is a
   * whole positive number of cents and passes every other check — and then poisons every balance,
   * tile and export it lands in. `MAX_AMOUNT_CENTS` ($1,000,000) is the same figure the
   * whole-dollar backfill ceiling has always used, so a sitter meets ONE limit wherever she types
   * an amount, and the refusal speaks in dollars because dollars are what she typed.
   */
  it('400s on an amount over the $1,000,000 ceiling, and says the range in dollars', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const over = await postPayment(env, bookingId, { ...goodBody, amountCents: 100_000_001 });
    expect(over.status).toBe(400);
    expect((await over.json()) as { error: string }).toEqual({
      error: 'Enter an amount between $0.01 and $1,000,000.',
    });
    // Exactly at the ceiling is accepted — the bound is a ceiling, not a fear of large numbers.
    const at = await postPayment(env, bookingId, { ...goodBody, amountCents: 100_000_000 });
    expect(at.status).toBe(201);
  });

  it('400s on an unknown payment method', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await postPayment(env, bookingId, { ...goodBody, method: 'stripe' });
    expect(res.status).toBe(400);
  });

  it('400s on an impossible calendar date (isRealDate, not just the regex)', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    for (const paidDate of ['2026-02-30', '2026-13-01', 'not-a-date', undefined]) {
      const res = await postPayment(env, bookingId, { ...goodBody, paidDate });
      expect(res.status).toBe(400);
    }
  });

  it('404s recording against a cancelled booking', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, bookingId, 'cancelled');
    expect((await postPayment(env, bookingId, goodBody)).status).toBe(404);
  });

  it('404s recording against a blocked sentinel row', async () => {
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
    expect((await postPayment(env, blockedId, goodBody)).status).toBe(404);
  });

  it("404s recording against another tenant's booking", async () => {
    const { env } = createTestEnv();
    const foreignId = await makeBooking(env, TENANT_B);
    expect((await postPayment(env, foreignId, goodBody)).status).toBe(404);
  });

  it("lists a booking's payments", async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await postPayment(env, bookingId, goodBody);
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${bookingId}/payments`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payments: { amountCents: number; method: string }[] };
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ amountCents: 4000, method: 'venmo' });
  });

  it('404s listing payments for a nonexistent booking', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/bookings/nope/payments',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('records a payment with an empty note as null', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await postPayment(env, bookingId, { ...goodBody, note: '' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payment: { note: string | null } };
    expect(body.payment.note).toBeNull();
  });

  it('deletes a payment (204), 404s on repeat and on a booking/payment mismatch', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const otherBookingId = await makeBooking(env, TENANT_A);
    const created = (await (await postPayment(env, bookingId, goodBody)).json()) as {
      payment: { id: string };
    };
    const del = async (booking: string, payment: string) =>
      app.request(
        `/api/sunny-paws/admin/bookings/${booking}/payments/${payment}`,
        { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
        env,
      );
    // Mismatched booking id in the URL: refused, nothing deleted.
    expect((await del(otherBookingId, created.payment.id)).status).toBe(404);
    expect((await del(bookingId, created.payment.id)).status).toBe(204);
    expect((await del(bookingId, created.payment.id)).status).toBe(404);
  });

  it('the bookings list carries paidTotalCents', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await postPayment(env, bookingId, goodBody);
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const body = (await res.json()) as { bookings: { id: string; paidTotalCents: number }[] };
    expect(body.bookings.find((b) => b.id === bookingId)?.paidTotalCents).toBe(4000);
    // Seeded unpaid booking reports 0, not null/undefined.
    expect(body.bookings.find((b) => b.id === 'seed_sp_board1')?.paidTotalCents).toBe(0);
  });

  // TASK 5 (RED): the wire says its unit. The body is `amountCents`, an integer number of cents,
  // so a sitter can record the $45.50 a client actually sent.
  it('records a cents payment and answers with the new paid total in cents', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A, 'pending');
    const res = await postPayment(env, bookingId, {
      amountCents: 4550,
      method: 'venmo',
      paidDate: '2026-07-11',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { amountCents: number; method: string };
      paidTotalCents: number;
    };
    expect(body.payment).toMatchObject({ amountCents: 4550, method: 'venmo' });
    expect(body.paidTotalCents).toBe(4550);
  });

  it('400s on the old whole-dollar `amount` body', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await postPayment(env, bookingId, {
      amount: 40,
      method: 'venmo',
      paidDate: '2026-07-11',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('400s on a fractional amountCents', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const res = await postPayment(env, bookingId, {
      amountCents: 45.5,
      method: 'venmo',
      paidDate: '2026-07-11',
    });
    expect(res.status).toBe(400);
  });
});
