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

describe('POST /:slug/admin/payments/venmo/import', () => {
  const choices = [{ txnId: '4139874112233445566', bookingId: 'seed_sp_board1' }];

  it('records the confirmed rows with the amounts the SERVER read from the file', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 1, totalAmount: 250, skipped: [] });
    const row = raw
      .prepare('SELECT Amount, Method, PaidDate, Note, ExternalRef FROM Payments')
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      Amount: 250,
      Method: 'venmo',
      PaidDate: '2026-07-03',
      ExternalRef: '4139874112233445566',
    });
    expect(String(row.Note)).toContain('Boarding for Bella');
  });

  it('is idempotent: re-uploading the same file records nothing twice', async () => {
    const { env, raw } = createTestEnv();
    await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices });
    // Second pass: the preview now reports it as already imported…
    const preview = (await (
      await post(env, 'payments/venmo/preview', { csv: VENMO_CSV })
    ).json()) as { matched: unknown[]; alreadyImported: { txnId: string }[] };
    expect(preview.matched).toEqual([]);
    expect(preview.alreadyImported.map((r) => r.txnId)).toEqual(['4139874112233445566']);
    // …and a replayed confirm is refused by the unique index, not by a note substring.
    const again = await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices });
    expect(await again.json()).toMatchObject({
      imported: 0,
      skipped: [{ txnId: '4139874112233445566', reason: 'Already imported' }],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 1 });
  });

  it('ignores a dollar figure in the body — money comes from the file, never the client', async () => {
    const { env, raw } = createTestEnv();
    await post(env, 'payments/venmo/import', {
      csv: VENMO_CSV,
      choices: [{ ...choices[0], amount: 999999, paidDate: '1999-01-01', method: 'cash' }],
    });
    expect(raw.prepare('SELECT Amount, Method, PaidDate FROM Payments').get()).toMatchObject({
      Amount: 250,
      Method: 'venmo',
      PaidDate: '2026-07-03',
    });
  });

  it('refuses a booking that is not one of that transaction’s candidates', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/venmo/import', {
      csv: VENMO_CSV,
      // seed_ht_board1 belongs to another tenant entirely; seed_sp_pend1 is pending, not owing.
      choices: [{ txnId: '4139874112233445566', bookingId: 'seed_ht_board1' }],
    });
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [
        {
          txnId: '4139874112233445566',
          reason: 'That booking is no longer a match for this payment',
        },
      ],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('skips a transaction that is not in the file it was sent with', async () => {
    const { env } = createTestEnv();
    const res = await post(env, 'payments/venmo/import', {
      csv: VENMO_CSV,
      choices: [{ txnId: 'not-in-this-file', bookingId: 'seed_sp_board1' }],
    });
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [{ txnId: 'not-in-this-file', reason: 'That transaction is not in this file' }],
    });
  });

  it('400s a malformed choices list', async () => {
    const { env } = createTestEnv();
    expect((await post(env, 'payments/venmo/import', { csv: VENMO_CSV })).status).toBe(400);
    expect(
      (await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices: [{ txnId: 5 }] }))
        .status,
    ).toBe(400);
  });

  it('does not let one tenant import against another tenant’s booking', async () => {
    const { env, raw } = createTestEnv();
    await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices }, TENANT_B, 'happy-tails');
    // Happy Tails' own Jess owes $400, so the payment lands on THEIR booking or not at all.
    const rows = raw.prepare('SELECT TenantId, BookingRequestId FROM Payments').all();
    for (const r of rows as { TenantId: string; BookingRequestId: string }[]) {
      expect(r.TenantId).toBe(TENANT_B);
      expect(r.BookingRequestId).not.toBe('seed_sp_board1');
    }
  });
});
