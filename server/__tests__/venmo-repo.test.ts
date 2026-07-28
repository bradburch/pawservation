import { describe, expect, it } from 'vitest';
import { insertPayment, listOutstandingBookings } from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

describe('listOutstandingBookings', () => {
  it('returns only under-paid live bookings, with the owing client and the remaining balance', async () => {
    const { env } = createTestEnv();
    const rows = await listOutstandingBookings(env.PAWBOOK_DB, TENANT_A);
    // Seeded: seed_sp_board1 confirmed $250, nothing paid. Pending requests are not receivables,
    // and the 'blocked' sentinel is not a booking.
    expect(rows.map((r) => r.BookingId)).toEqual(['seed_sp_board1']);
    expect(rows[0]).toMatchObject({ EndUserId: 'eu_sp_jess', Expected: 250, PaidTotal: 0 });
  });

  it('shrinks the balance as payments land and drops the row when it is settled', async () => {
    const { env } = createTestEnv();
    await insertPayment(env.PAWBOOK_DB, TENANT_A, {
      bookingRequestId: 'seed_sp_board1',
      amount: 100,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    expect((await listOutstandingBookings(env.PAWBOOK_DB, TENANT_A))[0].PaidTotal).toBe(100);
    await insertPayment(env.PAWBOOK_DB, TENANT_A, {
      bookingRequestId: 'seed_sp_board1',
      amount: 150,
      method: 'cash',
      paidDate: '2026-07-02',
      note: null,
      externalRef: null,
    });
    expect(await listOutstandingBookings(env.PAWBOOK_DB, TENANT_A)).toEqual([]);
  });

  it('never leaks another tenant’s receivables', async () => {
    const { env } = createTestEnv();
    const rows = await listOutstandingBookings(env.PAWBOOK_DB, TENANT_B);
    expect(rows.map((r) => r.BookingId)).toEqual(['seed_ht_board1']);
  });
});
