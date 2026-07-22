export type RateWindow = { count: number; windowStart: number };

/**
 * True fixed window, not a TTL-refresh lockout: `windowStart` lives IN the KV value (not just as
 * `expirationTtl`) because a stale-but-unexpired window must still reset once its own age exceeds
 * `windowSeconds` — relying on `expirationTtl` alone means every retry (including over-cap ones)
 * pushes the expiry out another window, so a capped legitimate caller who keeps retrying never
 * ages out. `expirationTtl` on the write below is pure garbage collection; `windowStart` is the
 * source of truth for whether the window has rolled over.
 *
 * Returns `true` when `rateKey` is already over `maxPerWindow` for the current window — callers
 * skip their side-effecting work on `true` but must still return their normal (neutral) response,
 * so the limiter itself never becomes an enumeration oracle.
 */
export async function checkAndBumpRateLimit(
  cache: KVNamespace,
  rateKey: string,
  maxPerWindow: number,
  windowSeconds: number,
): Promise<boolean> {
  const now = Date.now();
  const raw = await cache.get(rateKey);
  const prev = raw ? (JSON.parse(raw) as RateWindow) : null;
  const fresh = !prev || now - prev.windowStart >= windowSeconds * 1000;
  const count = fresh ? 0 : prev.count;
  const windowStart = fresh ? now : prev.windowStart;
  await cache.put(rateKey, JSON.stringify({ count: count + 1, windowStart }), {
    expirationTtl: windowSeconds,
  });
  return count >= maxPerWindow;
}
