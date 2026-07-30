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
 */
const tenantCacheKey = (slug: string) => `tenant:${slug}:config:v2`;

export async function resolveTenant(slug: string, env: Env): Promise<Tenant | null> {
  const key = tenantCacheKey(slug);
  const cached = await env.PAWBOOK_CACHE.get<Tenant>(key, 'json');
  if (cached) return cached;
  const tenant = await getTenantBySlug(env.PAWBOOK_DB, slug);
  if (tenant) {
    await env.PAWBOOK_CACHE.put(key, JSON.stringify(tenant), {
      expirationTtl: TENANT_CACHE_TTL_SECONDS,
    });
  }
  return tenant;
}

/** Settings writes call this so the widget sees changes on next load (PRD FR19). */
export async function invalidateTenantCache(slug: string, env: Env): Promise<void> {
  await env.PAWBOOK_CACHE.delete(tenantCacheKey(slug));
}
