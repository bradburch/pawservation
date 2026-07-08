import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertBookingRequest, insertInvitedCustomer, listBookingsForUser } from '../db/repo';
import { mintToken } from '../lib/token';
import { createTestEnv, TENANT_A, TENANT_B, TEST_SECRET } from './helpers';

/** NFR1: explicit cross-tenant-leak attempts per surface — read, write, list. */
describe('tenant isolation', () => {
  it('resolves each slug to its own tenant and 404s unknown slugs', async () => {
    const { env } = createTestEnv();
    const a = await app.request('/api/sunny-paws/config', {}, env);
    const b = await app.request('/api/happy-tails/config', {}, env);
    expect(((await a.json()) as { displayName: string }).displayName).toBe('Sunny Paws');
    expect(((await b.json()) as { displayName: string }).displayName).toBe('Happy Tails');
    const unknown = await app.request('/api/nope/config', {}, env);
    expect(unknown.status).toBe(404);
  });

  it('allows the same email to exist independently under both tenants', async () => {
    const { env } = createTestEnv();
    const userA = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'jess@example.com', null);
    const userB = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_B, 'jess@example.com', null);
    expect(userA.Id).not.toBe(userB.Id);
    expect(userA.TenantId).toBe(TENANT_A);
    expect(userB.TenantId).toBe(TENANT_B);
  });

  it('READ: a booking created under tenant A never appears in tenant B queries', async () => {
    const { env } = createTestEnv();
    // A fresh email — 'jess@example.com' is the seeded demo customer and now comes with
    // seeded bookings under BOTH tenants.
    const userA = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'iso-read@example.com',
      null,
    );
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: userA.Id,
      serviceType: 'boarding',
      startDate: '2028-08-01',
      endDate: '2028-08-03',
      optionKey: null,
      petType: null,
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    // Same user id queried under tenant B must come back empty.
    expect(await listBookingsForUser(env.PAWBOOK_DB, TENANT_B, userA.Id)).toEqual([]);
    expect(await listBookingsForUser(env.PAWBOOK_DB, TENANT_A, userA.Id)).toHaveLength(1);
  });

  it('WRITE: a tenant-A token cannot create a booking under tenant B', async () => {
    const { env } = createTestEnv();
    const userA = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'jess@example.com', null);
    const tokenForA = await mintToken(userA.Id, TENANT_A, TEST_SECRET);
    const res = await app.request(
      '/api/happy-tails/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenForA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-08-01',
          endDate: '2028-08-03',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(await listBookingsForUser(env.PAWBOOK_DB, TENANT_B, userA.Id)).toEqual([]);
  });

  it('LIST: my-bookings under the other tenant is empty for the same email', async () => {
    const { env } = createTestEnv();
    const userA = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'iso-list@example.com',
      null,
    );
    const userB = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_B,
      'iso-list@example.com',
      null,
    );
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: userA.Id,
      serviceType: 'walk',
      startDate: '2028-08-01',
      endDate: null,
      optionKey: null,
      petType: null,
      petCount: 1,
      estCost: 30,
      status: 'pending',
    });
    const tokenForB = await mintToken(userB.Id, TENANT_B, TEST_SECRET);
    const res = await app.request(
      '/api/happy-tails/bookings/mine',
      { headers: { Authorization: `Bearer ${tokenForB}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bookings: unknown[] }).bookings).toEqual([]);
  });
});
