import { describe, expect, it } from 'vitest';
import app from '../index';
import { ensureDemoCustomer } from '../db/repo';
import { DEMO_EMAIL, DEMO_PHONE } from '../lib/demo';
import { createTestEnv, demoToken, endUserToken, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

const countEndUsers = (raw: ReturnType<typeof createTestEnv>['raw']) =>
  (raw.prepare('SELECT COUNT(*) AS n FROM EndUsers').get() as { n: number }).n;

/**
 * Every path that creates a client requires a phone. The widget's sign-in is not one of them, and
 * this pins that it stays that way: /identify is invite-only and /verify only promotes, so a new
 * creation path added there would have to get past these two tests first.
 */
describe('the sign-in path creates no client', () => {
  it('identify refuses an unknown email and writes no row', async () => {
    const { env, raw } = createTestEnv();
    const before = countEndUsers(raw);
    const res = await app.request(
      `/api/${SLUG}/identify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'stranger@example.com' }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(countEndUsers(raw)).toBe(before);
  });

  it('a full identify → verify round trip for a known client inserts nothing', async () => {
    const { env, raw } = createTestEnv();
    const before = countEndUsers(raw);
    await endUserToken(env, SLUG, 'jess@example.com');
    expect(countEndUsers(raw)).toBe(before);
  });
});

/**
 * The demo login's shadow customer is provisioned on sign-in. It is not a client (it is excluded
 * from every client list), but it signs in to the same widget, so without a phone it would meet
 * the one-time phone prompt on the public demo page.
 */
describe('the demo shadow customer has a phone', () => {
  it('is provisioned with the fixed demo phone', async () => {
    const { env } = createTestEnv();
    const shadow = await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_A, DEMO_EMAIL, 'dog');
    expect(shadow.Phone).toBe(DEMO_PHONE);
  });

  it('backfills a shadow provisioned before the change, and no other row', async () => {
    const { env, raw } = createTestEnv();
    const shadow = await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_A, DEMO_EMAIL, 'dog');
    raw.prepare(`UPDATE EndUsers SET Phone = '  ' WHERE Id = ?`).run(shadow.Id);
    raw.prepare(`UPDATE EndUsers SET Phone = NULL WHERE Email = 'jess@example.com'`).run();

    await demoToken(env, SLUG); // the real sign-in path re-runs ensureDemoCustomer

    const phoneOf = (id: string) =>
      (raw.prepare('SELECT Phone FROM EndUsers WHERE Id = ?').get(id) as { Phone: string | null })
        .Phone;
    expect(phoneOf(shadow.Id)).toBe(DEMO_PHONE);
    expect(phoneOf('eu_sp_jess')).toBeNull(); // a real client is never touched by this
  });
});
