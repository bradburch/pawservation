import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, TENANT_A, TENANT_B } from './helpers';

const HEADER =
  ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (fee),' +
  'Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,' +
  'Terminal Location,Year to Date Venmo Fees,Disclaimer';

/** Same realistic shape as venmo-parse.test.ts, sized to the seeded data (Jess owes $250). */
export const VENMO_CSV = [
  'Account Statement - (@Sunny-Paws) - July 1st to August 1st 2026 ,,,,,,,,,,,,,,,,,,',
  'Account Activity,,,,,,,,,,,,,,,,,,',
  HEADER,
  ',,,,,,,,,,,,,$0.00,,,,,',
  ',4139874112233445566,2026-07-03T14:22:11,Payment,Complete,Boarding for Bella,Jess Demo,Sunny Paws,+ $250.00,,,,Venmo balance,,,,Venmo,,',
  ',4139874112233445567,2026-07-05T09:01:44,Charge,Complete,walks,Tina Alvarez,Sunny Paws,+ $40.00,,,,Venmo balance,,,,Venmo,,',
  ',4139874112233445568,2026-07-06T18:30:02,Standard Transfer,Issued,,,,- $250.00,,,,ALLY BANK *9391,,,,Venmo,,',
  ',,,,,,,,,,,,,,$40.00,$0.00,,$0.00,',
  '',
].join('\n');

const post = async (
  env: Env,
  path: string,
  body: unknown,
  tenant = TENANT_A,
  slug = 'sunny-paws',
) =>
  app.request(
    `/api/${slug}/admin/${path}`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(tenant)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

describe('POST /:slug/admin/payments/venmo/preview', () => {
  it('previews a real export against the sitter’s own receivables and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/venmo/preview', { csv: VENMO_CSV });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched: { txnId: string; bookingId: string; amount: number; clientLabel: string }[];
      unmatched: { txnId: string; reason: string }[];
      ignored: number;
    };
    expect(body.matched).toHaveLength(1);
    expect(body.matched[0]).toMatchObject({
      txnId: '4139874112233445566',
      bookingId: 'seed_sp_board1',
      amount: 250,
      clientLabel: 'Jess Demo',
    });
    expect(body.unmatched.map((u) => u.txnId)).toEqual(['4139874112233445567']);
    expect(body.ignored).toBe(1);
    // NOTHING is written by a preview.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('matches a client whose Venmo handle is nothing like their name', async () => {
    const { env } = createTestEnv();
    await app.request(
      '/api/sunny-paws/admin/customers/eu_sp_jess',
      {
        method: 'PATCH',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ venmoUsername: 'sunny-jess-99' }),
      },
      env,
    );
    const csv = VENMO_CSV.replace('Jess Demo,Sunny Paws', '@Sunny-Jess-99,Sunny Paws');
    const body = (await (await post(env, 'payments/venmo/preview', { csv })).json()) as {
      matched: { bookingId: string }[];
    };
    expect(body.matched.map((m) => m.bookingId)).toEqual(['seed_sp_board1']);
  });

  it('scopes candidates to the tenant asking', async () => {
    const { env } = createTestEnv();
    // Happy Tails has its own 'Jess Demo' owing $400, so the same file matches a DIFFERENT booking.
    const body = (await (
      await post(env, 'payments/venmo/preview', { csv: VENMO_CSV }, TENANT_B, 'happy-tails')
    ).json()) as { matched: { bookingId: string }[] };
    expect(body.matched.map((m) => m.bookingId)).toEqual(['seed_ht_board1']);
  });

  it('400s a file that is not a Venmo export', async () => {
    const { env } = createTestEnv();
    const res = await post(env, 'payments/venmo/preview', { csv: 'a,b\n1,2\n' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Venmo/);
  });

  it('requires an admin token', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/payments/venmo/preview',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(401);
  });
});
