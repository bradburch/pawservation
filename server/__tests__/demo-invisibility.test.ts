import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, demoToken } from './helpers';

const SLUG_C = 'paws-and-relax';
const TENANT_C = 'tnt_pawsandrelax';
const DEMO_EMAIL = 'demo@pawservation.com';

describe('demo customer is invisible to the sitter', () => {
  it('GET /admin/customers omits the demo customer; real clients unaffected', async () => {
    const { env } = createTestEnv();
    await demoToken(env, SLUG_C); // provisions the shadow customer
    const res = await app.request(
      `/api/${SLUG_C}/admin/customers`,
      {
        headers: await adminHeaders(TENANT_C),
      },
      env,
    );
    expect(res.status).toBe(200);
    const { customers } = (await res.json()) as { customers: { email: string }[] };
    expect(customers.some((u) => u.email === DEMO_EMAIL)).toBe(false);
    expect(customers.some((u) => u.email === 'jess@example.com')).toBe(true);
  });

  it('analytics stays empty of demo activity even after a demo booking attempt', async () => {
    const { env, raw } = createTestEnv();
    const token = await demoToken(env, SLUG_C);
    const demoPetId = (
      raw
        .prepare(
          `SELECT p.Id FROM EndUserPets p JOIN EndUsers u ON u.Id = p.EndUserId
            WHERE u.TenantId = ? AND u.Email = ?`,
        )
        .get(TENANT_C, DEMO_EMAIL) as { Id: string }
    ).Id;
    const bookRes = await app.request(
      `/api/${SLUG_C}/bookings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-09-01',
          endDate: '2028-09-03',
          petIds: [demoPetId],
          answers: {},
        }),
      },
      env,
    );
    expect(bookRes.status).toBe(201);

    const res = await app.request(
      `/api/${SLUG_C}/admin/analytics`,
      {
        headers: await adminHeaders(TENANT_C),
      },
      env,
    );
    const body = (await res.json()) as {
      topClients: { email: string | null }[];
      outstanding: unknown[];
    };
    expect(body.topClients.some((t) => t.email === DEMO_EMAIL)).toBe(false);
    expect(body.outstanding).toEqual([]); // paws-and-relax has no seeded bookings; demo added none

    // And the sitter's bookings list has no demo rows either:
    const list = await app.request(
      `/api/${SLUG_C}/admin/bookings`,
      {
        headers: await adminHeaders(TENANT_C),
      },
      env,
    );
    const { bookings } = (await list.json()) as { bookings: { customerEmail: string | null }[] };
    expect(bookings.some((b) => b.customerEmail === DEMO_EMAIL)).toBe(false);
  });
});

describe('the reserved email is uncreatable via admin routes', () => {
  it('POST /admin/customers rejects it with a friendly 400', async () => {
    const { env, raw } = createTestEnv();
    const res = await app.request(
      `/api/${SLUG_C}/admin/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await adminHeaders(TENANT_C)) },
        body: JSON.stringify({
          email: DEMO_EMAIL,
          name: 'Sneaky',
          petName: 'Rex',
          petType: 'dog',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'That email is reserved for the Pawservation demo.',
    );
    expect(raw.prepare(`SELECT Id FROM EndUsers WHERE Email = ?`).all(DEMO_EMAIL)).toEqual([]);
  });

  it('CSV import skips it with a reason and imports nothing for it', async () => {
    const { env, raw } = createTestEnv();
    const csv = `email,name,pet name,pet type\n${DEMO_EMAIL},Sneaky,Rex,dog`;
    const res = await app.request(
      `/api/${SLUG_C}/admin/customers/import`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await adminHeaders(TENANT_C)) },
        body: JSON.stringify({ csv, sendInvites: false }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      importedCustomers: number;
      skippedRows: { row: number; reason: string }[];
    };
    expect(body.importedCustomers).toBe(0);
    expect(body.skippedRows).toEqual([
      { row: 2, reason: 'That email is reserved for the Pawservation demo' },
    ]);
    expect(raw.prepare(`SELECT Id FROM EndUsers WHERE Email = ?`).all(DEMO_EMAIL)).toEqual([]);
  });
});
