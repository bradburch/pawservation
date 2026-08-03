import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

/** UJ-6: a sitter takes a booking through her whole workflow — confirm, add a one-off
 *  charge, record a partial payment, watch Earnings track the balance, then settle it. */
describe('booking admin lifecycle', () => {
  it('confirm -> charge -> partial payment -> outstanding balance -> full payment -> settled', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const bookRes = await app.request(
      `/api/${SLUG}/bookings`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-11-05',
          endDate: '2028-11-08',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(bookRes.status).toBe(201);
    const { id, estCost } = (await bookRes.json()) as { id: string; estCost: number };
    expect(estCost).toBe(150); // 3 nights x $50

    const admin = await adminHeaders(TENANT_A);
    const adminJson = { ...admin, 'Content-Type': 'application/json' };

    const bookingsBefore = (await (
      await app.request(`/api/${SLUG}/admin/bookings`, { headers: admin }, env)
    ).json()) as { bookings: { id: string; status: string; petNames: string[] }[] };
    const before = bookingsBefore.bookings.find((b) => b.id === id)!;
    expect(before.status).toBe('pending');
    expect(before.petNames).toContain('Bella');

    const confirm = await app.request(
      `/api/${SLUG}/admin/bookings/${id}/status`,
      { method: 'POST', headers: adminJson, body: JSON.stringify({ status: 'confirmed' }) },
      env,
    );
    expect(confirm.status).toBe(200);

    const charge = await app.request(
      `/api/${SLUG}/admin/bookings/${id}/charges`,
      {
        method: 'POST',
        headers: adminJson,
        body: JSON.stringify({ label: 'Extra vet visit', amount: 45 }),
      },
      env,
    );
    expect(charge.status).toBe(201);
    expect(((await charge.json()) as { chargesTotal: number }).chargesTotal).toBe(45);

    const partialPayment = await app.request(
      `/api/${SLUG}/admin/bookings/${id}/payments`,
      {
        method: 'POST',
        headers: adminJson,
        body: JSON.stringify({ amount: 100, method: 'venmo', paidDate: '2026-01-15' }),
      },
      env,
    );
    expect(partialPayment.status).toBe(201);
    expect(((await partialPayment.json()) as { paidTotal: number }).paidTotal).toBe(100);

    const analyticsMid = (await (
      await app.request(`/api/${SLUG}/admin/analytics`, { headers: admin }, env)
    ).json()) as { outstanding: { bookingId: string; balance: number }[] };
    const mid = analyticsMid.outstanding.find((o) => o.bookingId === id)!;
    expect(mid.balance).toBe(95); // 150 + 45 - 100

    const finalPayment = await app.request(
      `/api/${SLUG}/admin/bookings/${id}/payments`,
      {
        method: 'POST',
        headers: adminJson,
        body: JSON.stringify({ amount: 95, method: 'venmo', paidDate: '2026-01-16' }),
      },
      env,
    );
    expect(finalPayment.status).toBe(201);
    expect(((await finalPayment.json()) as { paidTotal: number }).paidTotal).toBe(195);

    const analyticsAfter = (await (
      await app.request(`/api/${SLUG}/admin/analytics`, { headers: admin }, env)
    ).json()) as { outstanding: { bookingId: string }[] };
    expect(analyticsAfter.outstanding.some((o) => o.bookingId === id)).toBe(false);
  });
});
