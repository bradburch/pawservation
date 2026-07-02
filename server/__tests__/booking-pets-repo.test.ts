import { describe, expect, it } from 'vitest';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';
import { addBookingPets, insertBookingRequest, listBookingPetsForUser } from '../db/repo';

describe('BookingRequestPets repo', () => {
  it('links a booking to pets and lists them for the user', async () => {
    const { env } = createTestEnv();
    const bookingId = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: 'eu_sp_jess',
      serviceType: 'boarding',
      startDate: '2026-08-01',
      endDate: '2026-08-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 2,
      estCost: 100,
      status: 'pending',
    });
    await addBookingPets(env.PAWBOOK_DB, TENANT_A, bookingId, ['pet_sp_bella', 'pet_sp_mochi']);
    const rows = await listBookingPetsForUser(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess');
    const names = rows
      .filter((r) => r.BookingRequestId === bookingId)
      .map((r) => r.Name)
      .sort();
    expect(names).toEqual(['Bella', 'Mochi']);
  });

  it('refuses to link a pet that belongs to another tenant', async () => {
    const { env } = createTestEnv();
    const bookingId = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: 'eu_sp_jess',
      serviceType: 'boarding',
      startDate: '2026-08-05',
      endDate: '2026-08-07',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    // pet_ht_otis belongs to TENANT_B; the guarded insert must write nothing for it.
    await addBookingPets(env.PAWBOOK_DB, TENANT_A, bookingId, ['pet_ht_otis']);
    const rows = await listBookingPetsForUser(env.PAWBOOK_DB, TENANT_B, 'eu_ht_jess');
    expect(rows.some((r) => r.BookingRequestId === bookingId)).toBe(false);
  });
});
