import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  createTenantAccessToken,
  getTenantById,
  insertBookingRequest,
  insertInvitedCustomer,
  listBookingsForUser,
} from '../db/repo';
import { generateTenantAccessToken, hashPersonalAccessToken } from '../lib/personal-access-token';
import { mintToken } from '../lib/token';
import { MAX_LIVE_TOKENS_PER_USER } from '../routes/tenant-tokens';
import { createTestEnv, endUserToken, TENANT_A, TENANT_B, TEST_SECRET } from './helpers';

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
    const userA = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'jess@example.com',
      null,
    );
    const userB = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_B,
      'jess@example.com',
      null,
    );
    expect(userA.Id).not.toBe(userB.Id);
    expect(userA.TenantId).toBe(TENANT_A);
    expect(userB.TenantId).toBe(TENANT_B);
  });

  it('READ: a booking created under tenant A never appears in tenant B queries', async () => {
    const { env } = createTestEnv();
    // A fresh email — 'jess@example.com' is the seeded demo customer and now comes with
    // seeded bookings under BOTH tenants.
    const userA = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'iso-read@example.com',
      null,
    );
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: userA.Id,
      serviceType: 'boarding',
      startDate: '2028-08-01',
      endDate: '2028-08-03',
      optionKey: null,
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    // Same user id queried under tenant B must come back empty.
    expect(await listBookingsForUser(env.PAWSERVATION_DB, TENANT_B, userA.Id)).toEqual([]);
    expect(await listBookingsForUser(env.PAWSERVATION_DB, TENANT_A, userA.Id)).toHaveLength(1);
  });

  it('WRITE: a tenant-A token cannot create a booking under tenant B', async () => {
    const { env } = createTestEnv();
    const userA = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'jess@example.com',
      null,
    );
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
    expect(await listBookingsForUser(env.PAWSERVATION_DB, TENANT_B, userA.Id)).toEqual([]);
  });

  it('CREDENTIAL: a personal access token issued under tenant A is nothing under tenant B', async () => {
    const { env } = createTestEnv();
    // The seeded collision: jess@example.com is a customer of BOTH sitters and is two unrelated
    // people. A long-lived credential is the one that would hurt most if it crossed — it is held
    // by software, for months, far from the session that minted it.
    const jwtA = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const created = await app.request(
      '/api/sunny-paws/tokens',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwtA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Isolation' }),
      },
      env,
    );
    const { token } = (await created.json()) as { token: string };

    const readB = await app.request(
      '/api/happy-tails/bookings/mine',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(readB.status).toBe(401);
    // …and it still works where it belongs, so the refusal is the boundary and not a dead token.
    const readA = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(readA.status).toBe(200);
  });

  it('CREDENTIAL: a tenant access token issued under tenant A is nothing under tenant B', async () => {
    const { env } = createTestEnv();
    // The sitter-side twin of the case above, and the one with the larger blast radius: this
    // credential opens a whole book, not one customer's bookings.
    const token = generateTenantAccessToken();
    await createTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, {
      tenantUserId: 'tu_sunny',
      name: 'Isolation',
      tokenHash: await hashPersonalAccessToken(token),
      maxLive: MAX_LIVE_TOKENS_PER_USER,
    });

    const readB = await app.request(
      '/api/happy-tails/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    // 401 and never 403: the lookup binds TenantId, so under the wrong sitter the token does not
    // exist rather than existing elsewhere — saying "wrong account" would be reading across the
    // boundary to find out.
    expect(readB.status).toBe(401);
    // …and it still works where it belongs, so the refusal is the boundary and not a dead token.
    const readA = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(readA.status).toBe(200);
  });

  it('LIST: my-bookings under the other tenant is empty for the same email', async () => {
    const { env } = createTestEnv();
    const userA = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'iso-list@example.com',
      null,
    );
    const userB = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_B,
      'iso-list@example.com',
      null,
    );
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: userA.Id,
      serviceType: 'walk',
      startDate: '2028-08-01',
      endDate: null,
      optionKey: null,
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

  it('a billing event for one sitter leaves every other sitter’s plan alone', async () => {
    const { env } = createTestEnv();
    const configured = { ...env, BILLING_SHARED_SECRET: 'billing-secret-0123456789' } as Env;
    await app.request(
      '/api/sunny-paws/admin/billing/events',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Billing-Secret': 'billing-secret-0123456789',
        },
        body: JSON.stringify({
          eventType: 'checkout.session.completed',
          plan: 'pro',
          billedUntil: new Date(Date.now() + 31 * 86_400_000).toISOString(),
          stripeCustomerId: 'cus_A',
          stripeSubscriptionId: 'sub_A',
          eventId: 'evt_1',
          eventCreated: Math.floor(Date.now() / 1000),
        }),
      },
      configured,
    );
    const b = (await getTenantById(env.PAWSERVATION_DB, TENANT_B))!;
    expect(b.Plan).toBeNull();
    expect(b.BilledUntil).toBeNull();
    expect(b.StripeCustomerId).toBeNull();
  });
});
