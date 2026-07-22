import { describe, expect, it } from 'vitest';
import app from '../index';
import { mintToken } from '../lib/token';
import {
  adminHeaders,
  adminToken,
  createTestEnv,
  endUserToken,
  TENANT_A,
  TENANT_B,
  TEST_SECRET,
} from './helpers';

/** Admin Bearer headers for a tenant, optionally with a JSON content type. */
async function auth(tenantId: string, json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { Authorization: `Bearer ${await adminToken(tenantId)}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

describe('tenant admin', () => {
  it('rejects missing, malformed, end-user, and wrong-tenant tokens', async () => {
    const { env } = createTestEnv();

    const missing = await app.request('/api/sunny-paws/admin/settings', {}, env);
    expect(missing.status).toBe(401);

    const malformed = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: 'Bearer not-a-token' } },
      env,
    );
    expect(malformed.status).toBe(401);

    // A widget (end-user) token has no admin role → must not authenticate admin routes.
    const endUserToken = await mintToken('eu-1', TENANT_A, TEST_SECRET);
    const wrongRole = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${endUserToken}` } },
      env,
    );
    expect(wrongRole.status).toBe(401);

    // A valid admin token for the OTHER tenant → 403.
    const crossTenant = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await auth(TENANT_B) },
      env,
    );
    expect(crossTenant.status).toBe(403);
  });

  it('settings edits are tenant-scoped and reflected live in the widget config (FR19)', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          displayName: 'Sunny Paws Deluxe',
          accentColor: '#10b981',
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 75 }],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    // Widget config (KV cache invalidated) shows the new values…
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      displayName: string;
      accentColor: string;
      services: { type: string; options: { rate: number }[] }[];
    };
    expect(config.displayName).toBe('Sunny Paws Deluxe');
    expect(config.accentColor).toBe('#10b981');
    expect(config.services.find((s) => s.type === 'boarding')?.options[0].rate).toBe(75);

    // …and the OTHER tenant is untouched.
    const other = (await (await app.request('/api/happy-tails/config', {}, env)).json()) as {
      displayName: string;
    };
    expect(other.displayName).toBe('Happy Tails');
  });

  it('rejects a settings PUT with a bad service rate WITHOUT committing the rest (atomic validation)', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          displayName: 'Should Not Persist',
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 99 }],
            },
            {
              type: 'walk',
              enabled: true,
              options: [{ label: 'x', durationMinutes: 30, rate: 0 }], // invalid — rejects the whole request
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    // Neither the rename nor the first (valid) service may have been written.
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      displayName: string;
      services: { type: string; options: { rate: number }[] }[];
    };
    expect(config.displayName).toBe('Sunny Paws');
    expect(config.services.find((s) => s.type === 'boarding')?.options[0].rate).toBe(50);
  });

  it('capacity edits change availability outcomes (per-service cap)', async () => {
    const { env } = createTestEnv();
    // Seed: Jun 21-24 at Sunny Paws has 1 pet, max 2 -> a 2-pet request conflicts.
    const before = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2028-06-21&end=2028-06-24&pets=2',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(before.available).toBe(false);

    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              maxConcurrentPets: 5,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
            },
          ],
        }),
      },
      env,
    );

    const after = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2028-06-21&end=2028-06-24&pets=2',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(after.available).toBe(true);

    // The OTHER tenant's service cap is untouched by Sunny Paws' change.
    const otherSettings = (await (
      await app.request('/api/happy-tails/admin/settings', { headers: await auth(TENANT_B) }, env)
    ).json()) as { services: { type: string; maxConcurrentPets: number | null }[] };
    expect(otherSettings.services.find((s) => s.type === 'boarding')?.maxConcurrentPets).toBe(4);
  });

  it('disabling a service hides it from config and rejects bookings for it', async () => {
    const { env } = createTestEnv();
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ services: [{ type: 'walk', enabled: false, options: [] }] }),
      },
      env,
    );
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string }[];
    };
    expect(config.services.map((s) => s.type)).not.toContain('walk');
    const avail = await app.request(
      '/api/sunny-paws/availability?type=walk&start=2028-08-01',
      {},
      env,
    );
    expect(avail.status).toBe(400);
  });

  it('blocked ranges block boarding and walks, and removal restores availability', async () => {
    const { env } = createTestEnv();
    const created = (await (
      await app.request(
        '/api/sunny-paws/admin/blocked',
        {
          method: 'POST',
          headers: await auth(TENANT_A, true),
          body: JSON.stringify({ startDate: '2028-09-01', endDate: '2028-09-03' }),
        },
        env,
      )
    ).json()) as { id: string };

    const walk = (await (
      await app.request('/api/sunny-paws/availability?type=walk&start=2028-09-01', {}, env)
    ).json()) as { available: boolean };
    const boarding = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2028-08-30&end=2028-09-05&pets=1',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(walk.available).toBe(false);
    expect(boarding.available).toBe(false);

    await app.request(
      `/api/sunny-paws/admin/blocked/${created.id}`,
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    const walkAfter = (await (
      await app.request('/api/sunny-paws/availability?type=walk&start=2028-09-01', {}, env)
    ).json()) as { available: boolean };
    expect(walkAfter.available).toBe(true);
  });

  it('GET /admin/settings reports the calendar connection as disconnected by default', async () => {
    const { env } = createTestEnv();
    const res = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      calendar: { status: string; connectedAt: string | null; calendarId: string | null };
    };
    expect(res.calendar).toEqual({ status: 'disconnected', connectedAt: null, calendarId: null });
  });

  it('saves free-typed service options, reflected in config (top-level petTypes is ignored)', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          petTypes: ['cat'], // stale client payload — the registry no longer takes this field
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                { label: '20 min', durationMinutes: 20, rate: 22 },
                { label: '40 min', durationMinutes: 40, rate: 19 },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      petTypes: { slug: string; label: string }[];
      services: { type: string; options: { durationMinutes: number | null; rate: number }[] }[];
    };
    // The registry is untouched by the stale petTypes field — full seeded registry stays.
    expect(cfg.petTypes).toEqual([
      { slug: 'cat', label: 'Cats' },
      { slug: 'dog', label: 'Dogs' },
      { slug: 'rabbit', label: 'Rabbits' },
    ]);
    const walk = cfg.services.find((s) => s.type === 'walk')!;
    expect(walk.options).toHaveLength(2);
    expect(walk.options.find((o) => o.durationMinutes === 40)?.rate).toBe(19);
  });

  it('an unknown top-level pet type is silently ignored, not rejected', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ petTypes: ['dragon'] }),
      },
      env,
    );
    expect(res.status).toBe(204);
  });

  it('accepts two options sharing a duration but not a name, with distinct keys', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'checkin',
              enabled: true,
              options: [
                { label: '30 minutes', durationMinutes: 30, rate: 18 },
                { label: 'Puppy Check-in', durationMinutes: 30, rate: 22 },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(204);
    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as { services: { type: string; options: { optionKey: string; label: string }[] }[] };
    const checkin = settings.services.find((s) => s.type === 'checkin')!;
    expect(checkin.options.map((o) => o.label).sort()).toEqual(['30 minutes', 'Puppy Check-in']);
    expect(new Set(checkin.options.map((o) => o.optionKey)).size).toBe(2);
  });

  it('rejects two options with the same name within one service', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                { label: '30 min', durationMinutes: 30, rate: 20 },
                { label: '30 min', durationMinutes: 30, rate: 25 },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects multiple options for a non-duration service (would collide on optionKey)', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [
                { label: 'Standard', durationMinutes: null, rate: 50 },
                { label: 'Premium', durationMinutes: null, rate: 80 },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    // Nothing persisted: the seeded single boarding option is intact.
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; options: { rate: number }[] }[];
    };
    const boarding = cfg.services.find((s) => s.type === 'boarding')!;
    expect(boarding.options).toHaveLength(1);
    expect(boarding.options[0].rate).toBe(50);
  });

  it('saves a windowed option, deriving duration from the window and ignoring a bogus client duration', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Morning Walk',
                  durationMinutes: 999, // bogus — server must override from the window
                  rate: 25,
                  startTime: '11:00',
                  endTime: '14:00',
                  capacity: 4,
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const adminSettings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      services: {
        type: string;
        options: {
          optionKey: string;
          durationMinutes: number | null;
          startTime: string | null;
          endTime: string | null;
          capacity: number | null;
        }[];
      }[];
    };
    const adminWalk = adminSettings.services.find((s) => s.type === 'walk')!;
    expect(adminWalk.options).toHaveLength(1);
    expect(adminWalk.options[0]).toMatchObject({
      optionKey: 'morning-walk',
      durationMinutes: 180, // 11:00–14:00, not the bogus 999
      startTime: '11:00',
      endTime: '14:00',
      capacity: 4,
    });

    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: {
        type: string;
        options: {
          optionKey: string;
          startTime: string | null;
          endTime: string | null;
          capacity: number | null;
        }[];
      }[];
    };
    const cfgWalk = cfg.services.find((s) => s.type === 'walk')!;
    expect(cfgWalk.options[0]).toMatchObject({
      optionKey: 'morning-walk',
      startTime: '11:00',
      endTime: '14:00',
      capacity: 4,
    });
  });

  it('rejects a one-sided time window', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                { label: 'Morning Walk', durationMinutes: 60, rate: 25, startTime: '11:00' },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a window whose end is not after its start', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Morning Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '14:00',
                  endTime: '11:00',
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive capacity', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Morning Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '11:00',
                  endTime: '14:00',
                  capacity: 0,
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects two windowed options with the same label (OptionKey collision)', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Group Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '11:00',
                  endTime: '12:00',
                },
                {
                  label: 'Group Walk',
                  durationMinutes: 60,
                  rate: 30,
                  startTime: '15:00',
                  endTime: '16:00',
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a blank option label', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [{ label: '  ', durationMinutes: 30, rate: 20 }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('persists per-service questions and constraints, round-tripping through GET and the public config', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [
                { label: 'Is your dog crate-trained?', type: 'yesno', required: true },
                {
                  label: 'Feeding schedule',
                  type: 'select',
                  required: false,
                  options: ['am', 'pm'],
                },
              ],
              minNights: 2,
              maxNights: 14,
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      services: {
        type: string;
        shape: string;
        questions: { id: string; label: string; type: string }[];
        minNights: number | null;
        maxNights: number | null;
      }[];
    };
    const boarding = settings.services.find((s) => s.type === 'boarding')!;
    expect(boarding.shape).toBe('range');
    expect(boarding.questions).toHaveLength(2);
    expect(boarding.questions[0].label).toBe('Is your dog crate-trained?');
    expect(boarding.questions[0].id).toBeTruthy(); // server-assigned stable id
    expect(boarding.minNights).toBe(2);
    expect(boarding.maxNights).toBe(14);

    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; questions: { label: string }[]; minNights: number | null }[];
    };
    const publicBoarding = config.services.find((s) => s.type === 'boarding')!;
    expect(publicBoarding.questions).toHaveLength(2);
    expect(publicBoarding.minNights).toBe(2);
  });

  it('rejects malformed question definitions without persisting anything', async () => {
    const { env } = createTestEnv();

    const badType = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'Bad', type: 'essay', required: false }],
            },
          ],
        }),
      },
      env,
    );
    expect(badType.status).toBe(400);

    const badSelect = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'No options', type: 'select', required: false, options: [] }],
            },
          ],
        }),
      },
      env,
    );
    expect(badSelect.status).toBe(400);

    const badRange = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              minNights: 10,
              maxNights: 2,
            },
          ],
        }),
      },
      env,
    );
    expect(badRange.status).toBe(400);

    const badPattern = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'Bad pattern', type: 'text', required: false, pattern: '(' }],
            },
          ],
        }),
      },
      env,
    );
    expect(badPattern.status).toBe(400);

    const catastrophicPattern = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [
                { label: 'Nested quantifier', type: 'text', required: false, pattern: '(a+)+' },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(catastrophicPattern.status).toBe(400);

    const nonNumericMinMax = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [
                { label: 'Bad bound', type: 'number', required: false, min: 'not-a-number' },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(nonNumericMinMax.status).toBe(400);

    // Nothing above should have persisted — boarding rate is still the seeded 50.
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; options: { rate: number }[] }[];
    };
    expect(config.services.find((s) => s.type === 'boarding')?.options[0].rate).toBe(50);
  });

  it('preserves existing questions and constraints when a PUT omits them for a service (patch semantics)', async () => {
    const { env } = createTestEnv();
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'Is your dog crate-trained?', type: 'yesno', required: true }],
              minNights: 2,
              maxNights: 14,
            },
          ],
        }),
      },
      env,
    );

    // A caller PUTs the same service with ONLY `type`/`enabled` — questions/constraints omitted.
    const partial = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 55 }],
            },
          ],
        }),
      },
      env,
    );
    expect(partial.status).toBe(204);

    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      services: {
        type: string;
        questions: { label: string }[];
        minNights: number | null;
        maxNights: number | null;
        options: { rate: number }[];
      }[];
    };
    const boarding = settings.services.find((s) => s.type === 'boarding')!;
    // The rate change from the partial PUT took effect...
    expect(boarding.options[0].rate).toBe(55);
    // ...but questions/constraints, which the partial PUT never mentioned, survived untouched.
    expect(boarding.questions).toHaveLength(1);
    expect(boarding.questions[0].label).toBe('Is your dog crate-trained?');
    expect(boarding.minNights).toBe(2);
    expect(boarding.maxNights).toBe(14);
  });

  it('rejects a time window on a non-per-visit (range-shaped) service', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', rate: 50, startTime: '11:00', endTime: '14:00' }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("preserves a windowed option's OptionKey across a label rename, so existing bookings stay capacity-tracked", async () => {
    const { env } = createTestEnv();
    const create = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Morning Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '11:00',
                  endTime: '14:00',
                  capacity: 2,
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(create.status).toBe(204);

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
            startDate: '2028-11-01',
            petIds: ['pet_sp_bella'],
          }),
        },
        env,
      );
    };
    expect((await book()).status).toBe(201);
    expect((await book()).status).toBe(201);

    // Rename the option, sending back the optionKey the GET response gave us for it.
    const rename = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  optionKey: 'morning-walk',
                  label: 'AM Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '11:00',
                  endTime: '14:00',
                  capacity: 2,
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(rename.status).toBe(204);

    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; options: { optionKey: string; label: string }[] }[];
    };
    const walk = cfg.services.find((s) => s.type === 'walk')!;
    expect(walk.options[0]).toMatchObject({ optionKey: 'morning-walk', label: 'AM Walk' });

    // Capacity 2, already booked twice under 'morning-walk' — a third booking against that
    // same (preserved) key must still be rejected, proving the rename didn't orphan the count.
    const third = await book();
    expect(third.status).toBe(409);
  });
});

describe('configurable limits via admin settings (service-level, 0015)', () => {
  const boardingOpts = [{ label: 'Standard', durationMinutes: null, rate: 50 }];
  const houseOpts = [{ label: 'Standard', durationMinutes: null, rate: 70 }];
  const putSettings = async (env: Env, body: unknown) =>
    app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    );
  type SettingsCaps = {
    services: {
      type: string;
      capacityKind: 'boarding' | 'housesit' | 'none';
      maxConcurrentPets: number | null;
      maxNights: number | null;
    }[];
  };
  const getSettings = async (env: Env) =>
    (await (
      await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as SettingsCaps & Record<string, unknown>;

  it('PUT service caps round-trip through GET, which also exposes capacityKind (F5)', async () => {
    const { env } = createTestEnv();
    const res = await putSettings(env, {
      services: [
        { type: 'boarding', enabled: true, maxConcurrentPets: 5, options: boardingOpts },
        { type: 'housesitting', enabled: true, maxConcurrentPets: 2, options: houseOpts },
      ],
    });
    expect(res.status).toBe(204);
    const settings = await getSettings(env);
    const boarding = settings.services.find((s) => s.type === 'boarding')!;
    expect(boarding).toMatchObject({
      capacityKind: 'boarding',
      maxConcurrentPets: 5,
    });
    expect(settings.services.find((s) => s.type === 'housesitting')).toMatchObject({
      capacityKind: 'housesit',
      maxConcurrentPets: 2,
    });
    expect(settings.services.find((s) => s.type === 'walk')).toMatchObject({
      capacityKind: 'none',
      maxConcurrentPets: null,
    });
  });

  it('a cap on the wrong service kind is rejected, not silently ignored', async () => {
    const { env } = createTestEnv();
    const wrongPerDay = await putSettings(env, {
      services: [{ type: 'boarding', enabled: true, maxPerDay: 3, options: boardingOpts }],
    });
    expect(wrongPerDay.status).toBe(400);
    expect(((await wrongPerDay.json()) as { error: string }).error).toBe(
      "Boarding: that capacity doesn't apply to this service.",
    );
    const wrongConcurrent = await putSettings(env, {
      services: [
        {
          type: 'walk',
          enabled: true,
          maxConcurrentPets: 3,
          options: [{ label: '30 min', durationMinutes: 30, rate: 20 }],
        },
      ],
    });
    expect(wrongConcurrent.status).toBe(400);
  });

  it('PATCH semantics: an absent cap field keeps the current value; explicit null clears', async () => {
    const { env } = createTestEnv();
    await putSettings(env, {
      services: [{ type: 'boarding', enabled: true, maxConcurrentPets: 5, options: boardingOpts }],
    });
    // Absent -> keep 5.
    await putSettings(env, {
      services: [{ type: 'boarding', enabled: true, options: boardingOpts }],
    });
    let settings = await getSettings(env);
    expect(settings.services.find((s) => s.type === 'boarding')?.maxConcurrentPets).toBe(5);
    // Explicit null -> unlimited.
    await putSettings(env, {
      services: [
        { type: 'boarding', enabled: true, maxConcurrentPets: null, options: boardingOpts },
      ],
    });
    settings = await getSettings(env);
    expect(settings.services.find((s) => s.type === 'boarding')?.maxConcurrentPets).toBeNull();
  });

  it('accepts a boarding cap above the old ceiling of 50; rejects one over the 1000 rail', async () => {
    const { env } = createTestEnv();
    expect(
      (
        await putSettings(env, {
          services: [
            { type: 'boarding', enabled: true, maxConcurrentPets: 80, options: boardingOpts },
          ],
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await putSettings(env, {
          services: [
            { type: 'boarding', enabled: true, maxConcurrentPets: 2000, options: boardingOpts },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it('the removed tenant fields no longer round-trip: absent from GET, ignored on PUT', async () => {
    const { env } = createTestEnv();
    const settings = await getSettings(env);
    expect('maxBoardingPets' in settings).toBe(false);
    expect('maxHouseSitsPerDay' in settings).toBe(false);
    expect('maxStayNights' in settings).toBe(false);
    // Old clients may still send them — harmlessly ignored, never written.
    expect((await putSettings(env, { maxBoardingPets: 1 })).status).toBe(204);
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as Record<
      string,
      unknown
    >;
    expect('maxBoardingPets' in cfg).toBe(false);
    expect('maxStayNights' in cfg).toBe(false);
  });

  it('rejects an invalid timezone', async () => {
    const { env } = createTestEnv();
    const res = await putSettings(env, { timezone: 'Mars/Phobos' });
    expect(res.status).toBe(400);
  });
});

describe('settings — capacity in pets (MaxPerDay retired)', () => {
  it('PATCH maxConcurrentPets on a house-sit service persists and GET reflects it', async () => {
    const { env } = createTestEnv();
    const headers = {
      ...(await adminHeaders(TENANT_A)),
      'Content-Type': 'application/json',
    };
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          services: [
            {
              type: 'housesitting',
              enabled: true,
              maxConcurrentPets: 3,
              options: [{ label: 'Standard', rate: 70 }],
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
    const body = (await get.json()) as {
      services: { type: string; maxConcurrentPets: number | null }[];
    };
    const house = body.services.find((s) => s.type === 'housesitting')!;
    expect(house.maxConcurrentPets).toBe(3);
    // maxPerDay is gone from the API surface.
    expect('maxPerDay' in house).toBe(false);
  });

  it('PATCH rejects a maxPerDay value on any service', async () => {
    const { env } = createTestEnv();
    const headers = {
      ...(await adminHeaders(TENANT_A)),
      'Content-Type': 'application/json',
    };
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          services: [
            {
              type: 'housesitting',
              enabled: true,
              maxPerDay: 2,
              options: [{ label: 'Standard', rate: 70 }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "House sitting: that capacity doesn't apply to this service.",
    );
  });
});
