import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, endUserToken } from './helpers';
import { addEndUserPet } from '../db/repo';

const req = (env: Env, path: string, init: RequestInit) => app.request(path, init, env);

describe('booking by petIds', () => {
  it('returns the caller name+pets and books with them', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const me = (await (
      await req(env, '/api/sunny-paws/me', { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { name: string; pets: { id: string; name: string; petType: string }[] };
    expect(me.name).toBe('Jess Demo');
    expect(me.pets.map((p) => p.name).sort()).toEqual(['Bella', 'Mochi']);

    const book = await req(env, '/api/sunny-paws/bookings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        optionKey: 'standard',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        petIds: ['pet_sp_bella', 'pet_sp_mochi'],
      }),
    });
    expect(book.status).toBe(201);
    const { id: bookedId } = (await book.json()) as { id: string };

    const mine = (await (
      await req(env, '/api/sunny-paws/bookings/mine', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { bookings: { id: string; petCount: number; pets: string[] }[] };
    const created = mine.bookings.find((b) => b.id === bookedId)!;
    expect(created.petCount).toBe(2);
    expect(created.pets.sort()).toEqual(['Bella', 'Mochi']);
  });

  it('dedupes duplicate petIds in a booking', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const book = await req(env, '/api/sunny-paws/bookings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        optionKey: 'standard',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        petIds: ['pet_sp_bella', 'pet_sp_bella'],
      }),
    });
    expect(book.status).toBe(201);
    const { id: bookedId } = (await book.json()) as { id: string };

    const mine = (await (
      await req(env, '/api/sunny-paws/bookings/mine', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { bookings: { id: string; petCount: number; pets: string[] }[] };
    const created = mine.bookings.find((b) => b.id === bookedId)!;
    expect(created.petCount).toBe(1);
    expect(created.pets).toEqual(['Bella']);
  });

  it("rejects a pet the caller doesn't own", async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await req(env, '/api/sunny-paws/bookings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        optionKey: 'standard',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        petIds: ['pet_ht_otis'],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a pet whose species the tenant does not accept', async () => {
    const { env } = createTestEnv();
    // Insert a cat for the dogs-only Happy Tails customer directly (repo does not gate species).
    const cat = await addEndUserPet(
      env.PAWBOOK_DB,
      'tnt_happytails',
      'eu_ht_jess',
      'Whiskers',
      'cat',
    );
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const res = await req(env, '/api/happy-tails/bookings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        optionKey: 'standard',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        petIds: [cat.Id],
      }),
    });
    expect(res.status).toBe(400);
  });
});
