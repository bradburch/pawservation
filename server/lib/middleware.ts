import { createMiddleware } from 'hono/factory';
import { matchedRoutes } from 'hono/route';
import { COMPOSED_HANDLER } from 'hono/utils/constants';
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
import { isDisabled, isPlanCurrent, planEnforceEnabled } from './premium';
import { resolveTenant } from './tenant-resolve';
import { extractBearer, verifyAdminToken, verifyOwnerToken, verifyToken } from './token';
import type { AppEnv } from '../types';

/**
 * Reserved first-segment words under /api that are NOT tenant slugs: /api/admin/* (sitter
 * login), /api/signup/* (invite signup), /api/owner/* (owner console), /api/password-reset/*
 * (password recovery). Tenants can never claim these as slugs — enforced again at signup-time
 * slug generation (routes/signup.ts).
 *
 * `billing` is the fifth, and it names the actual defect a reserved slug creates rather than a
 * hypothetical one: `tenantMiddleware` calls `next()` for any reserved slug WITHOUT setting
 * `tenant` on the context (below), so every handler mounted under a path a reserved word can reach
 * runs with no tenant resolved and must guard `c.get('tenant')` itself before touching it —
 * `adminAuth` already did, and `routes/billing.ts`'s handler does the same for exactly this reason.
 * `billing` itself shadows no route today (the billing endpoint is
 * `/api/:slug/admin/billing/events`, where `billing` is a later segment, so a tenant whose slug
 * were `billing` would only ever own `/api/billing/admin/billing/events`), but it is reserved
 * anyway and cheaply: it keeps a future `/api/billing/*` route from ever colliding with a sitter
 * who already holds the word, without that route having to remember to guard `tenant` on its own.
 */
export const RESERVED_SLUGS = new Set(['admin', 'signup', 'owner', 'password-reset', 'billing']);

/** The body this middleware answers for a slug it cannot resolve. Exported so any route that has
 *  to reproduce this exact 404 — `routes/billing.ts`'s refusal for a rejected billing secret is the
 *  one today — imports the literal instead of retyping it, so the two can never drift apart. */
export const UNKNOWN_TENANT = { error: 'Unknown tenant' } as const;

/** Resolves the :slug param to a tenant (404 on unknown) and stores it on the context. */
export const tenantMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const slug = c.req.param('slug');
  if (slug && RESERVED_SLUGS.has(slug)) return next(); // handled by non-slug-scoped routes
  const tenant = slug ? await resolveTenant(slug, c.env) : null;
  if (!tenant) return c.json(UNKNOWN_TENANT, 404);
  c.set('tenant', tenant);
  // Disabled sitter = read-only: READS pass (widget shows an "unavailable" card via the config
  // `disabled` flag; sitter dashboard renders read-only), every mutation is rejected here at the
  // one chokepoint the whole /api/:slug/* surface flows through. Sitter LOGIN and owner routes
  // bypass tenantMiddleware, so a disabled sitter can still sign in and the owner can still manage
  // them. `isDisabled` rather than a truthiness test, so this guard and the three predicates in
  // `lib/premium.ts` read the column one way: a non-empty string.
  //
  // `READ_METHODS`, not `!== 'GET'`: this used to refuse HEAD and OPTIONS too, and `planGate`
  // below copied it. A CORS preflight is an OPTIONS that carries no credential and precedes the
  // real request — refusing it refuses the real request before it is ever made, with a status the
  // browser never shows — and HEAD is a GET without a body. Widened here and in `planGate` in the
  // same commit, so the two guards keep agreeing about what a read is.
  if (isDisabled(tenant) && !READ_METHODS.has(c.req.method)) {
    return c.json({ error: 'account_disabled' }, 403);
  }
  await next();
});

/**
 * The methods that never write, and that both read-only guards therefore pass: GET, HEAD (a GET
 * without a body) and OPTIONS (a CORS preflight, which carries no credential and precedes the real
 * request). Everything else is treated as a mutation. One set, read by `tenantMiddleware` and
 * `planGate`, so "what is a read" is decided once.
 */
export const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

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
 * THE OPT-OUT MARKER for `planGate` below: a no-op middleware a route places in its own handler
 * chain — `.post('/:slug/admin/blocked', planExempt, async (c) => …)` — and which the gate finds
 * among the request's matched routes. The exemption is declared where the route is, on the route's
 * own line, beside the reviewer who can see what it exempts; the gate itself names no path, so
 * there is no list in this file to keep in step with the routes and no way to exempt a route by
 * accident of prefix. `plan-gate.test.ts` pins both halves: that the gate reads the marker, and
 * that this file spells none of the exempt paths.
 *
 * WHAT IS EXEMPT, AND WHY — the set is small, and every member is a write that keeps something
 * from getting worse rather than one that builds anything:
 *   - ANSWERING A BOOKING REQUEST (`/:slug/admin/bookings/:id/status`) and BLOCKING OR UNBLOCKING
 *     DATES (`/:slug/admin/blocked`). A-17's promise is that her clients keep booking while her
 *     dashboard goes quiet — but a request her clients keep submitting is one she must be able to
 *     answer, on dates she must be able to close, or the requests pile up unanswered against a
 *     calendar she cannot block. So the whole request loop keeps working; what she loses is
 *     everything else: settings, services, rates, minting tokens, connecting a calendar, exports,
 *     imports.
 *   - REVOKING A CREDENTIAL (`DELETE /:slug/admin/tokens/*`, by id or a token revoking itself). A
 *     leaked `pawsa_` token on a lapsed business would otherwise be a leak she cannot stop.
 *   - DISCONNECTING THE CALENDAR (`/:slug/admin/providers/calendar/disconnect`). She must be able
 *     to stop the product writing her calendar; connecting one stays refused.
 */
export const planExempt = createMiddleware<AppEnv>((_c, next) => next());

/**
 * Is `planExempt` on this request's route? Read off the router's own match rather than off the
 * context, because a middleware in the chain BEHIND this one has not run yet and cannot have set
 * anything. `COMPOSED_HANDLER` is the wrapper Hono puts around a sub-app's handlers when that app
 * has its own error handler; none does today, so the first test is the one that fires, and the
 * second is what keeps this true if one ever does.
 */
const routeIsPlanExempt = (c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0]) =>
  matchedRoutes(c).some(
    ({ handler }) =>
      handler === planExempt ||
      (handler as { [COMPOSED_HANDLER]?: unknown })[COMPOSED_HANDLER] === planExempt,
  );

/**
 * A LAPSED PLAN IS A READ-ONLY DASHBOARD, and it is a NARROWER fact than a disabled account.
 *
 * `tenantMiddleware` refuses mutations for a DISABLED business across the whole `/api/:slug/*`
 * surface, booking included. This one is mounted only over `/:slug/admin/*`, because A-17's whole
 * point is that her clients keep booking while her dashboard goes quiet. The two never both fire: a
 * disabled business is refused earlier, and `isPlanCurrent` is false for her anyway.
 *
 * 402 AND NOT 403. `isAuthExpired` (app/shared-ui/api.ts) treats 401 and 403 as an expired session,
 * and the dashboard only avoids signing a sitter out on `account_disabled` by testing that literal
 * FIRST. A second 403 literal is a second chance to get that order wrong, and the cost of getting
 * it wrong is ejecting her from the dashboard she is trying to read. A forgotten branch on 402
 * shows her an ugly message instead, and that asymmetry is the whole of the argument — it holds for
 * clients this repo does not own, too.
 *
 * FIVE EARLY RETURNS, IN THIS ORDER, and each is a different question:
 *   - a READ is never refused — GET, HEAD or OPTIONS, the same `READ_METHODS` the disabled guard
 *     passes, so the two guards agree about what a read is. The settings read is what renders the
 *     notice and the Subscribe control, so gating it would make the lapse unfixable from the UI.
 *   - no tenant on the context is answered 401, exactly as `adminAuth` answers it. Behind
 *     `adminAuth` this cannot happen — it has already refused — but a mount that forgot `adminAuth`
 *     must fail closed here rather than skip the plan check on the strength of a missing row.
 *   - the route carries `planExempt` (above).
 *   - the deployment is not enforcing. Unset is off, and it ships unset.
 *   - she holds a current plan, by any of the three grants.
 *
 * It is safe to run twice — Hono flattens `.use()` across every app mounted at the same base — and
 * needs no short-circuit latch of its own, because it is a pure read of the context.
 */
export const planGate = createMiddleware<AppEnv>(async (c, next) => {
  if (READ_METHODS.has(c.req.method)) return next();
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ error: 'Please sign in.' }, 401);
  if (routeIsPlanExempt(c)) return next();
  if (!planEnforceEnabled(c.env)) return next();
  if (isPlanCurrent(tenant)) return next();
  return c.json({ error: 'plan_lapsed' }, 402);
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
