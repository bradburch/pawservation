import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';
import { addDays, getPacificDateStr } from '../../src/shared/index.js';

/**
 * A sitter answering from a stale card. The dashboard shows a booking as it was when the page
 * loaded; the client may have edited it since. `expected` is the optional precondition the answer
 * carries — the dates, pet count and estimate she was looking at — enforced inside the UPDATE's own
 * WHERE clause, so a change that lands between the read and the write cannot slip through.
 */

type Row = { StartDate: string; EndDate: string | null; PetCount: number; EstCost: number | null };
type Expected = {
  startDate: string;
  endDate: string | null;
  petCount: number;
  estCostCents: number | null;
};

const book = async (env: Env, petIds: string[] = ['pet_sp_bella']): Promise<string> => {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  const res = await app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type: 'boarding',
        startDate: '2028-10-01',
        endDate: '2028-10-03',
        petIds,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};

const rowOf = (raw: DatabaseSync, id: string): Row & { Status: string } =>
  raw
    .prepare(
      'SELECT StartDate, EndDate, PetCount, EstCost, Status FROM BookingRequests WHERE Id = ?',
    )
    .get(id) as Row & { Status: string };

const expectedOf = (r: Row): Expected => ({
  startDate: r.StartDate,
  endDate: r.EndDate,
  petCount: r.PetCount,
  estCostCents: r.EstCost,
});

const post = async (env: Env, id: string, body: Record<string, unknown>): Promise<Response> =>
  app.request(
    `/api/sunny-paws/admin/bookings/${id}/status`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

describe('booking status precondition (expected)', () => {
  it('applies when every field matches', async () => {
    const { env, raw } = createTestEnv();
    const id = await book(env);
    const res = await post(env, id, { status: 'confirmed', expected: expectedOf(rowOf(raw, id)) });
    expect(res.status).toBe(200);
    expect(rowOf(raw, id).Status).toBe('confirmed');
  });

  it('absent expected behaves exactly as before', async () => {
    const { env, raw } = createTestEnv();
    const id = await book(env);
    expect((await post(env, id, { status: 'confirmed' })).status).toBe(200);
    expect(rowOf(raw, id).Status).toBe('confirmed');
  });

  const mutations: [string, (e: Expected) => Expected][] = [
    ['startDate', (e) => ({ ...e, startDate: '2028-10-02' })],
    ['endDate', (e) => ({ ...e, endDate: '2028-10-04' })],
    ['endDate null vs set', (e) => ({ ...e, endDate: null })],
    ['petCount', (e) => ({ ...e, petCount: e.petCount + 1 })],
    ['estCostCents', (e) => ({ ...e, estCostCents: (e.estCostCents ?? 0) + 1 })],
    ['estCostCents null vs set', (e) => ({ ...e, estCostCents: null })],
  ];

  for (const status of ['confirmed', 'declined', 'cancelled'] as const) {
    for (const [field, mutate] of mutations) {
      it(`${status}: a differing ${field} is 409 booking_changed and the row is untouched`, async () => {
        const { env, raw } = createTestEnv();
        const id = await book(env);
        if (status === 'cancelled')
          raw.exec(`UPDATE BookingRequests SET Status='confirmed' WHERE Id='${id}'`);
        const before = rowOf(raw, id);
        expect(before.EstCost).not.toBeNull();
        const res = await post(env, id, { status, expected: mutate(expectedOf(before)) });
        expect(res.status).toBe(409);
        const json = (await res.json()) as {
          error: string;
          code: string;
          requiresOverride?: unknown;
        };
        expect(json.code).toBe('booking_changed');
        expect(typeof json.error).toBe('string');
        expect(json.requiresOverride).toBeUndefined();
        expect(rowOf(raw, id)).toEqual(before);
      });
    }
  }

  // The assessed-cancellation UPDATE is its own statement with the fee bound FIRST: it needs a stay
  // inside a tier window (a far-future stay computes a $0 fee and takes the plain cancel branch).
  const bookSoon = async (env: Env): Promise<string> => {
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'boarding',
          startDate: addDays(getPacificDateStr(), 1),
          endDate: addDays(getPacificDateStr(), 3),
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const seedTiers = (raw: DatabaseSync): void => {
    raw.exec(
      `UPDATE TenantServices SET CancellationTiers = '[{"withinDays":7,"percent":100}]'
       WHERE TenantId = '${TENANT_A}' AND ServiceType = 'boarding'`,
    );
  };
  const feeOf = (raw: DatabaseSync, id: string): number | null =>
    (
      raw.prepare('SELECT CancellationFee FROM BookingRequests WHERE Id = ?').get(id) as {
        CancellationFee: number | null;
      }
    ).CancellationFee;

  it('cancel with a fee: a matching expected cancels and records the fee', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    const id = await bookSoon(env);
    raw.exec(`UPDATE BookingRequests SET Status='confirmed' WHERE Id='${id}'`);
    const before = rowOf(raw, id);
    const res = await post(env, id, {
      status: 'cancelled',
      chargeFee: true,
      expected: expectedOf(before),
    });
    expect(res.status).toBe(200);
    expect(rowOf(raw, id).Status).toBe('cancelled');
    expect(feeOf(raw, id)).toBe(before.EstCost);
  });

  for (const [field, mutate] of mutations) {
    it(`cancel with a fee: a differing ${field} is 409 booking_changed and no fee is recorded`, async () => {
      const { env, raw } = createTestEnv();
      seedTiers(raw);
      const id = await bookSoon(env);
      raw.exec(`UPDATE BookingRequests SET Status='confirmed' WHERE Id='${id}'`);
      const before = rowOf(raw, id);
      expect(before.EstCost).not.toBeNull();
      const res = await post(env, id, {
        status: 'cancelled',
        chargeFee: true,
        expected: mutate(expectedOf(before)),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('booking_changed');
      expect(rowOf(raw, id)).toEqual(before);
      expect(feeOf(raw, id)).toBeNull();
    });
  }

  it('a stale expected on a row whose estimate and end date are NULL still matches via IS', async () => {
    const { env, raw } = createTestEnv();
    const id = await book(env);
    raw.exec(`UPDATE BookingRequests SET EndDate = NULL, EstCost = NULL WHERE Id = '${id}'`);
    const expected = expectedOf(rowOf(raw, id));
    expect(expected.endDate).toBeNull();
    expect(expected.estCostCents).toBeNull();
    expect((await post(env, id, { status: 'confirmed', expected })).status).toBe(200);
    expect(rowOf(raw, id).Status).toBe('confirmed');
  });

  it('a stale precondition against a NULL row is refused', async () => {
    const { env, raw } = createTestEnv();
    const id = await book(env);
    raw.exec(`UPDATE BookingRequests SET EndDate = NULL, EstCost = NULL WHERE Id = '${id}'`);
    const e = expectedOf(rowOf(raw, id));
    const res = await post(env, id, {
      status: 'confirmed',
      expected: { ...e, endDate: '2028-10-03', estCostCents: 100 },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('booking_changed');
  });

  it('an unknown booking is still 404, and a terminal one with matching fields is the existing 404', async () => {
    const { env, raw } = createTestEnv();
    const id = await book(env);
    const expected = expectedOf(rowOf(raw, id));
    expect((await post(env, 'nope', { status: 'confirmed', expected })).status).toBe(404);
    raw.exec(`UPDATE BookingRequests SET Status='declined' WHERE Id='${id}'`);
    expect((await post(env, id, { status: 'confirmed', expected })).status).toBe(404);
  });

  it('a blocked row is 404, never booking_changed', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, Status)
       VALUES ('bk_blk', '${TENANT_A}', NULL, 'blocked', '2028-11-01', '2028-11-02', 1, 'confirmed')`,
    );
    const res = await post(env, 'bk_blk', {
      status: 'cancelled',
      expected: { startDate: '2000-01-01', endDate: null, petCount: 9, estCostCents: null },
    });
    expect(res.status).toBe(404);
  });

  const malformed: [string, unknown][] = [
    ['not an object', 'x'],
    ['null', null],
    ['an array', []],
    ['missing startDate', { endDate: null, petCount: 1, estCostCents: null }],
    ['missing endDate', { startDate: '2028-10-01', petCount: 1, estCostCents: null }],
    ['missing estCostCents', { startDate: '2028-10-01', endDate: null, petCount: 1 }],
    ['non-string startDate', { startDate: 5, endDate: null, petCount: 1, estCostCents: null }],
    [
      'non-integer petCount',
      { startDate: '2028-10-01', endDate: null, petCount: 1.5, estCostCents: null },
    ],
    [
      'string petCount',
      { startDate: '2028-10-01', endDate: null, petCount: '1', estCostCents: null },
    ],
    [
      'fractional estCostCents',
      { startDate: '2028-10-01', endDate: null, petCount: 1, estCostCents: 10.5 },
    ],
    [
      'string estCostCents',
      { startDate: '2028-10-01', endDate: null, petCount: 1, estCostCents: '10' },
    ],
    ['numeric endDate', { startDate: '2028-10-01', endDate: 3, petCount: 1, estCostCents: null }],
  ];
  for (const [label, expected] of malformed) {
    it(`malformed (${label}) is 400 and changes nothing`, async () => {
      const { env, raw } = createTestEnv();
      const id = await book(env);
      const res = await post(env, id, { status: 'confirmed', expected });
      expect(res.status).toBe(400);
      expect(rowOf(raw, id).Status).toBe('pending');
    });
  }

  it('the capacity 409 keeps its own code and shape, distinguishable from booking_changed', async () => {
    const { env, raw } = createTestEnv();
    const a = await book(env, ['pet_sp_bella']);
    const b = await book(env, ['pet_sp_mochi']);
    raw.exec(
      `UPDATE TenantServices SET MaxConcurrentPets = 1 WHERE TenantId = '${TENANT_A}' AND ServiceType = 'boarding'`,
    );
    expect((await post(env, a, { status: 'confirmed' })).status).toBe(200);
    const res = await post(env, b, { status: 'confirmed', expected: expectedOf(rowOf(raw, b)) });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; requiresOverride: boolean };
    expect(json.code).toBe('capacity_conflict');
    expect(json.requiresOverride).toBe(true);
    expect(rowOf(raw, b).Status).toBe('pending');
  });
});
