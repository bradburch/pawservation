import { describe, expect, it } from 'vitest';
import { insertInvitedCustomer, insertPayment } from '../db/repo';
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

  it('skips gracefully, not 500s, when the ExternalRef was already written outside the CSV round-trip', async () => {
    // A row with this txn's ExternalRef already exists (written directly via the repo, not by a
    // prior confirm-import call) — proves the unique-index replay path degrades to a skip rather
    // than an unhandled throw, whichever branch of the route actually catches it.
    const { env, raw } = createTestEnv();
    const preInserted = await insertPayment(env.PAWBOOK_DB, TENANT_A, {
      bookingRequestId: 'seed_sp_board1',
      amount: 250,
      method: 'venmo',
      paidDate: '2026-07-03',
      note: 'pre-existing',
      externalRef: '4139874112233445566',
    });
    expect(preInserted).not.toBeNull();
    const res = await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
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
    const res = await post(
      env,
      'payments/venmo/import',
      { csv: VENMO_CSV, choices },
      TENANT_B,
      'happy-tails',
    );
    // `choices` names Sunny Paws' own booking id ('seed_sp_board1'), which is not among Happy
    // Tails' candidates — refused entirely, not silently redirected to a Happy Tails booking.
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [
        {
          txnId: '4139874112233445566',
          reason: 'That booking is no longer a match for this payment',
        },
      ],
    });
    // An explicit count, not a for-loop over possibly-zero rows, so this can't pass vacuously.
    const rows = raw.prepare('SELECT TenantId, BookingRequestId FROM Payments').all();
    expect(rows).toHaveLength(0);
  });

  it('refuses a blank-From transaction even when a nameless client sits on the empty match key', async () => {
    // Both a blank `From` and a client with no Name/VenmoUsername normalize to the SAME empty
    // key. The hand-built Map this route used to build had no empty-key guard, so it would
    // silently resolve the blank transaction onto this nameless client's own receivable.
    const { env, raw } = createTestEnv();
    const nameless = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'nameless@example.com',
      null,
    );
    raw.exec(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, EstCost, Status)
       VALUES ('bk_nameless', '${TENANT_A}', '${nameless.Id}', 'boarding', '2028-06-20', 1, 250, 'confirmed')`,
    );
    const csv = VENMO_CSV.replace(
      'Boarding for Bella,Jess Demo,Sunny Paws',
      'Boarding for Bella,,Sunny Paws',
    );
    const res = await post(env, 'payments/venmo/import', {
      csv,
      choices: [{ txnId: '4139874112233445566', bookingId: 'bk_nameless' }],
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

  it('refuses to record a payment when two clients collide on one normalized Venmo key', async () => {
    // eu_sp_jess ("Jess Demo") and this new client both normalize to "jessdemo". A hand-built
    // last-writer-wins Map would silently resolve "Jess Demo" onto whichever client sorted last
    // (by Email, per listCustomers) and happily pay THEIR booking instead of refusing outright.
    const { env, raw } = createTestEnv();
    const imposter = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'zzcollide@example.com',
      null,
    );
    await app.request(
      `/api/sunny-paws/admin/customers/${imposter.Id}`,
      {
        method: 'PATCH',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ venmoUsername: 'Jess-Demo' }),
      },
      env,
    );
    raw.exec(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, EstCost, Status)
       VALUES ('bk_imposter', '${TENANT_A}', '${imposter.Id}', 'boarding', '2028-06-20', 1, 250, 'confirmed')`,
    );
    const res = await post(env, 'payments/venmo/import', {
      csv: VENMO_CSV,
      choices: [{ txnId: '4139874112233445566', bookingId: 'bk_imposter' }],
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
});
