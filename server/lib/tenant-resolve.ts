import { getTenantBySlug } from '../db/repo';
import type { Tenant } from '../types';

/**
 * The tenant-resolution seam. The prototype resolves by URL slug (one workers.dev host
 * serves every demo tenant); production resolves by hostname — swapping that in means
 * changing only this function's caller-supplied key, not its consumers.
 */

const TENANT_CACHE_TTL_SECONDS = 60;

/**
 * The cached shape's version, part of the KEY. Bump it in the same commit as any migration that
 * adds a `Tenants` column the request path READS: entries written by the previous worker hold the
 * old shape, and for one TTL after deploy the new code would read the new field as `undefined` —
 * silently the wrong answer, since the type says it cannot be. A new key means those entries are
 * never read at all (they expire on their own), which is cheaper and more honest than every reader
 * defending itself against a field that "cannot" be missing.
 *
 * v2: `HousesitBoardingOverlapDays` (migration 0006). Reading it as `undefined` would have run a
 * tenant who chose "never overlap" at the product default for 60 seconds.
 *
 * v3: `PremiumUntil` (migration 0010). `/api/:slug/config` derives its published premium flag from
 * this column on the cached row, and `isPremiumActive` reads anything that is not a string as "not
 * premium" — fail-closed, and therefore silent. So a v2 entry would have reported a sitter who has
 * paid as free for the remainder of its TTL: no error, no log, just a surface that declines to
 * appear. Worth naming that the failure is one-directional — an entry can only understate
 * entitlement, never grant it — because that is precisely what makes it easy to miss.
 */
const tenantCacheKey = (slug: string) => `tenant:${slug}:config:v3`;

export async function resolveTenant(slug: string, env: Env): Promise<Tenant | null> {
  const key = tenantCacheKey(slug);
  const cached = await env.PAWSERVATION_CACHE.get<Tenant>(key, 'json');
  if (cached) return cached;
  const tenant = await getTenantBySlug(env.PAWSERVATION_DB, slug);
  if (tenant) {
    await env.PAWSERVATION_CACHE.put(key, JSON.stringify(tenant), {
      expirationTtl: TENANT_CACHE_TTL_SECONDS,
    });
  }
  return tenant;
}

/** Settings writes call this so the widget sees changes on next load (PRD FR19). */
export async function invalidateTenantCache(slug: string, env: Env): Promise<void> {
  await env.PAWSERVATION_CACHE.delete(tenantCacheKey(slug));
}
