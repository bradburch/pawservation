import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, endUserToken } from './helpers';

/**
 * Every seeded demo customer owns at least one live pet with a PetOwners edge — the
 * client-AND-pet invariant applied to the seed itself. eu_pr_jess was the lone pet-less
 * seed row (root cause of "can't complete a demo booking" on paws-and-relax).
 */
describe('seeded customers all have bookable pets', () => {
  it('every seeded EndUser has ≥1 live pet and every seeded pet has a PetOwners edge', () => {
    const { raw } = createTestEnv();
    const petless = raw
      .prepare(
        `SELECT u.Id FROM EndUsers u
          WHERE NOT EXISTS (
            SELECT 1 FROM PetOwners o
              JOIN EndUserPets p ON p.Id = o.PetId
             WHERE o.TenantId = u.TenantId AND o.EndUserId = u.Id AND p.DeceasedAt IS NULL)`,
      )
      .all();
    expect(petless).toEqual([]);
    const edgeless = raw
      .prepare(
        `SELECT p.Id FROM EndUserPets p
          WHERE NOT EXISTS (SELECT 1 FROM PetOwners o WHERE o.PetId = p.Id)`,
      )
      .all();
    expect(edgeless).toEqual([]);
  });

  it('jess can book Luna on paws-and-relax end to end', async () => {
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, 'paws-and-relax', 'jess@example.com');

    const meRes = await app.request(
      '/api/paws-and-relax/me',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env,
    );
    const me = (await meRes.json()) as { pets: { id: string; name: string; petType: string }[] };
    expect(me.pets).toEqual([{ id: 'pet_pr_luna', name: 'Luna', petType: 'dog' }]);

    const res = await app.request(
      '/api/paws-and-relax/bookings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-09-01',
          endDate: '2028-09-03',
          petIds: ['pet_pr_luna'],
          answers: {},
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { estCost: number; status: string };
    expect(body).toMatchObject({ estCost: 90, status: 'pending' }); // 2 nights × $45
    const row = raw
      .prepare(`SELECT PetId FROM BookingRequestPets WHERE PetId = 'pet_pr_luna'`)
      .get();
    expect(row).toBeDefined();
  });
});
