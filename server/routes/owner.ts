import { Hono } from 'hono';
import * as v from 'valibot';
import {
  addAllowedSitter,
  applyOwnerSwitches,
  deleteTenantCompletely,
  deleteUnclaimedAllowedSitter,
  getAllowedSitter,
  getAnalytics,
  getTenantById,
  listAllowedSitters,
  listSitterRoster,
} from '../db/repo';
import { isEmailConfigured, sendSitterInvite } from '../lib/email';
import {
  isCompActive,
  isDisabled,
  isPlanCurrent,
  isPremiumActive,
  normalizePremiumUntil,
} from '../lib/premium';
import { serializeAnalytics } from '../lib/analytics';
import { ownerAuth } from '../lib/middleware';
import { isOwnerEmail } from '../lib/owners';
import { INVITE_LINK_TTL_SECONDS, mintLink } from '../lib/signup-link';
import { invalidateTenantCache } from '../lib/tenant-resolve';
import { EMAIL_RE } from '../lib/validation';
import type { AppEnv } from '../types';
import { quarterSinceDate } from '../../src/shared/analytics/periods.js';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';

/**
 * Owner console: allowlist management. Non-slug-scoped ('owner' is in RESERVED_SLUGS) and
 * owner-token-gated. Adding an unclaimed email mints a 7-day setup link and emails it (see
 * `sendSitterInvite`); re-adding a claimed email sends nothing.
 */

const EmailBody = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(EMAIL_RE)),
});

const ALREADY_JOINED_ERROR = 'That sitter already has an account.';

export type SitterWindow = '30d' | '90d' | 'quarter' | 'ytd' | 'all';

/** Map a raw ?window value to its canonical key + sinceDate. Unknown/empty → 'all' (null). Pure. */
export function sinceDateForWindow(
  raw: string | undefined,
  today: string,
): { window: SitterWindow; sinceDate: string | null } {
  const [y, m] = today.split('-').map(Number);
  switch (raw) {
    case '30d':
      return { window: '30d', sinceDate: addDays(today, -30) };
    case '90d':
      return { window: '90d', sinceDate: addDays(today, -90) };
    case 'quarter':
      return { window: 'quarter', sinceDate: quarterSinceDate(y, m) };
    case 'ytd':
      return { window: 'ytd', sinceDate: `${y}-01-01` };
    default:
      return { window: 'all', sinceDate: null };
  }
}

export const ownerRoutes = new Hono<AppEnv>()
  // Path-scoped tightly: Hono flattens .use() patterns across every app mounted at /api.
  .use('/owner/*', ownerAuth)

  .get('/owner/allowlist', async (c) => {
    const rows = await listAllowedSitters(c.env.PAWSERVATION_DB);
    return c.json({
      entries: rows.map((r) => ({
        email: r.Email,
        addedAt: r.AddedAt,
        claimedAt: r.ClaimedAt,
        tenantSlug: r.TenantSlug,
        // Display-level tolerance: a claimed row can outlive its Tenant (no ON DELETE CASCADE;
        // D1 enforces the FK by default, so this is only reachable via manual `d1 execute` or a
        // migration run with deferred FKs) — flag it rather than let it read as unclaimed.
        orphaned: r.ClaimedAt != null && r.TenantSlug == null,
      })),
    });
  })

  .post('/owner/allowlist', async (c) => {
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(EmailBody, raw);
    if (!parsed.success) return c.json({ error: 'Enter a valid email.' }, 400);
    const { email } = parsed.output;
    // Keep the owner and sitter populations disjoint: an OWNER_EMAILS member always routes
    // to the owner console at login, so allowlisting one could only create a dead account.
    if (isOwnerEmail(c.env, email))
      return c.json({ error: 'That email is a platform owner and cannot join as a sitter.' }, 400);
    // Idempotent — re-adding returns the existing row (the customer-invite precedent).
    const row = await addAllowedSitter(c.env.PAWSERVATION_DB, email);
    const entry = {
      email: row.Email,
      addedAt: row.AddedAt,
      claimedAt: row.ClaimedAt,
      tenantSlug: null,
    };

    // A claimed row means the sitter already has an account — nothing to invite.
    if (row.ClaimedAt) return c.json({ entry, emailSent: false });

    const origin = new URL(c.req.url).origin;

    // Local-dev degrade (mirrors /signup/start's prototypeLink): with no provider configured in
    // development, hand the minted link back on-screen so demos work with a blanked RESEND_API_KEY.
    if (!isEmailConfigured(c.env)) {
      if (c.env.ENVIRONMENT === 'development') {
        const prototypeLink = await mintLink(
          c.env,
          origin,
          email,
          'sitter',
          INVITE_LINK_TTL_SECONDS,
        );
        return c.json({ entry, emailSent: false, prototypeLink });
      }
      // Unconfigured outside development: no link minted, no send — but the add still succeeds.
      // Unlike the public signup routes there is no fail-closed requirement here; the owner
      // console surfaces the failure.
      return c.json({ entry, emailSent: false });
    }

    // Owner-authenticated route: no enumeration-neutrality constraint and invites are rare, so
    // await the send and report the truth. A failure NEVER rolls back the row (the row is the
    // source of truth for who may join; the email is a courtesy notification).
    try {
      const link = await mintLink(c.env, origin, email, 'sitter', INVITE_LINK_TTL_SECONDS);
      await sendSitterInvite(c.env, email, link);
      return c.json({ entry, emailSent: true });
    } catch (err) {
      console.error('sitter invite send failed', err);
      return c.json({ entry, emailSent: false });
    }
  })

  .delete('/owner/allowlist/:email', async (c) => {
    const email = c.req.param('email').trim().toLowerCase();
    const row = await getAllowedSitter(c.env.PAWSERVATION_DB, email);
    if (!row) return c.json({ error: 'Not found.' }, 404);
    if (row.ClaimedAt) return c.json({ error: ALREADY_JOINED_ERROR }, 409);
    // Guarded delete (WHERE ClaimedAt IS NULL) closes the claim race: 0 rows ⇒ someone
    // completed setup between the read above and here.
    const deleted = await deleteUnclaimedAllowedSitter(c.env.PAWSERVATION_DB, email);
    if (!deleted) return c.json({ error: ALREADY_JOINED_ERROR }, 409);
    return c.body(null, 204);
  })

  // Cross-tenant roster (owner-only — listSitterRoster is the one sanctioned no-WHERE-TenantId
  // query). Owner requests have no tenant (owner routes bypass tenantMiddleware), so `today`
  // uses the instance default timezone rather than any one sitter's.
  .get('/owner/sitters', async (c) => {
    const today = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
    const { window, sinceDate } = sinceDateForWindow(c.req.query('window'), today);
    const rows = await listSitterRoster(c.env.PAWSERVATION_DB, sinceDate);
    const sitters = rows.map((r) => ({
      tenantId: r.TenantId,
      slug: r.Slug,
      displayName: r.DisplayName,
      createdAt: r.CreatedAt,
      disabled: isDisabled(r),
      // Published raw ('YYYY-MM-DD HH:MM:SS', UTC) rather than as a derived boolean, same
      // rationale as the detail route below: the owner is setting the date, so the date is what
      // they need to see.
      premiumUntil: r.PremiumUntil,
      // …and the DERIVED answer beside it, because since 0017 the date is only half the rule. The
      // console used to re-derive `PremiumUntil > now` in the browser, which would have reported
      // every paying Pro sitter as free the moment this column existed. One rule, one place
      // (`isPremiumActive`, server/lib/premium.ts).
      premiumActive: isPremiumActive(r),
      // FR-63's "an owner who can see why", and it costs four fields of this product's own
      // database: three verbatim columns and one derived boolean. Deliberately no amount, no
      // invoice, no processor identifier and no subscription id — those stay off this payload as
      // they already are, and FR-63's prohibition is on a revenue surface, not on this console
      // knowing which plan its own businesses are on.
      plan: r.Plan,
      billedUntil: r.BilledUntil,
      compedUntil: r.CompedUntil,
      // Whether that comp is LIVE, from the server: the chip lights on this and not on the date's
      // presence, because a comp that ran out is a date on the row and not a grant.
      compActive: isCompActive(r),
      // The DERIVED answer again, from the one expression. A console that compared a date here
      // would be the browser-side copy AD-13 removed, one rule later.
      planCurrent: isPlanCurrent(r),
      // THE CUSTOMER ID, verbatim, to the OWNER and on this console only: FR-63's "an owner who can
      // see why", with the seeing done on the processor's own page — the console links the row to
      // the Stripe Dashboard customer page, where the invoice, the card and the dunning state all
      // are. The owner has that dashboard already; the id is its key. Still no amount, no invoice
      // and no subscription id on this payload.
      stripeCustomerId: r.StripeCustomerId,
      clients: r.Clients,
      bookings: r.Bookings,
      // `Earned` is the raw column sum, in CENTS (0015), and the wire says so (design spec §2).
      // Nothing is divided here, so the TOTAL below is just the sum of these same integers.
      earnedCents: r.Earned,
    }));
    const totals = {
      sitters: sitters.length,
      clients: sitters.reduce((s, r) => s + r.clients, 0),
      bookings: sitters.reduce((s, r) => s + r.bookings, 0),
      earnedCents: sitters.reduce((s, r) => s + r.earnedCents, 0),
    };
    return c.json({ window, totals, sitters });
  })

  // Per-sitter drill-down: same payload shape as the sitter's own /admin/analytics (via the
  // shared serializeAnalytics), so the frontend can reuse the analytics view as-is.
  .get('/owner/sitters/:tenantId', async (c) => {
    const tenantId = c.req.param('tenantId');
    const tenant = await getTenantById(c.env.PAWSERVATION_DB, tenantId);
    if (!tenant) return c.json({ error: 'Not found.' }, 404);
    // Window is a roster control only — the detail always shows getAnalytics' own fixed
    // 12-month breakdown, anchored to the sitter's own timezone.
    const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
    const data = await getAnalytics(c.env.PAWSERVATION_DB, tenantId, today);
    // `premiumUntil` and `compedUntil` ride along beside `disabled` for the same reason it does:
    // the console's three owner switches each need to render their CURRENT value. This is one of
    // two reads that carry them — the other is the roster list above — so both surfaces stay in
    // sync with the tenant row. The DATES are published raw ('YYYY-MM-DD HH:MM:SS', UTC) because
    // the owner is setting them and a date is what she needs to see; whether one has PASSED is
    // never the console's comparison to make — it is `premiumActive` and `planCurrent` below, from
    // the one expression each (spine AD-13), because a browser-side `> now` reports a paying
    // business as free and the scanner walks `app/` for exactly that.
    return c.json({
      ...serializeAnalytics(data),
      disabled: isDisabled(tenant),
      premiumUntil: tenant.PremiumUntil,
      premiumActive: isPremiumActive(tenant),
      // The same four the roster publishes, because the drill-down and the list must not disagree
      // about who is on what.
      plan: tenant.Plan,
      billedUntil: tenant.BilledUntil,
      compedUntil: tenant.CompedUntil,
      compActive: isCompActive(tenant),
      planCurrent: isPlanCurrent(tenant),
    });
  })

  /**
   * The owner switches on a tenant: whether the account is switched off, how long the PAID tier is
   * comped through, and how long the BASIC plan is. One PATCH rather than three endpoints because
   * they are the same kind of thing — an owner-only edit of a column on the tenant row — and each
   * needs the same 404 and the same cache invalidation; a second endpoint would be a second place
   * to forget any of them.
   *
   * Every field is OPTIONAL and applied only when PRESENT, which is what keeps them independent:
   * `{ disabled: true }` must not silently revoke a subscription, and `{ premiumUntil: … }` must
   * not silently re-enable a disabled account. A body naming none of them is a 400 rather than a
   * do-nothing 200, because the only way to send one is by mistake.
   *
   * `premiumUntil: null` and `compedUntil: null` are meaningfully different from omitting them —
   * they are how a comp is CLEARED — so each field is `v.optional(v.nullable(…))` and the two cases
   * are distinguished by `in`, never by falsiness. The two comps are independent: one is the PAID
   * tier's grant and one is this product's own plan, and setting either must not silently revoke
   * the other.
   */
  .patch('/owner/sitters/:tenantId', async (c) => {
    const tenantId = c.req.param('tenantId');
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(
      v.object({
        disabled: v.optional(v.boolean()),
        premiumUntil: v.optional(v.nullable(v.string())),
        compedUntil: v.optional(v.nullable(v.string())),
      }),
      raw,
    );
    if (
      !parsed.success ||
      (!('disabled' in parsed.output) &&
        !('premiumUntil' in parsed.output) &&
        !('compedUntil' in parsed.output))
    )
      return c.json(
        {
          error:
            'Expected { disabled?: boolean, premiumUntil?: string | null, compedUntil?: string | null }.',
        },
        400,
      );
    const { disabled, premiumUntil, compedUntil } = parsed.output;

    // Normalise BEFORE the tenant lookup and before any write: an unparseable date must not leave
    // a half-applied PATCH behind, and this is the last point at which nothing has happened yet.
    // BOTH dates go through `normalizePremiumUntil` — no ceiling, past dates accepted ("paid
    // through last March" is a true statement) — and deliberately NOT through
    // `normalizeBilledUntil`, whose 400-day bound is the containment on what a leaked shared secret
    // can buy and would refuse a legitimate two-year comp.
    let storedUntil: string | null = null;
    if (premiumUntil != null) {
      storedUntil = normalizePremiumUntil(premiumUntil);
      if (storedUntil === null)
        return c.json({ error: 'premiumUntil must be a date, or null to clear it.' }, 400);
    }
    let storedComped: string | null = null;
    if (compedUntil != null) {
      storedComped = normalizePremiumUntil(compedUntil);
      if (storedComped === null)
        return c.json({ error: 'compedUntil must be a date, or null to clear it.' }, 400);
    }

    const tenant = await getTenantById(c.env.PAWSERVATION_DB, tenantId);
    if (!tenant) return c.json({ error: 'Not found.' }, 404);
    // ONE BATCH for whichever switches are present, then the cache drop — so a body naming two of
    // them cannot land one and not the other, and the widget never sees a half-applied row. A
    // batch that matched no row is a tenant deleted between the lookup above and here, and is
    // answered as the lookup would have answered it.
    const applied = await applyOwnerSwitches(c.env.PAWSERVATION_DB, tenantId, {
      ...(disabled !== undefined ? { disabled } : {}),
      ...('premiumUntil' in parsed.output ? { premiumUntil: storedUntil } : {}),
      ...('compedUntil' in parsed.output ? { compedUntil: storedComped } : {}),
    });
    if (!applied) return c.json({ error: 'Not found.' }, 404);
    await invalidateTenantCache(tenant.Slug, c.env); // widget/dashboard sees the change at once

    // Report the tenant's state as it now IS, read back rather than assembled from the request:
    // a PATCH that touched one field still answers for all of them, so the console never has to
    // guess what the fields it did not send are currently set to. A row that is gone by now is a
    // 404 too, not a 200 assembled from optionals over nothing.
    const after = await getTenantById(c.env.PAWSERVATION_DB, tenantId);
    if (!after) return c.json({ error: 'Not found.' }, 404);
    return c.json({
      disabled: isDisabled(after),
      premiumUntil: after.PremiumUntil,
      compedUntil: after.CompedUntil,
      // The same derived answers the roster and the detail read publish, from the same
      // expressions — the row is already loaded, so the alternative is the console re-deriving them
      // in the browser from the dates beside them, which is exactly what AD-13 removed and what
      // reports a paying business as free.
      premiumActive: isPremiumActive(after),
      compActive: isCompActive(after),
      planCurrent: isPlanCurrent(after),
    });
  })

  .delete('/owner/sitters/:tenantId', async (c) => {
    const tenantId = c.req.param('tenantId');
    const tenant = await getTenantById(c.env.PAWSERVATION_DB, tenantId);
    if (!tenant) return c.json({ error: 'Not found.' }, 404);
    await deleteTenantCompletely(c.env.PAWSERVATION_DB, tenantId);
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.body(null, 204);
  });
