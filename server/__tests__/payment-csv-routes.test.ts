import { describe, expect, it } from 'vitest';
import { insertAccountPayment, insertInvitedCustomer } from '../db/repo';
import app from '../index';
import { adminHeaders, createTestEnv, seedPets, TENANT_A } from './helpers';

/**
 * A generic bank-style export, deliberately shaped nothing like Venmo's: no preamble, a
 * `Reference` column so `applyMapping` keys on it (`csv:<reference>`) instead of the content hash,
 * which makes the "already imported" fixture below deterministic to set up.
 *
 * Row 1: Jess Demo — the tenant's own seeded client (sql/seed.sql), same fixture venmo-import.test
 * uses, whose household account id is `pet_sp_bella` (lexicographically first of her two pets).
 * Row 2: a name that matches nobody.
 * Row 3: Jess Demo again, with a reference pre-recorded as already imported.
 */
const CSV = [
  'Date,Amount,Payer,Reference',
  '2026-07-01,45,Jess Demo,REF1',
  '2026-07-02,20,Nobody Here,REF2',
  '2026-07-03,30,Jess Demo,REF3',
].join('\n');

const MAPPING = { date: 0, amount: 1, payer: 2, reference: 3 };

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

describe('POST /:slug/admin/payments/csv/columns', () => {
  it('returns the headers and a sample of real rows', async () => {
    const { env } = createTestEnv();
    const res = await post(env, 'payments/csv/columns', { csv: CSV });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      headers: string[];
      sample: string[][];
      dataRowCount: number;
    };
    expect(body.headers).toEqual(['Date', 'Amount', 'Payer', 'Reference']);
    expect(body.sample[0]).toEqual(['2026-07-01', '45', 'Jess Demo', 'REF1']);
    expect(body.dataRowCount).toBe(3);
  });

  it('400s an empty file', async () => {
    const { env } = createTestEnv();
    const res = await post(env, 'payments/csv/columns', { csv: '' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/empty/);
  });

  it('requires an admin token', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/payments/csv/columns',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /:slug/admin/payments/csv/preview', () => {
  it('buckets a payer matching a seeded client into matched, and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/csv/preview', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched: { dedupeKey: string; accountId: string; amount: number; clientLabel: string }[];
      unmatched: { dedupeKey: string; reason: string }[];
      alreadyImported: { dedupeKey: string }[];
      problems: unknown[];
    };
    // Jess Demo appears on rows 1 and 3 (REF1, REF3) — both match, since neither is pre-imported
    // in this test.
    expect(body.matched).toHaveLength(2);
    expect(body.matched.find((m) => m.dedupeKey === 'csv:REF1')).toMatchObject({
      dedupeKey: 'csv:REF1',
      accountId: 'pet_sp_bella',
      amount: 45,
      clientLabel: 'Jess Demo',
    });
    // NOTHING is written by a preview.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('puts an unknown payer in unmatched with a reason', async () => {
    const { env } = createTestEnv();
    const res = await post(env, 'payments/csv/preview', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
    });
    const body = (await res.json()) as { unmatched: { dedupeKey: string; reason: string }[] };
    expect(body.unmatched).toHaveLength(1);
    expect(body.unmatched[0].dedupeKey).toBe('csv:REF2');
    expect(body.unmatched[0].reason).toMatch(/No client matches/);
  });

  it('puts a payment whose key is already imported into alreadyImported', async () => {
    const { env } = createTestEnv();
    const paymentId = await insertAccountPayment(env.PAWSERVATION_DB, TENANT_A, {
      accountId: 'pet_sp_bella',
      amount: 30,
      method: 'cash',
      paidDate: '2026-07-03',
      note: null,
      externalRef: 'csv:REF3',
    });
    expect(paymentId).not.toBeNull();

    const res = await post(env, 'payments/csv/preview', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
    });
    const body = (await res.json()) as {
      matched: { dedupeKey: string }[];
      alreadyImported: { dedupeKey: string }[];
    };
    expect(body.alreadyImported.map((r) => r.dedupeKey)).toEqual(['csv:REF3']);
    // The already-imported row must not also show up as matched.
    expect(body.matched.map((r) => r.dedupeKey)).not.toContain('csv:REF3');
  });

  it('400s a malformed mapping instead of guessing', async () => {
    const { env } = createTestEnv();
    const res = await post(env, 'payments/csv/preview', {
      csv: CSV,
      mapping: { date: 0, amount: -1, payer: 2 },
      defaultMethod: 'cash',
    });
    expect(res.status).toBe(400);
  });

  it('400s an invalid defaultMethod instead of guessing', async () => {
    const { env } = createTestEnv();
    const res = await post(env, 'payments/csv/preview', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'bitcoin',
    });
    expect(res.status).toBe(400);
  });

  it('400s an over-cap file, naming the count', async () => {
    const { env } = createTestEnv();
    const rows = Array.from({ length: 501 }, (_, i) => `2026-07-01,10,Jess Demo,REF${i}`);
    const csv = ['Date,Amount,Payer,Reference', ...rows].join('\n');
    const res = await post(env, 'payments/csv/preview', {
      csv,
      mapping: MAPPING,
      defaultMethod: 'cash',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/501/);
  });

  it('scopes candidates to the tenant asking', async () => {
    const { env } = createTestEnv();
    // Happy Tails has its own 'Jess Demo' with a different pet, so the same file resolves to a
    // DIFFERENT household.
    const res = await post(
      env,
      'payments/csv/preview',
      { csv: CSV, mapping: MAPPING, defaultMethod: 'cash' },
      'tnt_happytails',
      'happy-tails',
    );
    const body = (await res.json()) as { matched: { accountId: string }[] };
    expect(body.matched.every((m) => m.accountId === 'pet_ht_otis')).toBe(true);
    expect(body.matched.length).toBeGreaterThan(0);
  });

  it('requires an admin token', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/payments/csv/preview',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(401);
  });
});

/**
 * Story 2.5's mapped-CSV sibling of `payments/venmo/import`. Same security shape: the body carries
 * only WHICH row goes on which household — `applyMapping` and `matchCsvPayments` both run again
 * from the raw file, so an `accountId` is honoured only when the fresh match independently agrees.
 */
describe('POST /:slug/admin/payments/csv/import', () => {
  const choices = [{ dedupeKey: 'csv:REF1', accountId: 'pet_sp_bella' }];

  it('records a matched row against its household with the amount, method and date the SERVER read from the file', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/csv/import', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
      choices,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 1, totalAmount: 45, skipped: [] });
    const row = raw
      .prepare(
        'SELECT BookingRequestId, AccountId, Amount, Method, PaidDate, ExternalRef FROM Payments',
      )
      .get();
    expect(row).toMatchObject({
      BookingRequestId: null,
      AccountId: 'pet_sp_bella',
      Amount: 45,
      Method: 'cash',
      PaidDate: '2026-07-01',
      ExternalRef: 'csv:REF1',
    });
  });

  it('is idempotent: re-running the identical import records nothing the second time', async () => {
    const { env, raw } = createTestEnv();
    await post(env, 'payments/csv/import', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
      choices,
    });
    const again = await post(env, 'payments/csv/import', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
      choices,
    });
    expect(await again.json()).toMatchObject({
      imported: 0,
      skipped: [{ dedupeKey: 'csv:REF1', reason: 'Already imported' }],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 1 });
  });

  it('skips a row whose payer no longer resolves to the given accountId, and writes nothing for it', async () => {
    const { env, raw } = createTestEnv();
    const other = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'other@example.com',
      'Other Client',
    );
    const [otherPet] = seedPets(raw, TENANT_A, other.Id, [{ id: 'p_other', petType: 'dog' }]);
    const res = await post(env, 'payments/csv/import', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
      // Jess Demo's row (REF1) resolves to pet_sp_bella, NOT this other client's household.
      choices: [{ dedupeKey: 'csv:REF1', accountId: otherPet }],
    });
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [
        { dedupeKey: 'csv:REF1', reason: 'That household is no longer a match for this payment' },
      ],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('refuses an accountId belonging to another tenant', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/csv/import', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
      // 'pet_ht_otis' is Happy Tails' household, not Sunny Paws' Jess Demo.
      choices: [{ dedupeKey: 'csv:REF1', accountId: 'pet_ht_otis' }],
    });
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [
        { dedupeKey: 'csv:REF1', reason: 'That household is no longer a match for this payment' },
      ],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('skips a dedupeKey absent from the re-read file instead of inventing it', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, 'payments/csv/import', {
      csv: CSV,
      mapping: MAPPING,
      defaultMethod: 'cash',
      choices: [{ dedupeKey: 'csv:not-in-this-file', accountId: 'pet_sp_bella' }],
    });
    expect(await res.json()).toMatchObject({
      imported: 0,
      skipped: [{ dedupeKey: 'csv:not-in-this-file', reason: 'That payment is not in this file' }],
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('imports two identical unreferenced rows in one file — the duplicate-rank key at work', async () => {
    const { env, raw } = createTestEnv();
    // No Reference column mapped: applyMapping keys these on the content hash + duplicate-rank,
    // producing two DIFFERENT dedupeKeys for two otherwise-identical rows.
    const csv = ['Date,Amount,Payer', '2026-07-01,15,Jess Demo', '2026-07-01,15,Jess Demo'].join(
      '\n',
    );
    const mapping = { date: 0, amount: 1, payer: 2 };
    const preview = (await (
      await post(env, 'payments/csv/preview', { csv, mapping, defaultMethod: 'cash' })
    ).json()) as { matched: { dedupeKey: string; accountId: string }[] };
    expect(preview.matched).toHaveLength(2);
    const dupeChoices = preview.matched.map((m) => ({
      dedupeKey: m.dedupeKey,
      accountId: m.accountId,
    }));
    expect(new Set(dupeChoices.map((c) => c.dedupeKey)).size).toBe(2); // two DISTINCT keys

    const res = await post(env, 'payments/csv/import', {
      csv,
      mapping,
      defaultMethod: 'cash',
      choices: dupeChoices,
    });
    expect(await res.json()).toMatchObject({ imported: 2, totalAmount: 30, skipped: [] });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 2 });
  });

  it('400s a malformed choices array, writing nothing', async () => {
    const { env, raw } = createTestEnv();
    const base = { csv: CSV, mapping: MAPPING, defaultMethod: 'cash' };
    expect((await post(env, 'payments/csv/import', base)).status).toBe(400);
    expect((await post(env, 'payments/csv/import', { ...base, choices: [] })).status).toBe(400);
    expect(
      (await post(env, 'payments/csv/import', { ...base, choices: [{ dedupeKey: 5 }] })).status,
    ).toBe(400);
    expect(
      (
        await post(env, 'payments/csv/import', {
          ...base,
          choices: [{ dedupeKey: 'csv:REF1' }],
        })
      ).status,
    ).toBe(400);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toMatchObject({ n: 0 });
  });

  it('requires an admin token', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/payments/csv/import',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(401);
  });
});
