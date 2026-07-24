import { describe, expect, it } from 'vitest';
import { getTenantBySlug } from '../db/repo';
import { createTestEnv } from './helpers';

describe('DisabledAt rides in the tenant object', () => {
  it('getTenantBySlug returns DisabledAt (null active, timestamp when set)', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      "INSERT INTO Tenants (Id, Slug, DisplayName, DisabledAt) VALUES ('t_dis','disco','Disco Dogs','2026-07-23 00:00:00');",
    );
    const disabled = await getTenantBySlug(env.PAWBOOK_DB, 'disco');
    expect(disabled?.DisabledAt).toBe('2026-07-23 00:00:00');

    const active = await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws'); // seeded, not disabled
    expect(active?.DisabledAt).toBeNull();
  });
});
