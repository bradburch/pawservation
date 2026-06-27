import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv } from './helpers';

/** UJ-1 end to end through the real app: identify → verify → book → my bookings. */
describe('booking flow', () => {
  async function identify(env: Env, slug: string, email: string): Promise<string> {
    const identifyRes = await app.request(
      `/api/${slug}/identify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      },
      env,
    );
    expect(identifyRes.status).toBe(200);
    const { codeId, prototypeCode } = (await identifyRes.json()) as {
      codeId: string;
      prototypeCode: string;
    };
    expect(prototypeCode).toMatch(/^\d{6}$/);

    const verifyRes = await app.request(
      `/api/${slug}/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeId, code: prototypeCode }),
      },
      env,
    );
    expect(verifyRes.status).toBe(200);
    return ((await verifyRes.json()) as { token: string }).token;
  }

  it('completes identify → book → mine', async () => {
    const { env } = createTestEnv();
    const token = await identify(env, 'sunny-paws', 'jess@example.com');

    const bookRes = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-08-10',
          endDate: '2028-08-15',
          petCount: 1,
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
    const token = await identify(env, 'sunny-paws', 'jess@example.com');
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
          petCount: 2,
        }),
      },
      env,
    );
    expect(res.status).toBe(409);
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
    const token = await identify(env, 'sunny-paws', 'jess@example.com');

    const bookRes = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'walk',
          startDate: '2028-09-01',
          optionKey: 'd60',
          petType: 'dog',
          petCount: 1,
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

  it('rejects a booking with a petType not accepted by the tenant (happy-tails, cat)', async () => {
    const { env } = createTestEnv();
    const token = await identify(env, 'happy-tails', 'jess@example.com');

    const res = await app.request(
      '/api/happy-tails/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'walk',
          startDate: '2028-09-01',
          petType: 'cat',
          petCount: 1,
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('That pet type is not accepted.');
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
});
