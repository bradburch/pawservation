import { describe, expect, it } from 'vitest';
import { getTenantById, getTenantBySlug, setTenantDisabled } from '../db/repo';
import { createTestEnv } from './helpers';

describe('DisabledAt rides in the tenant object', () => {
  it('getTenantBySlug returns DisabledAt (null active, timestamp when set)', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      "INSERT INTO Tenants (Id, Slug, DisplayName, DisabledAt) VALUES ('t_dis','disco','Disco Dogs','2026-07-23 00:00:00');",
    );
    const disabled = await getTenantBySlug(env.PAWSERVATION_DB, 'disco');
    expect(disabled?.DisabledAt).toBe('2026-07-23 00:00:00');

    const active = await getTenantBySlug(env.PAWSERVATION_DB, 'sunny-paws'); // seeded, not disabled
    expect(active?.DisabledAt).toBeNull();
  });
});

describe('setTenantDisabled', () => {
  it('sets and clears DisabledAt, reports whether a row changed', async () => {
    const { env, raw } = createTestEnv();
    raw.exec("INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t_x','xx','X');");

    expect(await setTenantDisabled(env.PAWSERVATION_DB, 't_x', true)).toBe(true);
    expect((await getTenantById(env.PAWSERVATION_DB, 't_x'))?.DisabledAt).not.toBeNull();

    expect(await setTenantDisabled(env.PAWSERVATION_DB, 't_x', false)).toBe(true);
    expect((await getTenantById(env.PAWSERVATION_DB, 't_x'))?.DisabledAt).toBeNull();

    expect(await setTenantDisabled(env.PAWSERVATION_DB, 'nope', true)).toBe(false); // no such tenant
  });
});
