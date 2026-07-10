import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertBookingRequest } from '../db/repo';
import { adminToken, createTestEnv, TENANT_A } from './helpers';

describe('admin bookings', () => {
  it('lists bookings, joining customer email/name and deriving status from Declined', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: 'eu_sp_jess',
      serviceType: 'boarding',
      startDate: '2030-01-01',
      endDate: '2030-01-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    const token = await adminToken(TENANT_A);
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bookings: { id: string; customerEmail: string | null; status: string }[];
    };
    // Note: seed.sql seeds a pre-existing non-blocked booking for TENANT_A, so we look up the
    // one we just created rather than asserting the list has exactly one entry.
    const created = body.bookings.find((b) => b.id === id);
    expect(created?.customerEmail).toBe('jess@example.com');
    expect(created?.status).toBe('pending');
  });

  it('confirms a pending booking; notified is false without email configured', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: 'eu_sp_jess',
      serviceType: 'boarding',
      startDate: '2030-02-01',
      endDate: '2030-02-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    const token = await adminToken(TENANT_A);
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; notified: boolean };
    expect(body.status).toBe('confirmed');
    expect(body.notified).toBe(false); // RESEND_API_KEY isn't set in the test env
  });

  it('rejects an unknown status value', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    const token = await adminToken(TENANT_A);
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'bogus' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('404s for an unknown booking id', async () => {
    const { env } = createTestEnv();
    const token = await adminToken(TENANT_A);
    const res = await app.request(
      '/api/sunny-paws/admin/bookings/nope/status',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('declining a booking is reflected as status "declined" in the list', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2030-05-01',
      endDate: null,
      optionKey: 'd30',
      petType: 'dog',
      petCount: 1,
      estCost: 20,
      status: 'pending',
    });
    const token = await adminToken(TENANT_A);
    await app.request(
      `/api/sunny-paws/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'declined' }),
      },
      env,
    );
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await res.json()) as { bookings: { id: string; status: string }[] };
    expect(body.bookings.find((b) => b.id === id)?.status).toBe('declined');
  });
});
