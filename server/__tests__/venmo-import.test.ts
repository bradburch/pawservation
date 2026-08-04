import { describe, expect, it } from 'vitest';
import { getAccountIdsByOwner, insertAccountPayment, insertInvitedCustomer } from '../db/repo';
import app from '../index';
import { adminHeaders, createTestEnv, seedPets, TENANT_A, TENANT_B } from './helpers';

const HEADER =
  ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (fee),' +
  'Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,' +
  'Terminal Location,Year to Date Venmo Fees,Disclaimer';

/** Same realistic shape as venmo-parse.test.ts. Jess Demo (Sunny Paws) owns pet_sp_bella and
 *  pet_sp_mochi — her household account id is 'pet_sp_bella' (lexicographically first). */
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

/**
 * Story 2.5 — VENMO IMPORT RECORDS AGAINST HOUSEHOLDS (supports FR-7a). A payment from a known
 * client is recorded against her household in ONE row (0011) — there is no booking to pick, so
 * there is nothing left for the sitter to get wrong by picking the wrong one. Idempotency is still
 * the partial unique index on `(TenantId, ExternalRef)`, now exercised through `insertAccountPayment`
 * as well as `insertPayment`.
 */
describe('getAccountIdsByOwner (repo)', () => {
  it('maps every owner to their household account id, with no activity filter', async () => {
    const { env, raw } = createTestEnv();
    const tenant = 'tnt_pawsandrelax';
    const jen = await insertInvitedCustomer(env.PAWBOOK_DB, tenant, 'jen@example.com', 'Jen');
    const [rex] = seedPets(raw, tenant, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    // Jen has a pet but NO bookings and NO payments yet — getHouseholdBalances would omit her
    // entirely, but her very first Venmo payment still needs somewhere to land.
    const map = await getAccountIdsByOwner(env.PAWBOOK_DB, tenant);
    expect(map.get(jen.Id)).toBe(rex);
  });

  it('omits an owner with no live pet — they belong to no household at all', async () => {
    const { env } = createTestEnv();
    const tenant = 'tnt_pawsandrelax';
    const ghost = await insertInvitedCustomer(env.PAWBOOK_DB, tenant, 'ghost@example.com', 'Ghost');
    const map = await getAccountIdsByOwner(env.PAWBOOK_DB, tenant);
    expect(map.has(ghost.Id)).toBe(false);
  });

  it('is tenant-isolated', async () => {
    const { env } = createTestEnv();
    const map = await getAccountIdsByOwner(env.PAWBOOK_DB, TENANT_B);
    expect(map.get('eu_sp_jess')).toBeUndefined(); // Sunny Paws' Jess, not Happy Tails'
    expect(map.get('eu_ht_jess')).toBe('pet_ht_otis');
  });
});

describe('insertAccountPayment (externalRef dedupe)', () => {
  it('carries an externalRef and shares the (TenantId, ExternalRef) unique index with insertPayment', async () => {
    const { env, raw } = createTestEnv();
    const tenant = 'tnt_pawsandrelax';
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, tenant, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, tenant, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const id = await insertAccountPayment(env.PAWBOOK_DB, tenant, {
      accountId: mia,
      amount: 200,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: null,
      externalRef: 'txn_1',
    });
    expect(id).not.toBeNull();
    expect(raw.prepare('SELECT ExternalRef FROM Payments WHERE Id = ?').get(id)).toMatchObject({
      ExternalRef: 'txn_1',
    });
    // A replay of the same transaction id THROWS (the caller catches it with isUniqueViolation),
    // exactly like insertPayment — idempotency is the index's job either way.
    await expect(
      insertAccountPayment(env.PAWBOOK_DB, tenant, {
        accountId: mia,
        amount: 200,
        method: 'venmo',
        paidDate: '2026-07-01',
        note: null,
        externalRef: 'txn_1',
      }),
    ).rejects.toThrow();
  });

  it('still accepts a hand-recorded payment with no externalRef at all', async () => {
    const { env, raw } = createTestEnv();
    const tenant = 'tnt_pawsandrelax';
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, tenant, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, tenant, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const id = await insertAccountPayment(env.PAWBOOK_DB, tenant, {
      accountId: mia,
      amount: 50,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    expect(id).not.toBeNull();
  });
});

describe('POST /:slug/admin/payments/venmo/preview', () => {
  it('previews a real export against the sitter’s own clients and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/venmo/preview', { csv: VENMO_CSV });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched: { txnId: string; accountId: string; amount: number; clientLabel: string }[];
      unmatched: { txnId: string; reason: string }[];
      ignored: number;
    };
    expect(body.matched).toHaveLength(1);
    expect(body.matched[0]).toMatchObject({
      txnId: '4139874112233445566',
      accountId: 'pet_sp_bella',
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
      matched: { accountId: string }[];
    };
    expect(body.matched.map((m) => m.accountId)).toEqual(['pet_sp_bella']);
  });

  it('scopes candidates to the tenant asking', async () => {
    const { env } = createTestEnv();
    // Happy Tails has its own 'Jess Demo' with a different pet, so the same file resolves to a
    // DIFFERENT household.
    const body = (await (
      await post(env, 'payments/venmo/preview', { csv: VENMO_CSV }, TENANT_B, 'happy-tails')
    ).json()) as { matched: { accountId: string }[] };
    expect(body.matched.map((m) => m.accountId)).toEqual(['pet_ht_otis']);
  });

  it('surfaces a client with no pets on file rather than guessing a household', async () => {
    const { env } = createTestEnv();
    const nameless = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'nopets@example.com',
      'No Pets',
    );
    const csv = VENMO_CSV.replace('Jess Demo,Sunny Paws', 'No Pets,Sunny Paws');
    const body = (await (await post(env, 'payments/venmo/preview', { csv })).json()) as {
      matched: unknown[];
      unmatched: { reason: string }[];
    };
    expect(body.matched).toEqual([]);
    expect(body.unmatched[0].reason).toMatch(/no pets on file/);
    expect(nameless.Id).toBeTruthy(); // sanity: the client really was created
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
  const choices = [{ txnId: '4139874112233445566', accountId: 'pet_sp_bella' }];

  it('records the confirmed rows against the household, with the amounts the SERVER read from the file', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 1, totalAmount: 250, skipped: [] });
    const row = raw
      .prepare(
        'SELECT BookingRequestId, AccountId, Amount, Method, PaidDate, Note, ExternalRef FROM Payments',
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      BookingRequestId: null,
      AccountId: 'pet_sp_bella',
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
    const { env, raw } = createTestEnv();
    const preInserted = await insertAccountPayment(env.PAWBOOK_DB, TENANT_A, {
      accountId: 'pet_sp_bella',
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

  it('refuses an account id that is not this transaction’s own resolved household', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/venmo/import', {
      csv: VENMO_CSV,
      // 'pet_ht_otis' belongs to another tenant's household entirely, not Jess Demo's on Sunny Paws.
      choices: [{ txnId: '4139874112233445566', accountId: 'pet_ht_otis' }],
    });
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [
        {
          txnId: '4139874112233445566',
          reason: 'That household is no longer a match for this payment',
        },
      ],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('skips a transaction that is not in the file it was sent with', async () => {
    const { env } = createTestEnv();
    const res = await post(env, 'payments/venmo/import', {
      csv: VENMO_CSV,
      choices: [{ txnId: 'not-in-this-file', accountId: 'pet_sp_bella' }],
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

  it('does not let one tenant import against another tenant’s household', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(
      env,
      'payments/venmo/import',
      { csv: VENMO_CSV, choices },
      TENANT_B,
      'happy-tails',
    );
    // `choices` names Sunny Paws' own household id ('pet_sp_bella'), which is not among Happy
    // Tails' resolved matches — refused entirely, not silently redirected to a Happy Tails household.
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [
        {
          txnId: '4139874112233445566',
          reason: 'That household is no longer a match for this payment',
        },
      ],
    });
    const rows = raw.prepare('SELECT TenantId, AccountId FROM Payments').all();
    expect(rows).toHaveLength(0);
  });

  it('refuses a blank-From transaction even when a nameless client sits on the empty match key', async () => {
    // Both a blank `From` and a client with no Name/VenmoUsername normalize to the SAME empty
    // key. `matchVenmoTxns` refuses an empty key before ever calling the resolver, so this can
    // never silently resolve onto this nameless client's household.
    const { env, raw } = createTestEnv();
    const nameless = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'nameless@example.com',
      null,
    );
    const [namelessPet] = seedPets(raw, TENANT_A, nameless.Id, [
      { id: 'p_nameless', petType: 'dog' },
    ]);
    const csv = VENMO_CSV.replace(
      'Boarding for Bella,Jess Demo,Sunny Paws',
      'Boarding for Bella,,Sunny Paws',
    );
    const res = await post(env, 'payments/venmo/import', {
      csv,
      choices: [{ txnId: '4139874112233445566', accountId: namelessPet }],
    });
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [
        {
          txnId: '4139874112233445566',
          reason: 'That household is no longer a match for this payment',
        },
      ],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('refuses to record a payment when two clients collide on one normalized Venmo key', async () => {
    // eu_sp_jess ("Jess Demo") and this new client both normalize to "jessdemo". A hand-built
    // last-writer-wins Map would silently resolve "Jess Demo" onto whichever client sorted last
    // and happily pay THEIR household instead of refusing outright.
    const { env, raw } = createTestEnv();
    const imposter = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'zzcollide@example.com',
      null,
    );
    const [imposterPet] = seedPets(raw, TENANT_A, imposter.Id, [
      { id: 'p_imposter', petType: 'dog' },
    ]);
    await app.request(
      `/api/sunny-paws/admin/customers/${imposter.Id}`,
      {
        method: 'PATCH',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ venmoUsername: 'Jess-Demo' }),
      },
      env,
    );
    const res = await post(env, 'payments/venmo/import', {
      csv: VENMO_CSV,
      choices: [{ txnId: '4139874112233445566', accountId: imposterPet }],
    });
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [
        {
          txnId: '4139874112233445566',
          reason: 'That household is no longer a match for this payment',
        },
      ],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });
});
