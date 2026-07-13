import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { adminToken, createTestEnv, TENANT_A, TEST_SECRET, endUserToken } from './helpers';
import { setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';

/** UJ-1 end to end through the real app: identify → verify → book → my bookings. */
describe('booking flow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('completes identify → book → mine', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');

    const bookRes = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-08-10',
          endDate: '2028-08-15',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(bookRes.status).toBe(201);
    const booked = (await bookRes.json()) as { id: string; estCost: number; status: string };
    expect(booked.estCost).toBe(250); // $50/night × 5 nights
    expect(booked.status).toBe('pending');

    const mineRes = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const mine = (await mineRes.json()) as { bookings: { id: string }[] };
    expect(mine.bookings.map((b) => b.id)).toContain(booked.id);
  });

  it('rejects a conflicting submit with 409 (server-side re-validation)', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    // Seed leaves only 1 boarding slot at Sunny Paws over Jun 20-25; ask for 2 pets.
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-06-21',
          endDate: '2028-06-24',
          petIds: ['pet_sp_bella', 'pet_sp_mochi'],
        }),
      },
      env,
    );
    expect(res.status).toBe(409);
  });

  it('rejects a booking missing a required question answer', async () => {
    const { env } = createTestEnv();
    const adminHeaders = {
      Authorization: `Bearer ${await adminToken(TENANT_A)}`,
      'Content-Type': 'application/json',
    };
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'Is your dog crate-trained?', type: 'yesno', required: true }],
            },
          ],
        }),
      },
      env,
    );
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-08-10',
          endDate: '2028-08-15',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('persists valid answers and enforces the min-nights constraint', async () => {
    const { env } = createTestEnv();
    const adminHeaders = {
      Authorization: `Bearer ${await adminToken(TENANT_A)}`,
      'Content-Type': 'application/json',
    };
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'Is your dog crate-trained?', type: 'yesno', required: true }],
              minNights: 3,
            },
          ],
        }),
      },
      env,
    );
    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: adminHeaders }, env)
    ).json()) as { services: { type: string; questions: { id: string }[] }[] };
    const questionId = settings.services.find((s) => s.type === 'boarding')!.questions[0].id;

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');

    // Below the 3-night minimum → rejected.
    const tooShort = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-08-10',
          endDate: '2028-08-11',
          petIds: ['pet_sp_bella'],
          answers: { [questionId]: 'yes' },
        }),
      },
      env,
    );
    expect(tooShort.status).toBe(400);

    // Meets the minimum and answers the required question → succeeds.
    const ok = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-08-10',
          endDate: '2028-08-13',
          petIds: ['pet_sp_bella'],
          answers: { [questionId]: 'yes' },
        }),
      },
      env,
    );
    expect(ok.status).toBe(201);
  });

  it('rejects reused and wrong codes', async () => {
    const { env } = createTestEnv();
    const identifyRes = await app.request(
      '/api/sunny-paws/identify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jess@example.com' }),
      },
      env,
    );
    const { codeId, prototypeCode } = (await identifyRes.json()) as {
      codeId: string;
      prototypeCode: string;
    };

    const wrong = await app.request(
      '/api/sunny-paws/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeId, code: '000000' === prototypeCode ? '111111' : '000000' }),
      },
      env,
    );
    expect(wrong.status).toBe(401);

    const ok = await app.request(
      '/api/sunny-paws/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeId, code: prototypeCode }),
      },
      env,
    );
    expect(ok.status).toBe(200);

    const reused = await app.request(
      '/api/sunny-paws/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeId, code: prototypeCode }),
      },
      env,
    );
    expect(reused.status).toBe(401);
  });

  it('locks a login code after too many wrong attempts (brute-force cap)', async () => {
    const { env } = createTestEnv();
    const identifyRes = await app.request(
      '/api/sunny-paws/identify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jess@example.com' }),
      },
      env,
    );
    const { codeId, prototypeCode } = (await identifyRes.json()) as {
      codeId: string;
      prototypeCode: string;
    };
    const wrongCode = prototypeCode === '000000' ? '111111' : '000000';

    const verify = (code: string) =>
      app.request(
        '/api/sunny-paws/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codeId, code }),
        },
        env,
      );

    // Exhaust the 5-attempt cap with wrong guesses…
    for (let i = 0; i < 5; i++) expect((await verify(wrongCode)).status).toBe(401);
    // …then even the CORRECT code is rejected, because the code is now locked.
    expect((await verify(prototypeCode)).status).toBe(401);
  });

  it('returns 400 (not 500) for non-string identify/verify fields', async () => {
    const { env } = createTestEnv();
    const badEmail = await app.request(
      '/api/sunny-paws/identify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 5 }),
      },
      env,
    );
    expect(badEmail.status).toBe(400);
    const badCode = await app.request(
      '/api/sunny-paws/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeId: 'x', code: 123456 }),
      },
      env,
    );
    expect(badCode.status).toBe(400);
  });

  it('books a walk with optionKey d60 and petType dog, persists both fields', async () => {
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');

    const bookRes = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'walk',
          startDate: '2028-09-01',
          optionKey: 'd60',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(bookRes.status).toBe(201);
    const booked = (await bookRes.json()) as { id: string; estCost: number; status: string };
    expect(booked.estCost).toBe(35); // d60 walk = $35/visit
    expect(booked.status).toBe('pending');

    const row = raw
      .prepare('SELECT OptionKey, PetType, ServiceType FROM BookingRequests WHERE Id = ?')
      .get(booked.id) as { OptionKey: string; PetType: string; ServiceType: string } | undefined;
    expect(row?.OptionKey).toBe('d60');
    expect(row?.PetType).toBe('dog');
    expect(row?.ServiceType).toBe('walk');
  });

  it('books a dog walk at happy-tails (Otis is an accepted species)', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');

    const res = await app.request(
      '/api/happy-tails/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'walk',
          startDate: '2028-09-01',
          petIds: ['pet_ht_otis'],
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
  });

  it('sets embeddable headers on /embed/* and locked headers elsewhere', async () => {
    const { env } = createTestEnv();
    const embed = await app.request('/embed/sunny-paws', {}, env);
    expect(embed.headers.get('X-Frame-Options')).toBeNull();
    expect(embed.headers.get('Content-Security-Policy') ?? '').not.toContain('frame-ancestors');

    const api = await app.request('/api/sunny-paws/config', {}, env);
    expect(api.headers.get('X-Frame-Options')).toBe('DENY');
    expect(api.headers.get('Content-Security-Policy') ?? '').toContain("frame-ancestors 'none'");
  });

  it('creates a calendar event when the tenant calendar is connected', async () => {
    const { env, raw } = createTestEnv();
    await setProviderTokens(env.PAWBOOK_DB, 'tnt_sunnypaws', 'calendar', 'google-calendar', {
      access: await encryptToken(TEST_SECRET, 'at'),
      refresh: await encryptToken(TEST_SECRET, 'rt'),
      expiresAt: '2031-01-01T00:00:00Z',
      calendarId: 'primary',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_book' }), { status: 200 }),
    );

    // identify→verify→token. At this point in the plan identify is still open; after Task 10 it is
    // gated but `jess@example.com` is a seeded active customer (Task 9), so this keeps passing.
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'daycare',
          startDate: '2030-09-09',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id=?`).get(id) as {
      GCalEventId: string;
    };
    expect(row.GCalEventId).toBe('evt_book');
  });

  it('rejects the third booking into a capacity-2 windowed slot', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `INSERT INTO TenantServiceOptions
           (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'opt_sp_morning',
        'tnt_sunnypaws',
        'walk',
        'morning-walk',
        'Morning Walk',
        180,
        25,
        'visit',
        '11:00',
        '14:00',
        2,
      );

    const book = async () => {
      const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
      return app.request(
        '/api/sunny-paws/bookings',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            type: 'walk',
            optionKey: 'morning-walk',
            startDate: '2028-10-01',
            petIds: ['pet_sp_bella'],
          }),
        },
        env,
      );
    };

    const first = await book();
    const second = await book();
    const third = await book();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(409);
  });

  it('a windowed booking creates a timed (not all-day) calendar event matching its window', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `INSERT INTO TenantServiceOptions
           (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'opt_sp_evening',
        'tnt_sunnypaws',
        'walk',
        'evening-walk',
        'Evening Walk',
        120,
        30,
        'visit',
        '17:00',
        '19:00',
        null,
      );
    await setProviderTokens(env.PAWBOOK_DB, 'tnt_sunnypaws', 'calendar', 'google-calendar', {
      access: await encryptToken(TEST_SECRET, 'at'),
      refresh: await encryptToken(TEST_SECRET, 'rt'),
      expiresAt: '2031-01-01T00:00:00Z',
      calendarId: 'primary',
    });
    let sentBody: { start?: { dateTime?: string }; end?: { dateTime?: string } } = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ id: 'evt_window' }), { status: 200 });
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'walk',
          optionKey: 'evening-walk',
          startDate: '2028-10-02',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    expect(sentBody.start?.dateTime).toBe('2028-10-02T17:00:00');
    expect(sentBody.end?.dateTime).toBe('2028-10-02T19:00:00');
  });
});
