import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { insertBookingRequest } from '../db/repo';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A, TENANT_B } from './helpers';

/** Books one dog (Bella, sunny-paws) for a 2-night boarding stay via the real customer flow. */
async function bookBoarding(
  env: Env,
  startDate: string,
  endDate: string,
  petIds: string[] = ['pet_sp_bella'],
): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'boarding', startDate, endDate, petIds }),
    },
    env,
  );
}

describe('admin booking lifecycle', () => {
  it('GET lists a created booking with customer email, excluding blocked rows', async () => {
    const { env } = createTestEnv();
    const created = (await (await bookBoarding(env, '2028-10-01', '2028-10-03')).json()) as {
      id: string;
    };

    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(200);
    const { bookings } = (await res.json()) as {
      bookings: { id: string; customerEmail: string | null; type: string; status: string }[];
    };
    const mine = bookings.find((b) => b.id === created.id);
    expect(mine).toBeTruthy();
    expect(mine?.customerEmail).toBe('jess@example.com');
    expect(mine?.type).toBe('boarding');
    expect(mine?.status).toBe('pending');
    // The seeded blocked range for sunny-paws must never appear in the admin bookings list.
    expect(bookings.some((b) => b.type === 'blocked')).toBe(false);
  });

  it('404s for an unknown booking id', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/bookings/nope/status',
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('POST confirm moves pending -> confirmed, reflected on the next GET', async () => {
    const { env } = createTestEnv();
    const created = (await (await bookBoarding(env, '2028-10-05', '2028-10-07')).json()) as {
      id: string;
    };

    const confirm = await app.request(
      `/api/sunny-paws/admin/bookings/${created.id}/status`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      },
      env,
    );
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toEqual({ status: 'confirmed', notified: false });

    const list = (await (
      await app.request(
        '/api/sunny-paws/admin/bookings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as { bookings: { id: string; status: string }[] };
    expect(list.bookings.find((b) => b.id === created.id)?.status).toBe('confirmed');
  });

  it('POST decline is pending-only, listed as declined, and distinct from cancelled', async () => {
    const { env } = createTestEnv();
    const created = (await (await bookBoarding(env, '2028-11-01', '2028-11-03')).json()) as {
      id: string;
    };
    const auth = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const setStatus = (status: string) =>
      app.request(
        `/api/sunny-paws/admin/bookings/${created.id}/status`,
        { method: 'POST', headers: auth, body: JSON.stringify({ status }) },
        env,
      );

    const decline = await setStatus('declined');
    expect(decline.status).toBe(200);
    expect(await decline.json()).toEqual({ status: 'declined', notified: false });

    const list = (await (
      await app.request(
        '/api/sunny-paws/admin/bookings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as { bookings: { id: string; status: string }[] };
    expect(list.bookings.find((b) => b.id === created.id)?.status).toBe('declined');

    // Declining a non-pending row never matches: it's already terminal here.
    expect((await setStatus('declined')).status).toBe(404);
  });

  it('POST cancel on a confirmed booking cancels it; further status changes 404 (terminal)', async () => {
    const { env } = createTestEnv();
    const created = (await (await bookBoarding(env, '2028-10-08', '2028-10-10')).json()) as {
      id: string;
    };
    const auth = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const setStatus = (status: string) =>
      app.request(
        `/api/sunny-paws/admin/bookings/${created.id}/status`,
        { method: 'POST', headers: auth, body: JSON.stringify({ status }) },
        env,
      );

    expect((await setStatus('confirmed')).status).toBe(200);
    const cancel = await setStatus('cancelled');
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ status: 'cancelled', notified: false });

    // Cancelled is terminal: even re-confirming the same row is rejected.
    const again = await setStatus('confirmed');
    expect(again.status).toBe(404);
  });

  it('cancelling a booking never calls out to Google Calendar (no event delete/update on cancel)', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2030-06-01',
      endDate: '2030-06-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'confirmed',
    });
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('POST with a bad status value is rejected with 400', async () => {
    const { env } = createTestEnv();
    const created = (await (await bookBoarding(env, '2028-10-12', '2028-10-14')).json()) as {
      id: string;
    };
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${created.id}/status`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'bogus' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('tenant isolation: another tenant admin cannot see or update tenant A bookings', async () => {
    const { env } = createTestEnv();
    const created = (await (await bookBoarding(env, '2028-10-16', '2028-10-18')).json()) as {
      id: string;
    };

    // Tenant B's admin bookings list must not include tenant A's booking.
    const listB = (await (
      await app.request(
        '/api/happy-tails/admin/bookings',
        { headers: await adminHeaders(TENANT_B) },
        env,
      )
    ).json()) as { bookings: { id: string }[] };
    expect(listB.bookings.some((b) => b.id === created.id)).toBe(false);

    // Tenant B's admin cannot confirm/cancel tenant A's booking either.
    const crossUpdate = await app.request(
      `/api/happy-tails/admin/bookings/${created.id}/status`,
      {
        method: 'POST',
        headers: {
          ...(await adminHeaders(TENANT_B)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'confirmed' }),
      },
      env,
    );
    expect(crossUpdate.status).toBe(404);
  });

  it('cancelling a booking releases capacity for a new booking on the same dates', async () => {
    const { env } = createTestEnv();
    // Sunny Paws' boarding service is seeded with MaxConcurrentPets=2. Use fresh dates so the seeded boarding row
    // (2028-06-20..25) doesn't interfere. A 3-night span is used (not 2) so the middle night
    // isn't a boundary day eligible for the engine's "soft bookend" endpoint-sharing rule —
    // otherwise a same-range third request could dodge the capacity check entirely.
    const start = '2028-10-20';
    const end = '2028-10-23';

    const first = await bookBoarding(env, start, end, ['pet_sp_bella']);
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;

    const second = await bookBoarding(env, start, end, ['pet_sp_mochi']);
    expect(second.status).toBe(201);

    // At capacity (2/2) — a third booking on the same dates must be rejected.
    const third = await bookBoarding(env, start, end, ['pet_sp_bella']);
    expect(third.status).toBe(409);

    // Cancel the first booking via the admin endpoint...
    const cancel = await app.request(
      `/api/sunny-paws/admin/bookings/${firstId}/status`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      },
      env,
    );
    expect(cancel.status).toBe(200);

    // ...and the same booking now succeeds, since capacity is back to 1/2.
    const retry = await bookBoarding(env, start, end, ['pet_sp_bella']);
    expect(retry.status).toBe(201);
  });
});
