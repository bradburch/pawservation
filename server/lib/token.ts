import { sign, verify } from 'hono/jwt';

/**
 * Widget auth token: HMAC-SHA256 JWT held in widget JS (memory + best-effort sessionStorage).
 * Never a cookie — Safari blocks and Firefox partitions third-party cookies, and the Wix
 * embed sandbox can deny storage entirely, so token loss must degrade to re-identify.
 */

export const TOKEN_TTL_SECONDS = 60 * 60;

export type WidgetClaims = {
  /** End user id. */
  sub: string;
  /** Tenant id the token was minted for — checked against the resolved tenant on every request. */
  tid: string;
  exp: number;
};

export async function mintToken(
  endUserId: string,
  tenantId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const claims: WidgetClaims = {
    sub: endUserId,
    tid: tenantId,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
  return await sign(claims, secret);
}

/** Returns the claims for a valid, unexpired token; null for anything else. */
export async function verifyToken(token: string, secret: string): Promise<WidgetClaims | null> {
  try {
    const payload = await verify(token, secret, 'HS256');
    if (typeof payload.sub !== 'string' || typeof payload.tid !== 'string') return null;
    if (typeof payload.exp !== 'number') return null;
    // Reject anything carrying a role (i.e. an admin session token): widget and admin tokens
    // are signed with the same secret, so without this an admin token would authenticate
    // end-user routes. The reverse is already blocked by verifyAdminToken requiring role.
    if ('role' in payload) return null;
    return payload as WidgetClaims;
  } catch {
    return null;
  }
}

/**
 * Sitter-dashboard session token — same HS256 mechanism as the widget token but carries a
 * `role: 'admin'` claim, so a widget (end-user) token can never authenticate an admin route.
 */
export const ADMIN_TOKEN_TTL_SECONDS = 60 * 60 * 8;

export type AdminClaims = {
  /** TenantUser id. */
  sub: string;
  /** Tenant the sitter manages. */
  tid: string;
  role: 'admin';
  exp: number;
};

export async function mintAdminToken(
  tenantUserId: string,
  tenantId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const claims: AdminClaims = {
    sub: tenantUserId,
    tid: tenantId,
    role: 'admin',
    exp: nowSeconds + ADMIN_TOKEN_TTL_SECONDS,
  };
  return await sign(claims, secret);
}

export async function verifyAdminToken(token: string, secret: string): Promise<AdminClaims | null> {
  try {
    const payload = await verify(token, secret, 'HS256');
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.tid !== 'string' ||
      payload.role !== 'admin'
    )
      return null;
    if (typeof payload.exp !== 'number') return null;
    return payload as AdminClaims;
  } catch {
    return null;
  }
}

export function extractBearer(header: string | undefined | null): string {
  return header && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}
