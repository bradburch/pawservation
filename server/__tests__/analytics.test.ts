import { describe, expect, it } from 'vitest';
import {
  getAnalytics,
  insertBookingRequest,
  insertInvitedCustomer,
  insertPayment,
  updateBookingStatus,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

// Seeded clean-slate tenant (sql/seed.sql): has customers but NO bookings, so outstanding
// assertions can be exact. TENANT_A/B each carry a seeded confirmed unpaid booking.
const TENANT_C = 'tnt_pawsandrelax';

// Fixed anchor for repo-level tests — the 12-month window is 2025-08 .. 2026-07.
const TODAY = '2026-07-15';

const makeBooking = (
  env: Env,
  tenantId: string,
  over: {
    endUserId?: string | null;
    serviceType?: string;
    estCost?: number | null;
    status?: 'pending' | 'confirmed';
  } = {},
) =>
  insertBookingRequest(env.PAWBOOK_DB, tenantId, {
    endUserId: over.endUserId ?? null,
    serviceType: over.serviceType ?? 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petType: 'dog',
    petCount: 1,
    estCost: over.estCost !== undefined ? over.estCost : 100,
    status: over.status ?? 'confirmed',
  });

const pay = (
  env: Env,
  tenantId: string,
  bookingRequestId: string,
  amount: number,
  paidDate = '2026-07-01',
) =>
  insertPayment(env.PAWBOOK_DB, tenantId, {
    bookingRequestId,
    amount,
    method: 'cash',
    paidDate,
    note: null,
  });

describe('getAnalytics (repo)', () => {
  it('monthly: 12 zero-filled buckets, oldest first, out-of-window payments excluded', async () => {
    const { env } = createTestEnv();
    const b1 = await makeBooking(env, TENANT_A);
    await pay(env, TENANT_A, b1, 40, '2026-07-01');
    await pay(env, TENANT_A, b1, 60, '2026-07-20');
    await pay(env, TENANT_A, b1, 25, '2026-05-10');
    await pay(env, TENANT_A, b1, 999, '2025-07-31'); // month 2025-07: just outside the window
    const { monthly } = await getAnalytics(env.PAWBOOK_DB, TENANT_A, TODAY);
    expect(monthly).toHaveLength(12);
    expect(monthly[0]).toEqual({ Month: '2025-08', Total: 0 });
    expect(monthly[11]).toEqual({ Month: '2026-07', Total: 100 });
    expect(monthly.find((m) => m.Month === '2026-05')).toEqual({ Month: '2026-05', Total: 25 });
    expect(monthly.find((m) => m.Month === '2025-07')).toBeUndefined();
    expect(monthly.filter((m) => m.Total === 0)).toHaveLength(10);
  });

  it('byService: labels from TenantServices, slug fallback for deleted services, ordered by total desc', async () => {
    const { env } = createTestEnv();
    const boarding = await makeBooking(env, TENANT_A, { serviceType: 'boarding' });
    const walk = await makeBooking(env, TENANT_A, { serviceType: 'walk' });
    const gone = await makeBooking(env, TENANT_A, { serviceType: 'retired-svc' });
    await pay(env, TENANT_A, boarding, 200);
    await pay(env, TENANT_A, walk, 35);
    await pay(env, TENANT_A, gone, 80);
    const { byService } = await getAnalytics(env.PAWBOOK_DB, TENANT_A, TODAY);
    expect(byService).toEqual([
      { ServiceType: 'boarding', Label: 'Boarding', Total: 200 },
      { ServiceType: 'retired-svc', Label: 'retired-svc', Total: 80 },
      { ServiceType: 'walk', Label: 'Walks', Total: 35 },
    ]);
  });

  it('revenue counts payments on later-cancelled bookings (cash received is real revenue)', async () => {
    const { env } = createTestEnv();
    const b1 = await makeBooking(env, TENANT_A);
    await pay(env, TENANT_A, b1, 150);
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, b1, 'cancelled');
    const { byService, monthly } = await getAnalytics(env.PAWBOOK_DB, TENANT_A, TODAY);
    expect(byService).toEqual([{ ServiceType: 'boarding', Label: 'Boarding', Total: 150 }]);
    expect(monthly[11].Total).toBe(150);
  });

  it('topClients: ordered by total desc, distinct booking counts, LIMIT 10', async () => {
    const { env } = createTestEnv();
    for (let i = 0; i < 12; i++) {
      const user = await insertInvitedCustomer(
        env.PAWBOOK_DB,
        TENANT_C,
        `client${i}@example.com`,
        `Client ${i}`,
      );
      const bookingId = await makeBooking(env, TENANT_C, { endUserId: user.Id });
      await pay(env, TENANT_C, bookingId, 10 + i);
    }
    const { topClients } = await getAnalytics(env.PAWBOOK_DB, TENANT_C, TODAY);
    expect(topClients).toHaveLength(10); // clients 0 and 1 ($10, $11) fall off
    expect(topClients[0]).toMatchObject({ Email: 'client11@example.com', Total: 21, Bookings: 1 });
    expect(topClients.some((t) => t.Email === 'client0@example.com')).toBe(false);
    expect(topClients.some((t) => t.Email === 'client1@example.com')).toBe(false);
  });

  it('topClients: two payments on one booking count as ONE booking; two bookings as two', async () => {
    const { env } = createTestEnv();
    const jess = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'jess@example.com', 'Jess');
    const b1 = await makeBooking(env, TENANT_C, { endUserId: jess.Id });
    const b2 = await makeBooking(env, TENANT_C, { endUserId: jess.Id });
    await pay(env, TENANT_C, b1, 30);
    await pay(env, TENANT_C, b1, 20);
    await pay(env, TENANT_C, b2, 50);
    const { topClients } = await getAnalytics(env.PAWBOOK_DB, TENANT_C, TODAY);
    // Name asserted via jess.Name (not a literal): tnt_pawsandrelax seeds an active customer at
    // this exact email (sql/seed.sql), and insertInvitedCustomer is idempotent — it returns the
    // existing seeded record ('Jess Demo') rather than the 'Jess' passed here.
    expect(topClients).toEqual([
      { EndUserId: jess.Id, Name: jess.Name, Email: 'jess@example.com', Total: 100, Bookings: 2 },
    ]);
  });

  it('outstanding: partial payments listed with paid totals, ordered by balance desc; paid/overpaid, NULL-EstCost, pending, and cancelled excluded', async () => {
    const { env } = createTestEnv();
    const partial = await makeBooking(env, TENANT_C, { estCost: 100 }); // owes 60
    await pay(env, TENANT_C, partial, 40);
    const unpaid = await makeBooking(env, TENANT_C, { estCost: 300 }); // owes 300
    const paidInFull = await makeBooking(env, TENANT_C, { estCost: 100 });
    await pay(env, TENANT_C, paidInFull, 100);
    const overpaid = await makeBooking(env, TENANT_C, { estCost: 100 });
    await pay(env, TENANT_C, overpaid, 120);
    await makeBooking(env, TENANT_C, { estCost: null }); // no estimate -> no computable balance
    await makeBooking(env, TENANT_C, { estCost: 500, status: 'pending' }); // not confirmed yet
    const cancelled = await makeBooking(env, TENANT_C, { estCost: 400 });
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_C, cancelled, 'cancelled');
    const { outstanding } = await getAnalytics(env.PAWBOOK_DB, TENANT_C, TODAY);
    expect(outstanding.map((o) => o.BookingId)).toEqual([unpaid, partial]);
    expect(outstanding[1]).toMatchObject({ EstCost: 100, PaidTotal: 40 });
  });

  it('outstanding is tenant-isolated (another tenant sees nothing of TENANT_C)', async () => {
    const { env } = createTestEnv();
    await makeBooking(env, TENANT_C, { estCost: 300 });
    const { outstanding } = await getAnalytics(env.PAWBOOK_DB, TENANT_C, TODAY);
    expect(outstanding).toHaveLength(1);
    // TENANT_B's view contains only its own seeded unpaid booking (seed_ht_board1), never C's.
    const other = await getAnalytics(env.PAWBOOK_DB, TENANT_B, TODAY);
    expect(other.outstanding.map((o) => o.BookingId)).toEqual(['seed_ht_board1']);
  });
});
