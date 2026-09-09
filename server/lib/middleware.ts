import { createMiddleware } from 'hono/factory';
import {
  findLivePersonalAccessToken,
  findLiveTenantAccessToken,
  touchPersonalAccessToken,
  touchTenantAccessToken,
} from '../db/repo';
import {
  hashPersonalAccessToken,
  looksLikePersonalAccessToken,
  looksLikeTenantAccessToken,
  shouldRefreshLastUsed,
} from './personal-access-token';
import { requestContext, securityEvent } from './log';
import { resolveTenant } from './tenant-resolve';
import { extractBearer, verifyAdminToken, verifyOwnerToken, verifyToken } from './token';
import type { AppEnv } from '../types';

/**
 * Reserved first-segment words under /api that are NOT tenant slugs: /api/admin/* (sitter
 * login), /api/signup/* (invite signup), /api/owner/* (owner console), /api/password-reset/*
 * (password recovery). Tenants can never claim these as slugs — enforced again at signup-time
 * slug generation (routes/signup.ts).
 *
 * `billing` is the fifth and is the odd one out: it shadows nothing TODAY, because the billing
 * endpoint is `/api/:slug/admin/billing/events`, where `billing` is a later segment and a tenant
 * whose slug were `billing` would simply own `/api/billing/admin/billing/events`. It is reserved
 * anyway, and cheaply: what it actually buys is that moving that route to `/api/billing/*` can never
 * collide with a sitter who already holds the word.
 */
export const RESERVED_SLUGS = new Set(['admin', 'signup', 'owner', 'password-reset', 'billing']);

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
        ...requestContext(c.req),
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
      ...requestContext(c.req),
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
 * Sitter-dashboard auth, of which there are two credentials — a Bearer admin session token (from
 * POST /api/admin/login) whose `role` is 'admin' and whose tenant claim matches the route's
 * tenant, or a tenant access token (0016) — and they are interchangeable here on purpose, exactly
 * as `endUserAuth`'s two are. Both resolve to the same `(TenantId, TenantUserId)` pair and set the
 * same `adminUserId`, which is the whole of the admin context, so every `/api/:slug/admin/*` route
 * behaves byte-for-byte the same for either. That is the design, stated rather than discovered:
 * the destructive routes (customer and service deletion, imports, attribution apply, the CSV
 * export) are included, because the sitter scripting her own book is the point of the credential.
 *
 * The exception is credential management itself — see `adminSessionOnly` below.
 *
 * 401 = not signed in; 403 = a session signed in as a different tenant. A tenant access token
 * cannot produce that 403, for the reason `endUserAuth` gives about its own: the lookup binds
 * TenantId, so under the wrong sitter the token does not exist rather than existing elsewhere,
 * and saying so would mean reading across a tenant boundary to find out.
 */
export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  // ALREADY AUTHENTICATED, so do it once. Hono flattens `.use()` patterns across every app mounted
  // at the same base, so a request to /api/:slug/admin/tokens matches BOTH admin.ts's
  // `.use('/:slug/admin/*', adminAuth)` and tenant-tokens.ts's own `.use('/:slug/admin/tokens')` —
  // this middleware runs twice on that one request. Without this guard that is two token hashes,
  // two authentication reads, and two `LastUsedAt` touches for one request. Only `adminAuth` sets
  // `adminCredential`, so its presence means exactly "an earlier run of this middleware already
  // resolved the caller", and re-resolving the same Authorization header cannot reach a different
  // answer.
  if (c.get('adminCredential') !== undefined) return next();

  const presented = extractBearer(c.req.header('Authorization'));
  // `tenantMiddleware` sets this for every /api/:slug/* route; an unset tenant means this
  // middleware was mounted somewhere that never resolved one, and the safe reading of "we do not
  // know whose dashboard this is" is "you are not signed in to it". Guarded rather than assumed
  // because the alternative is a TypeError on `tenant.Id` below, which surfaces as a 500.
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ error: 'Please sign in.' }, 401);

  // Tenant access token. Screened by its public prefix first, so an ordinary admin JWT never costs
  // a hash and a database read (see looksLikeTenantAccessToken — not a security check). A pet
  // owner's `pawsv_` token fails this screen and falls through to the JWT verifier, which is why
  // it is a plain 401 here and never fires the sitter-side event: the two prefixes differ so that
  // each family's rejection signal stays about its own family.
  if (looksLikeTenantAccessToken(presented)) {
    // A DISABLED tenant refuses the token outright, before the lookup. `tenantMiddleware` only
    // blocks mutations for a disabled sitter — the dashboard stays readable so she can still see
    // her book while the owner sorts it out — but that reasoning is about a session someone is
    // sitting in front of. A token is a credential that keeps working with nobody watching, so an
    // owner who disables an account has to be able to assume it stopped working, reads included.
    // Same body as every other miss below, for the reason the next comment gives.
    if (tenant.DisabledAt) {
      securityEvent('tenant_access_token_rejected', {
        tenant: tenant.Slug,
        ...requestContext(c.req),
      });
      return c.json({ error: 'Please sign in.' }, 401);
    }
    const hash = await hashPersonalAccessToken(presented);
    const row = await findLiveTenantAccessToken(c.env.PAWSERVATION_DB, tenant.Id, hash);
    if (!row) {
      // Unknown, revoked, or another sitter's — one answer to the caller, and deliberately the
      // SAME BODY the JWT miss below returns, byte for byte, so a token's refusal is not
      // distinguishable from any other way of not being signed in. (`endUserAuth` answers its two
      // misses with different strings; do not "finish the mirror" by copying that here — it is
      // pinned by a test.) The three of them together are the shape of someone walking a token
      // list, and that is worth seeing.
      //
      // The BODY is byte-identical; the TIMING is not. Reaching this line costs a SHA-256 and an
      // indexed read that the JWT miss below does not pay, so a caller who measures carefully
      // enough can tell a well-formed `pawsa_` string from a malformed one. That is accepted: the
      // prefix is public and self-declared by the caller, so the timing confirms only what the
      // caller already typed, not whether any particular token exists.
      securityEvent('tenant_access_token_rejected', {
        tenant: tenant.Slug,
        ...requestContext(c.req),
      });
      return c.json({ error: 'Please sign in.' }, 401);
    }
    c.set('adminUserId', row.TenantUserId);
    c.set('adminCredential', 'token');
    // WHICH token this is. Read by exactly one route — the DELETE that lets a token revoke ITSELF
    // (`routes/tenant-tokens.ts`) — and by nothing else: it is not part of the admin context, and
    // a route that branched on it would be branching on the credential, which the carve-out
    // forbids everywhere except credential management itself.
    c.set('adminTokenId', row.Id);
    // Refreshed at most hourly and handed to waitUntil, for the reasons endUserAuth gives: a
    // recognition aid for the revoke list must not turn an automated client's every read into a
    // write. With no ExecutionContext (tests) the write is awaited so the stamp is deterministic.
    //
    // Scheduled AFTER the handler, and gated on AUTHORIZATION rather than on the outcome: 401 and
    // 403 are the two answers that mean this credential was not allowed to do the thing, and those
    // must not make a token look busy — a token being probed would otherwise read as more active
    // than one doing real work, and `LastUsedAt` is what the sitter reads to decide a token is
    // idle and safe to revoke. Every other status is a use: a 404 for a client that asked for a
    // customer who has been deleted is the credential working exactly as intended, and a 500 is
    // still the token having reached a route and run it.
    //
    // `finally`, so a handler that THROWS still stamps. The alternative reads as "your token was
    // idle all week" about a token that was in use the whole time and hitting a bug. The write
    // itself is still deferred, not awaited — the response is built before this runs.
    try {
      await next();
    } finally {
      const status = c.res.status;
      if (status !== 401 && status !== 403 && shouldRefreshLastUsed(row.LastUsedAt, Date.now())) {
        const task = touchTenantAccessToken(c.env.PAWSERVATION_DB, tenant.Id, row.Id).catch(
          (err) => {
            console.error('tenant access token touch failed', err);
          },
        );
        try {
          c.executionCtx.waitUntil(task);
        } catch {
          await task;
        }
      }
    }
    return;
  }

  const claims = presented ? await verifyAdminToken(presented, c.env.TOKEN_SECRET) : null;
  if (!claims) return c.json({ error: 'Please sign in.' }, 401);
  if (claims.tid !== tenant.Id) return c.json({ error: 'Wrong account.' }, 403);
  c.set('adminUserId', claims.sub);
  c.set('adminCredential', 'password');
  await next();
});

/**
 * Additionally requires that the sitter authenticated with the PASSWORD session, not with a tenant
 * access token. Runs after `adminAuth` and reads what it recorded — the sitter-side mirror of
 * `widgetSessionOnly`, and for the same reason.
 *
 * The owner's rule for tenant access tokens is "everything except self-amplifying actions", and in
 * this codebase that set is exactly the token routes: there is no password-change route under
 * `/admin/*` (reset is unauthenticated and email-gated), and disabling or deleting a tenant is
 * owner-scoped and unreachable by any admin credential. A token that could mint its replacement
 * would make the revoke list advisory — cut off a leaked credential and whoever holds it issues a
 * new one before the sitter has finished reading the confirmation.
 *
 * Fails closed: an unset credential means `adminAuth` did not run, which is a wiring mistake, and
 * the safe reading of "we do not know how you authenticated" is "not with the password".
 */
export const adminSessionOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('adminCredential') !== 'password') {
    return c.json({ error: 'Sign in with your password to manage your access tokens.' }, 403);
  }
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
