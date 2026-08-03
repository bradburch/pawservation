import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

async function book(env: Env, token: string, body: Record<string, unknown>) {
  return app.request(
    `/api/${SLUG}/bookings`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

function cancel(env: Env, token: string, id: string) {
  return app.request(
    `/api/${SLUG}/bookings/${id}/cancel`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

/** UJ-5: a pending withdrawal is always free; a confirmed cancellation is fee-bearing
 *  per the service's stored cancellation tiers, and the fee shows up as money owed on
 *  the sitter's Earnings page. */
describe('cancellation flow', () => {
  it('withdrawing a pending request is free', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const res = await book(env, token, {
      type: 'boarding',
      startDate: '2028-10-10',
      endDate: '2028-10-12',
      petIds: ['pet_sp_bella'],
    });
    const { id } = (await res.json()) as { id: string };

    const cancelRes = await cancel(env, token, id);
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({ status: 'cancelled', cancellationFee: 0 });

    const mine = (await (
      await app.request(
        `/api/${SLUG}/bookings/mine`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).json()) as { bookings: { id: string; status: string }[] };
    expect(mine.bookings.find((b) => b.id === id)!.status).toBe('cancelled');
  });

  it('cancelling a confirmed stay charges the stored tier fee, which shows up as outstanding', async () => {
    const { env, raw } = createTestEnv();
    // withinDays is set far larger than any realistic days-until-start so the tier always
    // matches regardless of which real calendar day this suite runs on (CLAUDE.md documents
    // the same sliding-window hazard for sql/seed-demo.sql — this sidesteps it rather than
    // reintroducing it).
    raw.exec(
      `UPDATE TenantServices SET CancellationTiers = '[{"withinDays":3000,"percent":50}]'
       WHERE TenantId = '${TENANT_A}' AND ServiceType = 'boarding'`,
    );

    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const bookRes = await book(env, token, {
      type: 'boarding',
      startDate: '2029-03-01',
      endDate: '2029-03-04',
      petIds: ['pet_sp_bella'],
    });
    expect(bookRes.status).toBe(201);
    const { id, estCost } = (await bookRes.json()) as { id: string; estCost: number };
    expect(estCost).toBe(150); // 3 nights x $50

    const admin = await adminHeaders(TENANT_A);
    const confirm = await app.request(
      `/api/${SLUG}/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { ...admin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      },
      env,
    );
    expect(confirm.status).toBe(200);

    const cancelRes = await cancel(env, token, id);
    expect(cancelRes.status).toBe(200);
    const { cancellationFee } = (await cancelRes.json()) as { cancellationFee: number };
    expect(cancellationFee).toBe(75); // round(150 * 0.5)

    const analytics = (await (
      await app.request(`/api/${SLUG}/admin/analytics`, { headers: admin }, env)
    ).json()) as { outstanding: { bookingId: string; balance: number }[] };
    const row = analytics.outstanding.find((o) => o.bookingId === id)!;
    expect(row.balance).toBe(75);
  });
});
