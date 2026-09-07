import { Hono } from 'hono';
import {
  deleteAccountPayment,
  getHouseholdBalances,
  getHouseholdDetail,
  insertAccountPayment,
  listPaymentsForAccount,
} from '../db/repo';
import { adminAuth } from '../lib/middleware';
import { isPaymentMethod, isRealDate } from '../lib/validation';
import { householdDetailToDollars } from '../lib/wire-dollars';
import { isValidCents } from '../../src/shared/index.js';
import type { AppEnv } from '../types';

export const accountsRoutes = new Hono<AppEnv>()
  .use('/:slug/admin/accounts/*', adminAuth)

  /**
   * THE DRILL-DOWN BEHIND ONE HOUSEHOLD BALANCE (Story 2.4, FR-7c) — every booking, its cost, its
   * extra charges, and every payment, so the sitter can settle a dispute or check a cancellation
   * fee without leaving the number she is questioning. Same 404-for-unowned-id answer as the
   * sibling payment routes: `getHouseholdDetail` returns null for an account id of another tenant
   * or no tenant at all, indistinguishably.
   */
  .get('/:slug/admin/accounts/:accountId', async (c) => {
    const tenant = c.get('tenant');
    const detail = await getHouseholdDetail(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      c.req.param('accountId'),
    );
    if (!detail) return c.json({ error: 'Not found.' }, 404);
    // The repo speaks cents (0015); this payload has always spoken whole dollars.
    return c.json(householdDetailToDollars(detail));
  })

  /**
   * RECORD ONE PAYMENT AGAINST A HOUSEHOLD (0011) — the way a client who pays weekly or monthly
   * actually pays. The body is the booking form's body minus the booking: the SAME three validators
   * in the same order (cents ≥ 1, a known method, a real date), because a household payment and a
   * booking payment are one ledger and a rule enforced on one of them only is a rule that moves
   * depending on where the sitter clicked.
   *
   * THE BODY IS CENTS (0015), named `amountCents` so no caller has to guess the unit — the same
   * body, validator and answer shape as the booking-level payment route.
   *
   * `:accountId` is an account id — a pet id — and the tenant guard is inside `insertAccountPayment`'s
   * SQL, so a household of another tenant is an indistinguishable 404, the same answer every other
   * money route gives a row it cannot see. **The response carries the recomputed household balance,
   * never a figure from the request**: the client sends what it collected from the sitter (amount,
   * method, date) and is TOLD what that means for the balance, which keeps the number on her screen
   * the number the server would print.
   */
  .post('/:slug/admin/accounts/:accountId/payments', async (c) => {
    const tenant = c.get('tenant');
    const accountId = c.req.param('accountId');
    const body = await c.req
      .json<{ amountCents?: unknown; method?: unknown; paidDate?: unknown; note?: unknown }>()
      .catch(() => ({}) as Record<string, never>);
    if (!isValidCents(body.amountCents))
      return c.json({ error: 'Amount must be a whole number of cents ≥ 1.' }, 400);
    if (!isPaymentMethod(body.method)) return c.json({ error: 'Unknown payment method.' }, 400);
    if (typeof body.paidDate !== 'string' || !isRealDate(body.paidDate))
      return c.json({ error: 'Invalid payment date.' }, 400);
    const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null;
    const paymentId = await insertAccountPayment(c.env.PAWSERVATION_DB, tenant.Id, {
      accountId,
      amount: body.amountCents,
      method: body.method,
      paidDate: body.paidDate,
      note,
      // Hand-recorded, not from the Venmo importer — see insertAccountPayment for the shared
      // dedupe index that field feeds when a value IS present.
      externalRef: null,
    });
    // Guard refused: no household of THIS tenant is named by that id.
    if (!paymentId) return c.json({ error: 'Not found.' }, 404);
    const payments = await listPaymentsForAccount(c.env.PAWSERVATION_DB, tenant.Id, accountId);
    const created = payments.find((p) => p.Id === paymentId);
    if (!created) return c.json({ error: 'Not found.' }, 404);
    const households = await getHouseholdBalances(c.env.PAWSERVATION_DB, tenant.Id);
    return c.json(
      {
        payment: {
          id: created.Id,
          amountCents: created.Amount,
          method: created.Method,
          paidDate: created.PaidDate,
          note: created.Note,
        },
        // The household this payment landed on, found by MEMBERSHIP rather than by id equality for
        // the reason the schema gives: the account id is the first-sorted pet and can be renamed by
        // a pet added later, so `:accountId` is not necessarily the household's current id.
        balanceCents: households.find((h) => h.petIds.includes(accountId))?.balance ?? 0,
      },
      201,
    );
  })

  .get('/:slug/admin/accounts/:accountId/payments', async (c) => {
    const tenant = c.get('tenant');
    const rows = await listPaymentsForAccount(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      c.req.param('accountId'),
    );
    return c.json({
      // The same `Payment` shape the booking-level ledger emits — one panel reads both, so the
      // two lists cannot speak different units (0015).
      payments: rows.map((p) => ({
        id: p.Id,
        amountCents: p.Amount,
        method: p.Method,
        paidDate: p.PaidDate,
        note: p.Note,
      })),
    });
  })

  /**
   * Deleting is the only correction this ledger has (there is no edit, here or on the booking form).
   * The account id is part of the identity for the same reason the booking id is on the sibling
   * route: a payment id paired with the wrong household 404s rather than silently deleting money.
   */
  .delete('/:slug/admin/accounts/:accountId/payments/:paymentId', async (c) => {
    const tenant = c.get('tenant');
    const deleted = await deleteAccountPayment(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      c.req.param('accountId'),
      c.req.param('paymentId'),
    );
    if (!deleted) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  });
