import { Hono } from 'hono';
import { getOwnerUserByEmail, getTenantById, getTenantUserByEmail } from '../db/repo';
import { isOwnerEmail } from '../lib/owners';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../lib/password';
import {
  extractBearer,
  mintAdminToken,
  mintOwnerToken,
  verifyAdminToken,
  verifyOwnerToken,
} from '../lib/token';
import type { AppEnv } from '../types';

const NOT_LINKED_ERROR = 'Account is not linked to a business.';

/**
 * Sitter-dashboard login. Unlike the per-tenant admin routes, login is NOT slug-scoped —
 * the email resolves which tenant the sitter manages, so these live at /api/admin/* with no
 * slug. An email named by OWNER_EMAILS is a platform owner, full stop: it always routes to
 * the owner console and never doubles as a sitter login.
 */
export const adminAuthRoutes = new Hono<AppEnv>()
  .post('/admin/login', async (c) => {
    const body = await c.req
      .json<{ email?: unknown; password?: unknown }>()
      .catch(() => ({}) as { email?: unknown; password?: unknown });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) return c.json({ error: 'Email and password required.' }, 400);

    if (isOwnerEmail(c.env, email)) {
      // Owner path: verify against the row's hash — or DUMMY_PASSWORD_HASH when absent — so
      // this path costs exactly ONE PBKDF2 derive either way, preserving the constant-time
      // posture the sitter path already has.
      const owner = await getOwnerUserByEmail(c.env.PAWBOOK_DB, email);
      const ok = await verifyPassword(password, owner?.PasswordHash ?? DUMMY_PASSWORD_HASH);
      if (!owner || !ok) return c.json({ error: 'Invalid email or password.' }, 401);
      const token = await mintOwnerToken(email, c.env.TOKEN_SECRET);
      return c.json({ token, role: 'owner', email });
    }

    const user = await getTenantUserByEmail(c.env.PAWBOOK_DB, email);
    // Always run a PBKDF2 verify — against a dummy hash when the email is unknown — so the
    // response time does not reveal whether an account exists (user-enumeration timing oracle).
    const ok = await verifyPassword(password, user?.PasswordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) return c.json({ error: 'Invalid email or password.' }, 401);

    const tenant = await getTenantById(c.env.PAWBOOK_DB, user.TenantId);
    if (!tenant) return c.json({ error: NOT_LINKED_ERROR }, 500);

    const token = await mintAdminToken(user.Id, user.TenantId, c.env.TOKEN_SECRET);
    return c.json({
      token,
      role: 'admin',
      slug: tenant.Slug,
      displayName: tenant.DisplayName,
      email: user.Email,
    });
  })

  /** Lets the dashboard restore a session on reload and learn its role/slug from the token. */
  .get('/admin/session', async (c) => {
    const token = extractBearer(c.req.header('Authorization'));
    const claims = token ? await verifyAdminToken(token, c.env.TOKEN_SECRET) : null;
    if (claims) {
      const tenant = await getTenantById(c.env.PAWBOOK_DB, claims.tid);
      if (!tenant) return c.json({ error: NOT_LINKED_ERROR }, 500);
      return c.json({ role: 'admin', slug: tenant.Slug, displayName: tenant.DisplayName });
    }
    const ownerClaims = token ? await verifyOwnerToken(token, c.env.TOKEN_SECRET) : null;
    if (ownerClaims) return c.json({ role: 'owner', email: ownerClaims.sub });
    return c.json({ error: 'Not signed in.' }, 401);
  });
