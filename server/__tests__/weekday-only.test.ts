import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminToken, createTestEnv, endUserToken, TENANT_A } from './helpers';

/** Admin Bearer headers for a tenant, optionally with a JSON content type. */
async function auth(tenantId: string, json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { Authorization: `Bearer ${await adminToken(tenantId)}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** PUT one walk option for Sunny Paws and return the response. */
async function putWalkOption(env: Env, option: Record<string, unknown>): Promise<Response> {
  return app.request(
    '/api/sunny-paws/admin/settings',
    {
      method: 'PUT',
      headers: await auth(TENANT_A, true),
      body: JSON.stringify({
        services: [{ type: 'walk', enabled: true, options: [option] }],
      }),
    },
    env,
  );
}

type OptionWire = { optionKey: string; weekdaysOnly: boolean };
type SettingsWire = { services: { type: string; options: OptionWire[] }[] };

describe('weekday-only — settings round-trip', () => {
  it('persists weekdaysOnly=true and returns it in admin settings AND public config', async () => {
    const { env } = createTestEnv();
    const put = await putWalkOption(env, {
      label: 'Pack walk',
      rate: 25,
      startTime: '10:00',
      endTime: '14:00',
      capacity: 8,
      weekdaysOnly: true,
    });
    expect(put.status).toBe(204);

    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as SettingsWire;
    const adminWalk = settings.services.find((s) => s.type === 'walk')!;
    expect(adminWalk.options).toEqual([
      expect.objectContaining({ optionKey: 'pack-walk', weekdaysOnly: true }),
    ]);

    const cfg = (await (
      await app.request('/api/sunny-paws/config', {}, env)
    ).json()) as SettingsWire;
    const cfgWalk = cfg.services.find((s) => s.type === 'walk')!;
    expect(cfgWalk.options).toEqual([
      expect.objectContaining({ optionKey: 'pack-walk', weekdaysOnly: true }),
    ]);
  });

  it('defaults to false when the flag is omitted', async () => {
    const { env } = createTestEnv();
    const put = await putWalkOption(env, {
      label: 'Anyday walk',
      rate: 20,
      startTime: '09:00',
      endTime: '10:00',
      capacity: 3,
    });
    expect(put.status).toBe(204);

    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as SettingsWire;
    const walk = settings.services.find((s) => s.type === 'walk')!;
    expect(walk.options[0]).toMatchObject({ weekdaysOnly: false });
  });

  it('rejects a non-boolean weekdaysOnly with 400 (atomic — nothing saved)', async () => {
    const { env } = createTestEnv();
    const put = await putWalkOption(env, {
      label: 'Bad walk',
      rate: 20,
      startTime: '10:00',
      endTime: '11:00',
      weekdaysOnly: 'yes',
    });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toMatch(/weekdays/i);

    // The invalid save must not have replaced the seeded walk options.
    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as SettingsWire;
    const walk = settings.services.find((s) => s.type === 'walk')!;
    expect(walk.options.map((o) => o.optionKey)).toContain('d30'); // seeded option intact
  });
});

/** Book Sunny Paws' walk service as the seeded customer. 2028-07-22 = Sat, 2028-07-24 = Mon. */
async function bookWalk(env: Env, optionKey: string, startDate: string): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'walk',
        optionKey,
        startDate,
        petIds: ['pet_sp_bella'],
        answers: {},
      }),
    },
    env,
  );
}

/** PUT the (already-seeded, non-windowed) boarding option for Sunny Paws and return the response. */
async function putBoardingOption(env: Env, option: Record<string, unknown>): Promise<Response> {
  return app.request(
    '/api/sunny-paws/admin/settings',
    {
      method: 'PUT',
      headers: await auth(TENANT_A, true),
      body: JSON.stringify({
        services: [{ type: 'boarding', enabled: true, options: [option] }],
      }),
    },
    env,
  );
}

/** Book Sunny Paws' boarding service (range shape) as the seeded customer. */
async function bookBoarding(env: Env, startDate: string, endDate: string): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        optionKey: 'standard',
        startDate,
        endDate,
        petIds: ['pet_sp_bella'],
        answers: {},
      }),
    },
    env,
  );
}

describe('weekday-only — range-shaped option (spec: reject a weekend ANYWHERE in the span)', () => {
  it('rejects a Thu→Wed boarding span that starts and ends on weekdays but crosses a weekend', async () => {
    const { env } = createTestEnv();
    expect(
      (await putBoardingOption(env, { label: 'Standard', rate: 50, weekdaysOnly: true })).status,
    ).toBe(204);

    // 2028-07-20 = Thu, checkout 2028-07-26 = Wed. Occupied nights: Thu Fri Sat Sun Mon Tue —
    // includes the weekend even though the submitted start/end are both weekdays.
    const res = await bookBoarding(env, '2028-07-20', '2028-07-26');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/weekday/i);
  });

  it('accepts a boarding span entirely Mon–Fri for the same weekday-only option', async () => {
    const { env } = createTestEnv();
    await putBoardingOption(env, { label: 'Standard', rate: 50, weekdaysOnly: true });

    // 2028-07-24 = Mon, checkout 2028-07-28 = Fri. Occupied nights: Mon Tue Wed Thu — no weekend.
    const res = await bookBoarding(env, '2028-07-24', '2028-07-28');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { estCost: number; status: string };
    expect(body).toMatchObject({ estCost: 200, status: 'pending' });
  });
});

describe('weekday-only — booking enforcement (real schema, real routes)', () => {
  it('rejects a Saturday and a Sunday booking for a weekday-only option', async () => {
    const { env } = createTestEnv();
    expect(
      (
        await putWalkOption(env, {
          label: 'Pack walk',
          rate: 25,
          startTime: '10:00',
          endTime: '14:00',
          capacity: 8,
          weekdaysOnly: true,
        })
      ).status,
    ).toBe(204);

    for (const weekend of ['2028-07-22', '2028-07-23']) {
      const res = await bookWalk(env, 'pack-walk', weekend);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/weekday/i);
    }
  });

  it('accepts a Monday booking for the same weekday-only option', async () => {
    const { env } = createTestEnv();
    await putWalkOption(env, {
      label: 'Pack walk',
      rate: 25,
      startTime: '10:00',
      endTime: '14:00',
      capacity: 8,
      weekdaysOnly: true,
    });

    const res = await bookWalk(env, 'pack-walk', '2028-07-24');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { estCost: number; status: string };
    expect(body).toMatchObject({ estCost: 25, status: 'pending' });
  });

  it('still accepts Saturday bookings for a normal (non-weekday-only) option', async () => {
    const { env } = createTestEnv();
    // Seeded Sunny Paws walk option 'd30' has WeekdaysOnly defaulted to 0.
    const res = await bookWalk(env, 'd30', '2028-07-22');
    expect(res.status).toBe(201);
  });
});
