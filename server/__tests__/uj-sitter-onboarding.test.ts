import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, TEST_SECRET } from './helpers';
import { mintOwnerToken } from '../lib/token';

const NEW_EMAIL = 'newsitter-uj@pawservation.test';

/** UJ-3: owner allowlists an email, the sitter signs up, configures her business,
 *  creates and prices her first service, and it becomes visible to customers. */
describe('sitter onboarding flow', () => {
  it('allowlist -> signup -> configure -> create + price a service -> live in public config', async () => {
    const { env } = createTestEnv();

    const ownerHeaders = {
      Authorization: `Bearer ${await mintOwnerToken('owner@pawservation.test', TEST_SECRET)}`,
      'Content-Type': 'application/json',
    };
    const allow = await app.request(
      '/api/owner/allowlist',
      { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ email: NEW_EMAIL }) },
      env,
    );
    expect(allow.status).toBe(200);

    const start = await app.request(
      '/api/signup/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: NEW_EMAIL }),
      },
      env,
    );
    expect(start.status).toBe(200);
    const { prototypeLink } = (await start.json()) as { prototypeLink?: string };
    expect(prototypeLink).toBeTruthy();
    const signupToken = new URL(prototypeLink!).searchParams.get('t')!;

    const complete = await app.request(
      '/api/signup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: signupToken,
          password: 'RiverStone2026',
          businessName: 'Fresh Start Pet Care',
        }),
      },
      env,
    );
    expect(complete.status).toBe(200);
    const {
      token: adminBearer,
      role,
      slug,
    } = (await complete.json()) as { token: string; role: string; slug: string };
    expect(role).toBe('admin');

    const adminHeaders = { Authorization: `Bearer ${adminBearer}` };
    const adminJsonHeaders = { ...adminHeaders, 'Content-Type': 'application/json' };

    const settingsBefore = (await (
      await app.request(`/api/${slug}/admin/settings`, { headers: adminHeaders }, env)
    ).json()) as {
      displayName: string;
      maxAdvanceMonths: number | null;
      services: { type: string }[];
    };
    expect(settingsBefore.displayName).toBe('Fresh Start Pet Care');
    expect(settingsBefore.maxAdvanceMonths).toBe(12); // createTenantFromSignup's signup-time default
    expect(settingsBefore.services).toEqual([]);

    const createSvc = await app.request(
      `/api/${slug}/admin/services`,
      {
        method: 'POST',
        headers: adminJsonHeaders,
        body: JSON.stringify({ template: 'walk', label: 'Morning Walk' }),
      },
      env,
    );
    expect(createSvc.status).toBe(201);
    const { type } = (await createSvc.json()) as { type: string };
    expect(type).toBe('morning-walk');

    // Disabled + unpriced at create time -> not yet in the public config.
    const cfgBefore = (await (
      await app.request(`/api/${slug}/config`, {}, env)
    ).json()) as { services: { type: string }[] };
    expect(cfgBefore.services.some((s) => s.type === 'morning-walk')).toBe(false);

    const put = await app.request(
      `/api/${slug}/admin/settings`,
      {
        method: 'PUT',
        headers: adminJsonHeaders,
        body: JSON.stringify({
          maxAdvanceMonths: 6,
          services: [
            {
              type: 'morning-walk',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: 30, rate: 25 }],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const settingsAfter = (await (
      await app.request(`/api/${slug}/admin/settings`, { headers: adminHeaders }, env)
    ).json()) as {
      maxAdvanceMonths: number;
      services: {
        type: string;
        enabled: boolean;
        petRateMode: string;
        options: { rate: number }[];
      }[];
    };
    expect(settingsAfter.maxAdvanceMonths).toBe(6);
    const walk = settingsAfter.services.find((s) => s.type === 'morning-walk')!;
    expect(walk.enabled).toBe(true);
    expect(walk.petRateMode).toBe('linear'); // POST /admin/services stamps 'linear' at create time
    expect(walk.options[0].rate).toBe(25);

    const cfgAfter = (await (
      await app.request(`/api/${slug}/config`, {}, env)
    ).json()) as { services: { type: string }[] };
    expect(cfgAfter.services.some((s) => s.type === 'morning-walk')).toBe(true);
  });
});
