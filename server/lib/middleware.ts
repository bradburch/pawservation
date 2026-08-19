import { createMiddleware } from 'hono/factory';
import { findLivePersonalAccessToken, touchPersonalAccessToken } from '../db/repo';
import {
  hashPersonalAccessToken,
  looksLikePersonalAccessToken,
  shouldRefreshLastUsed,
} from './personal-access-token';
import { securityEvent } from './log';
import { resolveTenant } from './tenant-resolve';
import { extractBearer, verifyAdminToken, verifyOwnerToken, verifyToken } from './token';
import type { AppEnv } from '../types';

/**
 * Reserved first-segment words under /api that are NOT tenant slugs: /api/admin/* (sitter
 * login), /api/signup/* (invite signup), /api/owner/* (owner console), /api/password-reset/*
 * (password recovery). Tenants can never claim these as slugs — enforced again at signup-time
 * slug generation (routes/signup.ts).
 */
export const RESERVED_SLUGS = new Set(['admin', 'signup', 'owner', 'password-reset']);

/** Resolves the :slug param to a tenant (404 on unknown) and stores it on the context. */
export const tenantMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const slug = c.req.param('slug');
  if (slug && RESERVED_SLUGS.has(slug)) return next(); // handled by non-slug-scoped routes
  const tenant = slug ? await resolveTenant(slug, c.env) : null;
  if (!tenant) return c.json({ error: 'Unknown tenant' }, 404);
  c.set('tenant', tenant);
  // Disabled sitter = read-only: GET requests pass (widget shows an "unavailable" card via the
  // config `disabled` flag; sitter dashboard renders read-only), every mutation is rejected here
  // at the one chokepoint the whole /api/:slug/* surface flows through. Sitter LOGIN and owner
  // routes bypass tenantMiddleware, so a disabled sitter can still sign in and the owner can still
  // manage them.
  if (tenant.DisabledAt && c.req.method !== 'GET') {
    return c.json({ error: 'account_disabled' }, 403);
  }
  await next();
});

/**
 * Requires a Bearer end-user credential for the resolved tenant, of which there are two — a widget
 * session token, or a personal access token (0012) — and they are interchangeable here on purpose.
 * Both resolve to the same `(TenantId, EndUserId)` pair and confer exactly the same authority, so
 * no route downstream has to know, or is allowed to care, which one arrived.
 *
 * That is the whole point of the personal access token: `lib/llms.ts` publishes a booking API
 * whose every endpoint sits behind this middleware, and a 24-hour widget JWT minted by the
 * widget's own email-code flow made that API unusable by anything but the widget.
 *
 * 401 = missing/invalid/expired/revoked (the widget re-identifies; an API client re-authorises);
 * 403 = a valid widget token for a DIFFERENT tenant. A personal access token cannot produce that
 * 403: its lookup binds TenantId, so under the wrong sitter it does not exist rather than existing
 * elsewhere, and saying so would mean reading across a tenant boundary to find out.
 */
export const endUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  const presented = extractBearer(c.req.header('Authorization'));
  const tenant = c.get('tenant');

  // Personal access token. Screened by its public prefix first so an ordinary widget JWT never
  // costs a hash and a database read (see looksLikePersonalAccessToken — not a security check).
  if (looksLikePersonalAccessToken(presented)) {
    const hash = await hashPersonalAccessToken(presented);
    const row = await findLivePersonalAccessToken(c.env.PAWSERVATION_DB, tenant.Id, hash);
    // One answer for unknown, revoked, and belonging-to-another-sitter: the caller holds the
    // secret, so nothing is hidden from its owner that they could not already determine, and
    // nothing is confirmed to anyone else.
    if (!row) {
      // Unknown, revoked, or another sitter's — one answer to the caller (above), but the three of
      // them together are the shape of someone walking a token list, and that is worth seeing.
      securityEvent('personal_access_token_rejected', {
        tenant: tenant.Slug,
        path: new URL(c.req.url).pathname,
      });
      return c.json({ error: 'That token is not valid.' }, 401);
    }
    c.set('endUserId', row.EndUserId);
    c.set('endUserCredential', 'token');
    // "Last used" is for recognising a token in the revoke list, so it is refreshed at most once
    // an hour AND handed to waitUntil — an automated client's steady traffic must not turn every
    // read into a write, nor pay for one in its own latency. In tests there is no ExecutionContext,
    // so the write is awaited and the stamp is deterministic (the routes/admin.ts pattern).
    if (shouldRefreshLastUsed(row.LastUsedAt, Date.now())) {
      const task = touchPersonalAccessToken(c.env.PAWSERVATION_DB, tenant.Id, row.Id).catch(
        (err) => {
          console.error('personal access token touch failed', err);
        },
      );
      try {
        c.executionCtx.waitUntil(task);
      } catch {
        await task;
      }
    }
    await next();
    return;
  }

  const claims = presented ? await verifyToken(presented, c.env.TOKEN_SECRET) : null;
  if (!claims) return c.json({ error: 'Please sign in again.' }, 401);
  if (claims.tid !== tenant.Id) {
    // A VALID signature for the wrong sitter. Not a typo and not an expiry — either a widget
    // embedded twice on one page reading the neighbour's key (the free product's own demo did
    // exactly this), or a token being replayed across the tenant boundary on purpose. Both are
    // things you want to find out about from a log rather than from a customer.
    securityEvent('wrong_tenant', {
      tenant: tenant.Slug,
      path: new URL(c.req.url).pathname,
    });
    return c.json({ error: 'Wrong tenant.' }, 403);
  }
  c.set('endUserId', claims.sub);
  c.set('endUserCredential', 'widget');
  await next();
});

/**
 * Additionally requires that the end user authenticated with the WIDGET session, not with a
 * personal access token. Runs after `endUserAuth` and reads what it recorded.
 *
 * This guards credential management itself. A token that could mint another token would make
 * revocation advisory: cut off a leaked credential and whoever holds it issues a replacement
 * before the owner has finished reading the confirmation. Requiring the email-code session means
 * every long-lived credential traces back to someone who could read the owner's inbox at the time
 * it was issued, and the revoke list is a complete list.
 *
 * Fails closed: an unset credential means `endUserAuth` did not run, which is a wiring mistake,
 * and the safe reading of "we do not know how you authenticated" is "not with the widget".
 */
export const widgetSessionOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('endUserCredential') !== 'widget') {
    return c.json({ error: 'Sign in from the booking page to manage your tokens.' }, 403);
  }
  await next();
});

/**
 * Sitter-dashboard auth: a Bearer admin session token (from POST /api/admin/login) whose
 * `role` is 'admin' and whose tenant claim matches the route's tenant. 401 = not signed in;
 * 403 = signed in as a different tenant.
 */
export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractBearer(c.req.header('Authorization'));
  const claims = token ? await verifyAdminToken(token, c.env.TOKEN_SECRET) : null;
  if (!claims) return c.json({ error: 'Please sign in.' }, 401);
  if (claims.tid !== c.get('tenant').Id) return c.json({ error: 'Wrong account.' }, 403);
  c.set('adminUserId', claims.sub);
  await next();
});

/**
 * Platform-owner auth: a Bearer owner session token (role 'owner', no tid). Owner, admin,
 * and widget tokens are mutually unacceptable by claim shape (see lib/token.ts).
 */
export const ownerAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractBearer(c.req.header('Authorization'));
  const claims = token ? await verifyOwnerToken(token, c.env.TOKEN_SECRET) : null;
  if (!claims) return c.json({ error: 'Please sign in.' }, 401);
  c.set('ownerEmail', claims.sub);
  await next();
});
