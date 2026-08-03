import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';
const EMAIL = 'newclient-uj@example.com';

/** UJ-7: a sitter manually adds a customer and her pet; that customer then logs in
 *  herself and books, and the sitter sees the booking attributed to the pet by name. */
describe('client management flow', () => {
  it('admin adds customer+pet -> customer logs in -> books -> admin sees the pet name', async () => {
    const { env } = createTestEnv();
    const admin = await adminHeaders(TENANT_A);
    const adminJson = { ...admin, 'Content-Type': 'application/json' };

    const add = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers: adminJson,
        body: JSON.stringify({
          email: EMAIL,
          name: 'New Client',
          petName: 'Whiskers',
          petType: 'cat',
        }),
      },
      env,
    );
    expect(add.status).toBe(201);
    const created = (await add.json()) as { id: string; status: string };
    expect(created.status).toBe('invited');

    // The customer logs herself in — real identify -> verify round trip, no password.
    const token = await endUserToken(env, SLUG, EMAIL);

    const me = (await (
      await app.request(`/api/${SLUG}/me`, { headers: { Authorization: `Bearer ${token}` } }, env)
    ).json()) as { pets: { id: string; name: string; petType: string }[] };
    const whiskers = me.pets.find((p) => p.name === 'Whiskers')!;
    expect(whiskers.petType).toBe('cat');

    const bookRes = await app.request(
      `/api/${SLUG}/bookings`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-12-01',
          endDate: '2028-12-03',
          petIds: [whiskers.id],
        }),
      },
      env,
    );
    expect(bookRes.status).toBe(201);
    const { id } = (await bookRes.json()) as { id: string };

    const bookings = (await (
      await app.request(`/api/${SLUG}/admin/bookings`, { headers: admin }, env)
    ).json()) as { bookings: { id: string; petNames: string[] }[] };
    expect(bookings.bookings.find((b) => b.id === id)!.petNames).toEqual(['Whiskers']);
  });
});
