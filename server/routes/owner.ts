import { Hono } from 'hono';
import * as v from 'valibot';
import {
  addAllowedSitter,
  deleteUnclaimedAllowedSitter,
  getAllowedSitter,
  getAnalytics,
  getTenantById,
  listAllowedSitters,
  listSitterRoster,
} from '../db/repo';
import { isEmailConfigured, sendSitterInvite } from '../lib/email';
import { serializeAnalytics } from '../lib/analytics';
import { ownerAuth } from '../lib/middleware';
import { isOwnerEmail } from '../lib/owners';
import { INVITE_LINK_TTL_SECONDS, mintLink } from '../lib/signup-link';
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
    const rows = await listAllowedSitters(c.env.PAWBOOK_DB);
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
    const row = await addAllowedSitter(c.env.PAWBOOK_DB, email);
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
    const row = await getAllowedSitter(c.env.PAWBOOK_DB, email);
    if (!row) return c.json({ error: 'Not found.' }, 404);
    if (row.ClaimedAt) return c.json({ error: ALREADY_JOINED_ERROR }, 409);
    // Guarded delete (WHERE ClaimedAt IS NULL) closes the claim race: 0 rows ⇒ someone
    // completed setup between the read above and here.
    const deleted = await deleteUnclaimedAllowedSitter(c.env.PAWBOOK_DB, email);
    if (!deleted) return c.json({ error: ALREADY_JOINED_ERROR }, 409);
    return c.body(null, 204);
  })

  // Cross-tenant roster (owner-only — listSitterRoster is the one sanctioned no-WHERE-TenantId
  // query). Owner requests have no tenant (owner routes bypass tenantMiddleware), so `today`
  // uses the instance default timezone rather than any one sitter's.
  .get('/owner/sitters', async (c) => {
    const today = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
    const { window, sinceDate } = sinceDateForWindow(c.req.query('window'), today);
    const rows = await listSitterRoster(c.env.PAWBOOK_DB, sinceDate);
    const sitters = rows.map((r) => ({
      tenantId: r.TenantId,
      slug: r.Slug,
      displayName: r.DisplayName,
      createdAt: r.CreatedAt,
      clients: r.Clients,
      bookings: r.Bookings,
      earned: r.Earned,
    }));
    const totals = {
      sitters: sitters.length,
      clients: sitters.reduce((s, r) => s + r.clients, 0),
      bookings: sitters.reduce((s, r) => s + r.bookings, 0),
      earned: sitters.reduce((s, r) => s + r.earned, 0),
    };
    return c.json({ window, totals, sitters });
  })

  // Per-sitter drill-down: same payload shape as the sitter's own /admin/analytics (via the
  // shared serializeAnalytics), so the frontend can reuse the analytics view as-is.
  .get('/owner/sitters/:tenantId', async (c) => {
    const tenantId = c.req.param('tenantId');
    const tenant = await getTenantById(c.env.PAWBOOK_DB, tenantId);
    if (!tenant) return c.json({ error: 'Not found.' }, 404);
    // Window is a roster control only — the detail always shows getAnalytics' own fixed
    // 12-month breakdown, anchored to the sitter's own timezone.
    const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
    const data = await getAnalytics(c.env.PAWBOOK_DB, tenantId, today);
    return c.json(serializeAnalytics(data));
  });
