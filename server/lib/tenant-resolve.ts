import { getTenantBySlug } from '../db/repo';
import type { Tenant } from '../types';

/**
 * The tenant-resolution seam. The prototype resolves by URL slug (one workers.dev host
 * serves every demo tenant); production resolves by hostname — swapping that in means
 * changing only this function's caller-supplied key, not its consumers.
 */

const TENANT_CACHE_TTL_SECONDS = 60;

const tenantCacheKey = (slug: string) => `tenant:${slug}:config`;

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
