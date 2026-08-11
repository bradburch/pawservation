import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  addBookingPets,
  applyAttribution,
  getHouseholdDetail,
  insertBookingRequest,
  insertInvitedCustomer,
} from '../db/repo';
import {
  deriveAttributedRef,
  expandImportedRefs,
  recoverSourceRef,
} from '../lib/payment-attribution';
import app from '../index';
import { adminHeaders, createTestEnv, seedPets } from './helpers';

/**
 * THE IDEMPOTENCY KEY MUST SURVIVE ATTRIBUTION. Both importers dedupe by exact set membership on
 * the refs this tenant already holds (`loadPaymentMatchInputs`, server/routes/admin.ts), and the
 * partial unique index on `(TenantId, ExternalRef)` backs that up on the way in. Attribution
 * DELETES the imported account-level row and writes derived ones in its place, so if the source's
 * own ref were not recoverable from what it left behind, the key would be free again: a re-upload
 * of the very same export — the CSV importer's documented expected case, overlapping monthly
 * exports — would record every attributed payment a SECOND time as a brand-new household credit,
 * and the sitter's only recovery would be deleting payments one at a time.
 *
 * This is the spec's mandated test ("a re-import of the source file after attribution creates
 * nothing", docs/superpowers/specs/2026-08-10-payment-attribution-design.md) driven end to end
 * through the real routes, for BOTH importers, since both share that one `alreadyImported` set.
 */

// paws-and-relax: seeded customers, no bookings — a genuinely clean slate to import into.
const TENANT_C = 'tnt_pawsandrelax';
const SLUG_C = 'paws-and-relax';

const PAYER = 'Jen Ross';
const TXN_ID = '9911223344556677';

const VENMO_HEADER =
  ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (fee),' +
  'Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,' +
  'Terminal Location,Year to Date Venmo Fees,Disclaimer';

const VENMO_CSV = [
  'Account Statement - (@Paws-And-Relax) - March 1st to April 1st 2026 ,,,,,,,,,,,,,,,,,,',
  'Account Activity,,,,,,,,,,,,,,,,,,',
  VENMO_HEADER,
  `,${TXN_ID},2026-03-05T14:22:11,Payment,Complete,March boarding,${PAYER},Paws And Relax,+ $200.00,,,,Venmo balance,,,,Venmo,,`,
  '',
].join('\n');

/** The bank export the sitter uploads in March, and the six-month one they upload in July: the
 *  March row appears in BOTH, unchanged, which is exactly what `applyMapping`'s rank-stable key is
 *  for. No Reference column, so the key is the `csv:<hash>:<rank>` form — the one whose shape a
 *  numeric suffix could not be told apart from. */
const CSV_MARCH = ['Date,Amount,Payer', `2026-03-05,200,${PAYER}`].join('\n');
const CSV_JAN_JUN = ['Date,Amount,Payer', `2026-03-05,200,${PAYER}`, `2026-05-02,75,${PAYER}`].join(
  '\n',
);
const CSV_MAPPING = { date: 0, amount: 1, payer: 2 };

const post = async (env: Env, path: string, body: unknown) =>
  app.request(
    `/api/${SLUG_C}/admin/${path}`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_C)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

type Household = { ownerId: string; accountId: string; petIds: string[] };

async function household(env: Env, raw: DatabaseSync): Promise<Household> {
  const owner = await insertInvitedCustomer(
    env.PAWSERVATION_DB,
    TENANT_C,
    'jen@example.com',
    PAYER,
  );
  const petIds = seedPets(raw, TENANT_C, owner.Id, [{ id: 'p_jen', petType: 'dog' }]);
  return { ownerId: owner.Id, accountId: petIds[0], petIds };
}

async function book(env: Env, home: Household, estCost: number): Promise<string> {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_C, {
    endUserId: home.ownerId,
    serviceType: 'boarding',
    startDate: '2026-03-04',
    endDate: '2026-03-06',
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status: 'confirmed',
  });
  await addBookingPets(env.PAWSERVATION_DB, TENANT_C, id, home.petIds);
  return id;
}

function ledger(raw: DatabaseSync) {
  return raw
    .prepare(
      'SELECT COUNT(*) AS rows, COALESCE(SUM(Amount), 0) AS total FROM Payments WHERE TenantId = ?',
    )
    .get(TENANT_C) as { rows: number; total: number };
}

/** The single account-level credit this tenant now holds, as the attribution routes see it. */
function soleCredit(raw: DatabaseSync): { Id: string; Amount: number } {
  return raw
    .prepare('SELECT Id, Amount FROM Payments WHERE TenantId = ? AND AccountId IS NOT NULL')
    .get(TENANT_C) as { Id: string; Amount: number };
}

describe('derived ExternalRef ↔ source ref', () => {
  it('carries the original verbatim behind a marker, and recovers it exactly', () => {
    for (const original of ['4139874112233445566', 'csv:abc123:0', 'csv:INV:2026:03', 'bp_pay_9']) {
      for (const segment of ['1', '2', '17', 'r']) {
        const derived = deriveAttributedRef(original, segment)!;
        expect(derived).toBe(`attr:${segment}:${original}`);
        expect(recoverSourceRef(derived)).toBe(original);
      }
    }
  });

  it('derives nothing from a payment with no ref', () => {
    expect(deriveAttributedRef(null, '1')).toBeNull();
    expect(deriveAttributedRef(null, 'r')).toBeNull();
  });

  it('recovers through a re-attributed remainder, however deeply nested', () => {
    const once = deriveAttributedRef('csv:abc123:0', 'r')!;
    const twice = deriveAttributedRef(once, '1')!;
    expect(recoverSourceRef(twice)).toBe('csv:abc123:0');
  });

  it('reads no natural importer key as derived — that would free a live key', () => {
    // A CSV key carries colons and a trailing numeric segment of its own; a Venmo id cannot
    // contain a colon at all (TXN_ID_RE). Neither may ever be unwrapped into something shorter.
    for (const natural of [
      'csv:abc123:3',
      'csv:REF1',
      'csv:attr:1:looks-derived', // a sitter's own reference cell, still namespaced csv:
      '4139874112233445566',
      'attr',
      'attr:',
      'attr:x:nope', // marker present, but no split index or remainder marker
      'attribution:1:nope',
    ]) {
      expect(recoverSourceRef(natural)).toBeNull();
    }
  });

  it('expands a tenant’s live refs to include every recovered original', () => {
    const set = expandImportedRefs(['attr:1:txn_9', 'attr:r:txn_9', 'csv:REF1']);
    expect(set.has('txn_9')).toBe(true);
    expect(set.has('attr:1:txn_9')).toBe(true);
    expect(set.has('csv:REF1')).toBe(true);
  });
});

describe('re-import of the source file after attribution', () => {
  it('creates nothing through the VENMO importer', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw);
    const stay = await book(env, home, 150);
    const choices = [{ txnId: TXN_ID, accountId: home.accountId }];

    expect(await (await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices })).json()) //
      .toEqual({ imported: 1, totalAmount: 200, skipped: [] });

    // The sitter then places that credit: $150 onto the stay, $50 left as household credit.
    const credit = soleCredit(raw);
    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId: credit.Id,
        accountId: home.accountId,
        splits: [{ bookingId: stay, amount: 150 }],
        remainder: 50,
      }),
    ).toEqual({ ok: true });
    const before = ledger(raw);
    expect(before).toMatchObject({ rows: 2, total: 200 });

    // Same export, uploaded again — the preview must still call it already imported…
    const preview = (await (
      await post(env, 'payments/venmo/preview', { csv: VENMO_CSV })
    ).json()) as { matched: unknown[]; alreadyImported: { txnId: string }[] };
    expect(preview.matched).toEqual([]);
    expect(preview.alreadyImported.map((r) => r.txnId)).toEqual([TXN_ID]);

    // …and a confirm replayed past the preview must record nothing at all.
    expect(await (await post(env, 'payments/venmo/import', { csv: VENMO_CSV, choices })).json()) //
      .toMatchObject({ imported: 0, skipped: [{ txnId: TXN_ID, reason: 'Already imported' }] });

    expect(ledger(raw)).toEqual(before);
    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    expect(detail?.bookings.find((b) => b.bookingId === stay)?.paidTotal).toBe(150);
  });

  it('creates nothing through the CSV importer, on an overlapping later export', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw);
    const stay = await book(env, home, 150);

    const previewCsv = async (csv: string) =>
      (await (
        await post(env, 'payments/csv/preview', {
          csv,
          mapping: CSV_MAPPING,
          defaultMethod: 'venmo',
        })
      ).json()) as {
        matched: { dedupeKey: string; amount: number; accountId: string | null }[];
        alreadyImported: { dedupeKey: string }[];
      };

    const march = await previewCsv(CSV_MARCH);
    const marchKey = march.matched[0].dedupeKey;
    expect(
      await (
        await post(env, 'payments/csv/import', {
          csv: CSV_MARCH,
          mapping: CSV_MAPPING,
          defaultMethod: 'venmo',
          choices: [{ dedupeKey: marchKey, accountId: home.accountId }],
        })
      ).json(),
    ).toEqual({ imported: 1, totalAmount: 200, skipped: [] });

    const credit = soleCredit(raw);
    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId: credit.Id,
        accountId: home.accountId,
        splits: [{ bookingId: stay, amount: 150 }],
        remainder: 50,
      }),
    ).toEqual({ ok: true });
    const before = ledger(raw);
    expect(before).toMatchObject({ rows: 2, total: 200 });

    // July: the six-month export, which contains March's row unchanged plus one genuinely new one.
    const wide = await previewCsv(CSV_JAN_JUN);
    expect(wide.alreadyImported.map((r) => r.dedupeKey)).toEqual([marchKey]);
    const fresh = wide.matched.map((m) => m.dedupeKey);
    expect(fresh).not.toContain(marchKey);

    // Even asked to record BOTH — the March key replayed past the preview — only the new one lands.
    expect(
      await (
        await post(env, 'payments/csv/import', {
          csv: CSV_JAN_JUN,
          mapping: CSV_MAPPING,
          defaultMethod: 'venmo',
          choices: [marchKey, ...fresh].map((dedupeKey) => ({
            dedupeKey,
            accountId: home.accountId,
          })),
        })
      ).json(),
    ).toMatchObject({
      imported: 1,
      totalAmount: 75,
      skipped: [{ dedupeKey: marchKey, reason: 'Already imported' }],
    });

    // The household gained exactly the $75 that is genuinely new, and not one cent of March again.
    expect(ledger(raw)).toEqual({ rows: before.rows + 1, total: before.total + 75 });
  });
});
