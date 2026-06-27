import { Hono } from 'hono';
import { getTenantById, getTenantUserByEmail } from '../db/repo';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../lib/password';
import { extractBearer, mintAdminToken, verifyAdminToken } from '../lib/token';
import type { AppEnv } from '../types';

const NOT_LINKED_ERROR = 'Account is not linked to a business.';

/**
 * Sitter-dashboard login. Unlike the per-tenant admin routes, login is NOT slug-scoped —
 * the email resolves which tenant the sitter manages, so these live at /api/admin/* with no slug.
 */
export const adminAuthRoutes = new Hono<AppEnv>()
  .post('/admin/login', async (c) => {
    const body = await c.req
      .json<{ email?: unknown; password?: unknown }>()
      .catch(() => ({}) as { email?: unknown; password?: unknown });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) return c.json({ error: 'Email and password required.' }, 400);

    const user = await getTenantUserByEmail(c.env.PAWBOOK_DB, email);
    // Always run a PBKDF2 verify — against a dummy hash when the email is unknown — so the
    // response time does not reveal whether an account exists (user-enumeration timing oracle).
    const ok = await verifyPassword(password, user?.PasswordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) return c.json({ error: 'Invalid email or password.' }, 401);

    const tenant = await getTenantById(c.env.PAWBOOK_DB, user.TenantId);
    if (!tenant) return c.json({ error: NOT_LINKED_ERROR }, 500);

    const token = await mintAdminToken(user.Id, user.TenantId, c.env.TOKEN_SECRET);
    return c.json({ token, slug: tenant.Slug, displayName: tenant.DisplayName, email: user.Email });
  })

  /** Lets the dashboard restore a session on reload and learn its own slug from the token. */
  .get('/admin/session', async (c) => {
    const token = extractBearer(c.req.header('Authorization'));
    const claims = token ? await verifyAdminToken(token, c.env.TOKEN_SECRET) : null;
    if (!claims) return c.json({ error: 'Not signed in.' }, 401);
    const tenant = await getTenantById(c.env.PAWBOOK_DB, claims.tid);
    if (!tenant) return c.json({ error: NOT_LINKED_ERROR }, 500);
    return c.json({ slug: tenant.Slug, displayName: tenant.DisplayName });
  });
