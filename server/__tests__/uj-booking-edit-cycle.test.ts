import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

/** UJ-4: a confirmed booking edited by its customer drops back to pending and must be
 *  re-confirmed — the sitter agreed to specific dates, not to whatever they become. */
describe('booking edit cycle', () => {
  it('book -> confirm -> customer edits dates -> pending again -> re-confirm', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');

    const bookRes = await app.request(
      `/api/${SLUG}/bookings`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-09-10',
          endDate: '2028-09-15',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(bookRes.status).toBe(201);
    const { id, estCost: originalCost } = (await bookRes.json()) as {
      id: string;
      estCost: number;
    };
    expect(originalCost).toBe(250); // $50/night x 5 nights

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

    const edit = await app.request(
      `/api/${SLUG}/bookings/${id}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: '2028-09-17',
          endDate: '2028-09-23',
          petIds: ['pet_sp_bella'],
          answers: {},
        }),
      },
      env,
    );
    expect(edit.status).toBe(200);
    const edited = (await edit.json()) as { id: string; estCost: number; status: string };
    expect(edited.status).toBe('pending');
    expect(edited.estCost).toBe(300); // 6 nights x $50 — re-quoted because dates moved

    const mineAfterEdit = (await (
      await app.request(
        `/api/${SLUG}/bookings/mine`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).json()) as { bookings: { id: string; status: string; startDate: string }[] };
    const row = mineAfterEdit.bookings.find((b) => b.id === id)!;
    expect(row.status).toBe('pending');
    expect(row.startDate).toBe('2028-09-17');

    const reconfirm = await app.request(
      `/api/${SLUG}/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { ...admin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      },
      env,
    );
    expect(reconfirm.status).toBe(200);

    const mineFinal = (await (
      await app.request(
        `/api/${SLUG}/bookings/mine`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).json()) as { bookings: { id: string; status: string }[] };
    expect(mineFinal.bookings.find((b) => b.id === id)!.status).toBe('confirmed');
  });
});
