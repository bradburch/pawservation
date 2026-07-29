import { describe, expect, it } from 'vitest';
import app from '../index';
import { setServiceConfig, updateTenantSettings, listServices, getTenantBySlug } from '../db/repo';
import { validateBookingWindow } from '../lib/validation';
import { addDays, addMonths, getPacificDateStr } from '../../src/shared/index.js';
import { adminHeaders, createTestEnv, endUserToken, seedPets, TENANT_A } from './helpers';

/**
 * The booking window (migration 0004, owner directive 2026-07-28):
 *   TenantServices.MinLeadDays — per-service minimum notice (1 = no same-day requests).
 *   Tenants.MaxAdvanceMonths — ONE profile-level horizon (8 = nothing past 8 months out).
 * Enforced identically at the quote, the month grid, and the booking POST; NULL = today's
 * behavior exactly.
 */

const today = () => getPacificDateStr();

async function setLeadDays(env: Env, days: number | null): Promise<void> {
  const current = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
    (s) => s.ServiceType === 'boarding',
  )!;
  await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'boarding', {
    enabled: true,
    description: current.Description,
    questions: current.Questions,
    maxNights: current.MaxNights,
    maxPetCount: current.MaxPetCount,
    minLeadDays: days,
    acceptedPetTypes: current.AcceptedPetTypes,
    maxConcurrentPets: current.MaxConcurrentPets,
    cancellationTiers: current.CancellationTiers,
    holidayRate: current.HolidayRate,
    petRateMode: current.PetRateMode,
  });
}

async function setHorizon(env: Env, months: number | null): Promise<void> {
  const t = (await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws'))!;
  await updateTenantSettings(env.PAWBOOK_DB, TENANT_A, {
    displayName: t.DisplayName,
    accentColor: t.AccentColor,
    timezone: t.Timezone,
    contactEmail: t.ContactEmail,
    contactPhone: t.ContactPhone,
    maxAdvanceMonths: months,
  });
}

async function quote(env: Env, start: string, end: string, petIds: string[]): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    `/api/sunny-paws/availability?type=boarding&start=${start}&end=${end}&petIds=${petIds.join(',')}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

async function book(env: Env, start: string, end: string, petIds: string[]): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'boarding', startDate: start, endDate: end, petIds }),
    },
    env,
  );
}

describe('addMonths', () => {
  it('adds calendar months, clamping the day to the target month length', () => {
    expect(addMonths('2026-03-15', 2)).toBe('2026-05-15');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28'); // clamp, non-leap
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // clamp, leap
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15'); // year rollover
    expect(addMonths('2026-05-01', 12)).toBe('2027-05-01');
  });
});

describe('validateBookingWindow (pure)', () => {
  const t = today();

  it('null/0 lead days and null horizon = no constraint at all', () => {
    expect(validateBookingWindow(t, null, null)).toBeNull();
    expect(validateBookingWindow(t, 0, null)).toBeNull();
    expect(validateBookingWindow(addDays(t, 500), null, null)).toBeNull();
  });

  it('minLeadDays 1 refuses today and allows tomorrow (the owner example)', () => {
    const refused = validateBookingWindow(t, 1, null);
    expect(refused?.code).toBe('too_soon');
    expect(refused?.error).toContain('1 day of notice');
    expect(validateBookingWindow(addDays(t, 1), 1, null)).toBeNull();
  });

  it('the horizon refuses past the boundary and allows exactly on it', () => {
    const boundary = addMonths(t, 8);
    expect(validateBookingWindow(boundary, null, 8)).toBeNull();
    const refused = validateBookingWindow(addDays(boundary, 1), null, 8);
    expect(refused?.code).toBe('too_far_ahead');
    expect(refused?.error).toContain('8 months ahead');
  });
});

describe('booking window over the API', () => {
  it('quote and POST refuse a same-day boarding start when MinLeadDays = 1, and allow tomorrow', async () => {
    const { env, raw } = createTestEnv();
    await setLeadDays(env, 1);
    const [petId] = seedPets(raw, TENANT_A, 'eu_sp_jess', [{ id: 'pet_bw_a', petType: 'dog' }]);

    const t = today();
    const refusedQuote = await quote(env, t, addDays(t, 2), [petId]);
    expect(refusedQuote.status).toBe(400);
    expect(((await refusedQuote.json()) as { error: string }).error).toContain('day of notice');

    const refusedPost = await book(env, t, addDays(t, 2), [petId]);
    expect(refusedPost.status).toBe(400);
    expect((await refusedPost.json()) as object).toMatchObject({ code: 'too_soon' });

    const okQuote = await quote(env, addDays(t, 1), addDays(t, 3), [petId]);
    expect(okQuote.status).toBe(200);
    const okPost = await book(env, addDays(t, 1), addDays(t, 3), [petId]);
    expect(okPost.status).toBe(201);
  });

  it('quote and POST refuse a start past the profile horizon, and allow inside it', async () => {
    const { env, raw } = createTestEnv();
    await setHorizon(env, 2);
    const [petId] = seedPets(raw, TENANT_A, 'eu_sp_jess', [{ id: 'pet_bw_b', petType: 'dog' }]);

    const t = today();
    const past = addDays(addMonths(t, 2), 1);
    const refusedQuote = await quote(env, past, addDays(past, 2), [petId]);
    expect(refusedQuote.status).toBe(400);
    expect(((await refusedQuote.json()) as { error: string }).error).toContain('months ahead');

    const refusedPost = await book(env, past, addDays(past, 2), [petId]);
    expect(refusedPost.status).toBe(400);
    expect((await refusedPost.json()) as object).toMatchObject({ code: 'too_far_ahead' });

    const inside = addDays(t, 20);
    expect((await book(env, inside, addDays(inside, 2), [petId])).status).toBe(201);
  });

  it('the month grid paints out-of-window days unavailable — same rule, same clock', async () => {
    const { env } = createTestEnv();
    await setLeadDays(env, 3);
    await setHorizon(env, 1);
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');

    const t = today();
    const thisMonth = t.slice(0, 7);
    const res = await app.request(
      `/api/sunny-paws/availability/month?type=boarding&month=${thisMonth}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: { date: string; status: string }[];
    };
    const earliest = addDays(t, 3);
    for (const day of body.days) {
      if (day.date >= t && day.date < earliest) expect(day.status).toBe('unavailable');
      if (day.date === earliest) expect(day.status).not.toBe('unavailable');
    }

    // A month fully past the 1-month horizon: every day unavailable.
    const farMonth = addMonths(t, 3).slice(0, 7);
    const far = await app.request(
      `/api/sunny-paws/availability/month?type=boarding&month=${farMonth}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const farBody = (await far.json()) as { days: { status: string }[] };
    expect(farBody.days.every((d) => d.status === 'unavailable')).toBe(true);
  });

  it('settings PUT round-trips both knobs and rejects out-of-rail values', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };

    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          maxAdvanceMonths: 8,
          services: [
            {
              type: 'boarding',
              enabled: true,
              minLeadDays: 2,
              options: [{ label: 'Standard', durationMinutes: null, rate: 75 }],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const get = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const settings = (await get.json()) as {
      maxAdvanceMonths: number | null;
      services: { type: string; minLeadDays: number | null }[];
    };
    expect(settings.maxAdvanceMonths).toBe(8);
    expect(settings.services.find((s) => s.type === 'boarding')?.minLeadDays).toBe(2);

    // A PUT that never mentions either knob keeps them (PATCH semantics — the wipe guard).
    const silent = await app.request(
      '/api/sunny-paws/admin/settings',
      { method: 'PUT', headers, body: JSON.stringify({ displayName: 'Sunny Paws' }) },
      env,
    );
    expect(silent.status).toBe(204);
    const after = (await (
      await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as { maxAdvanceMonths: number | null };
    expect(after.maxAdvanceMonths).toBe(8);

    // Rails: months 1..24, lead days 0..90, integers only.
    for (const body of [
      { maxAdvanceMonths: 0 },
      { maxAdvanceMonths: 25 },
      { maxAdvanceMonths: 2.5 },
      {
        services: [
          {
            type: 'boarding',
            enabled: true,
            minLeadDays: -1,
            options: [{ label: 'Standard', durationMinutes: null, rate: 75 }],
          },
        ],
      },
      {
        services: [
          {
            type: 'boarding',
            enabled: true,
            minLeadDays: 91,
            options: [{ label: 'Standard', durationMinutes: null, rate: 75 }],
          },
        ],
      },
      {
        services: [
          {
            type: 'boarding',
            enabled: true,
            minLeadDays: 1.5,
            options: [{ label: 'Standard', durationMinutes: null, rate: 75 }],
          },
        ],
      },
    ]) {
      const bad = await app.request(
        '/api/sunny-paws/admin/settings',
        { method: 'PUT', headers, body: JSON.stringify(body) },
        env,
      );
      expect(bad.status).toBe(400);
    }
  });
});
