import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { insertInvitedCustomer, promoteCustomerActive } from '../db/repo';
import { adminHeaders, createTestEnv, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

describe('admin customers', () => {
  it('adds, lists, and removes a customer', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };

    const add = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'guest@example.com', name: 'Guest' }),
      },
      env,
    );
    expect(add.status).toBe(201);
    const created = (await add.json()) as { id: string; status: string };
    expect(created.status).toBe('invited');

    const list = await app.request(
      `/api/${SLUG}/admin/customers`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const { customers } = (await list.json()) as { customers: { email: string }[] };
    expect(customers.some((c) => c.email === 'guest@example.com')).toBe(true);

    const del = await app.request(
      `/api/${SLUG}/admin/customers/${created.id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(del.status).toBe(204);
  });

  it('rejects an invalid email with 400', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const res = await app.request(
      `/api/${SLUG}/admin/customers`,
      { method: 'POST', headers, body: JSON.stringify({ email: 'nope' }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('refuses to delete a customer with bookings (409)', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT INTO EndUsers (Id, TenantId, Email, Status) VALUES ('eu1','${TENANT_A}','has@example.com','active')`,
    );
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk1','${TENANT_A}','eu1','daycare','2030-05-01',1,'pending')`);
    const res = await app.request(
      `/api/${SLUG}/admin/customers/eu1`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(409);
  });

  it('removes a customer that has a pet and a prior login code, without a 500 (FK cascade)', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT INTO EndUsers (Id, TenantId, Email, Status) VALUES ('eu2','${TENANT_A}','pet-and-code@example.com','active')`,
    );
    raw.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
              VALUES ('pet-eu2','${TENANT_A}','eu2','Buddy','dog')`);
    raw.exec(`INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt)
              VALUES ('lc-eu2','${TENANT_A}','eu2','111111','2030-01-01T00:00:00.000Z')`);

    const res = await app.request(
      `/api/${SLUG}/admin/customers/eu2`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(204);
    expect(raw.prepare('SELECT * FROM EndUsers WHERE Id = ?').get('eu2')).toBeUndefined();
    expect(raw.prepare('SELECT * FROM EndUserPets WHERE Id = ?').get('pet-eu2')).toBeUndefined();
    expect(raw.prepare('SELECT * FROM LoginCodes WHERE Id = ?').get('lc-eu2')).toBeUndefined();
  });

  it('requires admin auth', async () => {
    const { env } = createTestEnv();
    const res = await app.request(`/api/${SLUG}/admin/customers`, {}, env);
    expect(res.status).toBe(401);
  });

  it('does NOT send an invite email when re-POSTing an already-active customer', async () => {
    const { env } = createTestEnv();
    // Set up email so the route would normally attempt to send.
    (env as unknown as Record<string, unknown>).RESEND_API_KEY = 'test-key';
    (env as unknown as Record<string, unknown>).RESEND_FROM_NOREPLY =
      'Pawservation <no_reply@example.com>';
    (env as unknown as Record<string, unknown>).RESEND_FROM_BOOKING =
      'Pawservation <booking@example.com>';

    // Seed an active customer directly.
    const customer = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'active@example.com',
      null,
    );
    await promoteCustomerActive(env.PAWBOOK_DB, TENANT_A, customer.Id);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
      const res = await app.request(
        `/api/${SLUG}/admin/customers`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ email: 'active@example.com' }),
        },
        env,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('active');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
