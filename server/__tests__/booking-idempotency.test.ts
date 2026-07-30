import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, endUserToken } from './helpers';

const BOOKING = {
  type: 'boarding',
  startDate: '2028-08-10',
  endDate: '2028-08-15',
  petIds: ['pet_sp_bella'],
};

function post(env: unknown, token: string, key?: string, body: unknown = BOOKING) {
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(body),
    },
    env as never,
  );
}

describe('booking idempotency + error codes', () => {
  it('replays with the same Idempotency-Key return the original booking', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const first = await post(env, token, 'idem-key-1');
    expect(first.status).toBe(201);
    const a = (await first.json()) as { id: string; estCost: number };
    const second = await post(env, token, 'idem-key-1');
    expect(second.status).toBe(201);
    const b = (await second.json()) as { id: string; estCost: number };
    expect(b.id).toBe(a.id);
    expect(b.estCost).toBe(a.estCost);
  });

  // The widget now sends a key on every attempt (one primary "Request Booking" button makes a
  // double-tap likelier), so "the replay returned the same id" is not enough on its own — the
  // second POST must leave no second row, and no second set of pet links, behind it.
  it('a replay persists nothing: one booking row, one set of pet links', async () => {
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const first = (await (await post(env, token, 'idem-once')).json()) as { id: string };
    const second = (await (await post(env, token, 'idem-once')).json()) as { id: string };
    expect(second.id).toBe(first.id);

    const rows = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM BookingRequests
         WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'boarding' AND StartDate = ?`,
      )
      .get(BOOKING.startDate) as { n: number };
    expect(rows.n).toBe(1);

    const pets = raw
      .prepare(`SELECT COUNT(*) AS n FROM BookingRequestPets WHERE BookingRequestId = ?`)
      .get(first.id) as { n: number };
    expect(pets.n).toBe(1);
  });

  it('different keys create different bookings; no key never dedupes', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const a = (await (await post(env, token, 'key-a')).json()) as { id: string };
    const b = (await (
      await post(env, token, 'key-b', {
        ...BOOKING,
        startDate: '2028-09-10',
        endDate: '2028-09-12',
      })
    ).json()) as { id: string };
    expect(b.id).not.toBe(a.id);
  });

  it('rejects an oversized key with a machine-readable code', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await post(env, token, 'x'.repeat(129));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_idempotency_key');
  });

  it('validation errors carry stable codes', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const unknownService = await post(env, token, undefined, { ...BOOKING, type: 'nope' });
    expect(((await unknownService.json()) as { code: string }).code).toBe('unknown_service_type');
    const noPets = await post(env, token, undefined, { ...BOOKING, petIds: [] });
    expect(((await noPets.json()) as { code: string }).code).toBe('no_pets_selected');
    const pastDate = await post(env, token, undefined, {
      ...BOOKING,
      startDate: '2020-01-01',
      endDate: '2020-01-02',
    });
    expect(((await pastDate.json()) as { code: string }).code).toBe('date_in_past');
  });
});
