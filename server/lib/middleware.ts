import { createMiddleware } from 'hono/factory';
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
  await next();
});

/**
 * Requires a Bearer widget token whose tenant claim matches the resolved tenant.
 * 401 = missing/invalid/expired (widget re-identifies); 403 = valid token, wrong tenant.
 */
export const endUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractBearer(c.req.header('Authorization'));
  const claims = token ? await verifyToken(token, c.env.TOKEN_SECRET) : null;
  if (!claims) return c.json({ error: 'Please sign in again.' }, 401);
  if (claims.tid !== c.get('tenant').Id) return c.json({ error: 'Wrong tenant.' }, 403);
  c.set('endUserId', claims.sub);
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
