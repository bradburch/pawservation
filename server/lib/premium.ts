import type { Tenant } from '../types';

/**
 * `Tenants.PremiumUntil` (0010), and the whole of what this repo knows about premium: a tenant has
 * paid through an instant, or has not. This module answers "has that instant passed?" and "where
 * does the paid surface live?", and that is the complete surface area — there is deliberately no
 * feature list, no capability registry, and nothing here that gates anything. The free product's
 * job is to record the fact and publish it; deciding what the fact BUYS belongs to whatever
 * consumes the published flag, and lives in that codebase, not this one.
 */

/**
 * The instant format stored in `Tenants.PremiumUntil`: SQLite's own `datetime('now')` shape,
 * 'YYYY-MM-DD HH:MM:SS' in UTC, which is what `CreatedAt` and `DisabledAt` already hold.
 *
 * The format is load-bearing, not cosmetic. Every component is fixed-width, zero-padded and
 * ordered most-significant-first, and every value is in the same timezone — so lexicographic order
 * IS chronological order and `PremiumUntil > now` can be a plain string comparison. Store one row
 * as '2027-01-01T00:00:00Z' instead and that comparison silently inverts against a space-separated
 * `now` ('T' > ' '), granting free access on the strength of a separator character. Normalising on
 * the way IN is what keeps the column homogeneous enough for that comparison to be honest.
 */
function toStoredInstant(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** `now` in the stored shape, so it can be compared against a stored value directly. */
export function premiumNow(now: Date = new Date()): string {
  return toStoredInstant(now.getTime());
}

/**
 * Normalise an owner-supplied expiry into the stored shape, or `null` if it is not a date at all
 * (the caller turns that into a 400 rather than storing something the comparison cannot read).
 *
 * Accepts anything `Date.parse` accepts, which includes both a full ISO instant
 * ('2027-01-01T00:00:00Z') and a bare calendar date ('2027-01-01'). A bare date is UTC midnight at
 * the START of that day per the ECMAScript spec — i.e. "premium expires as that day begins" — which
 * is the conservative reading and the one that cannot accidentally hand out an extra day. It is
 * spelled out here because it is the kind of off-by-one an owner will otherwise discover from a
 * customer. An owner who means end-of-day says so with a full instant.
 *
 * Note this deliberately does NOT reject a date in the past: "paid through last March" is a true
 * statement about a lapsed tenant and a legitimate thing to record. It simply is not premium, which
 * `isPremiumActive` decides on its own.
 */
export function normalizePremiumUntil(raw: string): string | null {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : toStoredInstant(ms);
}

/**
 * Is this tenant premium right now? The one place the question is answered.
 *
 * Two ways to be false, and they are separate on purpose:
 *
 *   1. `PremiumUntil` is absent, or is not a string, or does not stand later than now. Anything
 *      that is not a stored instant in the future is "free" — including the `undefined` a stale
 *      cache entry from a pre-0010 worker would produce, which is why the fallback is a refusal
 *      rather than a throw (and why the KV cache key was bumped to v3 in the same commit: failing
 *      closed is right, but failing closed for a sitter who has paid is still wrong).
 *
 *   2. The tenant is DISABLED. A disabled sitter's business is switched off — the widget goes dark
 *      and the whole API surface is read-only — so however much of their subscription remains,
 *      there is nothing for a paid surface to attach to. Reporting them premium would publish a
 *      flag that invites a surface to mount over a business that is closed. The two conditions are
 *      independent, so a disable does not touch the timestamp: re-enabling the tenant restores
 *      whatever they had already paid for, with nothing to reinstate.
 */
export function isPremiumActive(tenant: Tenant, now: Date = new Date()): boolean {
  if (tenant.DisabledAt != null) return false;
  if (typeof tenant.PremiumUntil !== 'string') return false;
  return tenant.PremiumUntil > premiumNow(now);
}

/**
 * Where the paid surface is served from — READ ENTIRELY FROM `PREMIUM_ORIGIN`, with no default.
 *
 * There used to be one, and it was the commercial deployment's own domain. That is wrong twice
 * over. This repo is the free product and contains no premium code, so naming the paid product's
 * host in it is this codebase asserting something about a codebase it does not contain; and any
 * deployment that never set the variable — a fork, a self-hoster, a staging stack — would publish
 * that host to its own customers' widgets, pointing them at a business that is not theirs. A value
 * that is wrong for every deployment but one is a setting, not a default.
 *
 * Unset ⇒ `null`, meaning "this deployment has no premium surface". Every consumer already handles
 * that state, because it is indistinguishable from what an unentitled tenant is shown — so the
 * failure mode is a surface that does not mount, never one that mounts against the wrong host.
 *
 * ABSOLUTE, scheme + host, no path. The widget and the admin dashboard are also served from
 * `*.workers.dev` hosts, which get no route matching: a relative path there resolves against the
 * wrong host and the surface silently fails to load. So anything that is not an absolute origin is
 * refused exactly as "unset" is — publishing a value the embed cannot use would trade a visible
 * misconfiguration for an invisible one. A trailing slash is accepted and trimmed (the same origin,
 * written differently); a PATH is not, because where the paid surface mounts is that surface's own
 * routing decision.
 */
const ABSOLUTE_ORIGIN = /^https?:\/\/[^/?#\s]+$/;

export function premiumOrigin(env: Env): string | null {
  const configured = env.PREMIUM_ORIGIN?.trim().replace(/\/$/, '');
  if (!configured) return null;
  return ABSOLUTE_ORIGIN.test(configured) ? configured : null;
}
