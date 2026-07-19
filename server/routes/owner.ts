import { Hono } from 'hono';
import * as v from 'valibot';
import {
  addAllowedSitter,
  deleteUnclaimedAllowedSitter,
  getAllowedSitter,
  listAllowedSitters,
} from '../db/repo';
import { ownerAuth } from '../lib/middleware';
import { isOwnerEmail } from '../lib/owners';
import { EMAIL_RE } from '../lib/validation';
import type { AppEnv } from '../types';

/**
 * Owner console: allowlist management. Non-slug-scoped ('owner' is in RESERVED_SLUGS) and
 * owner-token-gated. No email is sent on add — the sitter initiates from the login page.
 */

const EmailBody = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(EMAIL_RE)),
});

const ALREADY_JOINED_ERROR = 'That sitter already has an account.';

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
        // Display-level tolerance: a claimed row can outlive its Tenant (no ON DELETE CASCADE,
        // and D1 doesn't enforce the FK either) — flag it rather than let it read as unclaimed.
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
    return c.json({
      entry: { email: row.Email, addedAt: row.AddedAt, claimedAt: row.ClaimedAt, tenantSlug: null },
    });
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
  });
