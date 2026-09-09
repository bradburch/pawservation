import type { Tenant } from '../types';

/**
 * WHAT THIS REPO KNOWS ABOUT PREMIUM, and the one place it is decided. `Tenants.PremiumUntil` (0010)
 * used to be the whole of it — a tenant had paid through an instant, or had not. Since 0017 it is
 * one of TWO grants: the platform owner's manual comp (`PremiumUntil`, unchanged in shape and in
 * meaning) and a paid Pro plan (`Plan` + `BilledUntil`, written only by billing). `isPremiumActive`
 * combines them in a single expression so that no caller ever has to.
 *
 * This module still GATES NOTHING. There is deliberately no feature list and no capability
 * registry: the free product's job is to record the facts and publish one derived boolean, and
 * deciding what that boolean BUYS belongs to whatever consumes it, in that codebase, not this one.
 * The other question answered here is the same size — where the paid surface is served from.
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
 * The furthest ahead a BILLING event may claim a tenant is paid through (NFR-14) — the containment
 * on what a leaked shared secret can buy. 400 days is annual (366 in a leap year) plus a few days of
 * grace plus clock skew, and the longest period this product sells is `PRICING.proAnnual`. Revisit
 * only if something longer than a year is ever sold.
 *
 * A FIXED ceiling rather than one derived from a caller-supplied interval, deliberately: a caller
 * who can send `interval: 'year'` has already defeated the tighter bound, so the field would buy
 * nothing in the threat model it exists for, while adding a second thing to get right.
 */
export const MAX_BILLED_AHEAD_DAYS = 400;

/**
 * Normalise a billing event's paid-through date into the stored shape, or `null` if it is not a date
 * or is further ahead than the ceiling. `null` is a 400 at the route, never a stored value: a
 * `BilledUntil` in any other shape inverts the comparison that decides entitlement.
 *
 * A PAST date is accepted, exactly as `normalizePremiumUntil` accepts one. "Paid through last
 * March" is a true statement about a lapsed subscription, and a cancellation legitimately writes
 * one.
 */
export function normalizeBilledUntil(raw: string, now: Date = new Date()): string | null {
  const stored = normalizePremiumUntil(raw);
  if (stored === null) return null;
  const ceiling = toStoredInstant(now.getTime() + MAX_BILLED_AHEAD_DAYS * 86_400_000);
  return stored > ceiling ? null : stored;
}

/**
 * THE FOUR COLUMNS ENTITLEMENT IS DECIDED FROM, and nothing else. Narrower than `Tenant` on purpose:
 * the owner console's roster row is not a tenant row, and the alternative to this type was a second
 * copy of the rule in `routes/owner.ts` — which is the exact thing spine AD-13 forbids.
 */
export type EntitlementFacts = Pick<Tenant, 'DisabledAt' | 'PremiumUntil' | 'Plan' | 'BilledUntil'>;

/**
 * Is this tenant premium right now? The one place the question is answered (spine AD-13).
 *
 * TWO WAYS TO BE PREMIUM, and they are independent facts about different people's decisions:
 *
 *   1. THE PLATFORM OWNER'S COMP — `PremiumUntil` in the future. Set and cleared by hand from the
 *      owner console, written only by `setTenantPremiumUntil`, and never touched by billing. A comp
 *      surviving a renewal, a cancellation and a redelivery is precisely what that separation buys.
 *
 *   2. A PAID PRO PLAN — `Plan === 'pro'` AND `BilledUntil` in the future. `Plan === 'solo'` is
 *      deliberately not enough: Solo is the free product's own paid tier and buys the free product.
 *      Solo is not premium.
 *
 * ONE WAY TO BE NEITHER, shared by both clauses and therefore written once, as a single early
 * return: the tenant is DISABLED. A disabled sitter's business is switched off — the widget goes
 * dark and the whole API surface is read-only — so however much of either grant remains there is
 * nothing for a paid surface to attach to. Two tiers drifting apart on the one condition they agree
 * about is what a shared early return prevents. The conditions stay independent in the database, so
 * a disable touches neither timestamp: re-enabling restores whatever was already paid for.
 *
 * The `typeof x === 'string'` guards are not defensive noise. Anything that is not a stored instant
 * is "not that", including the `undefined` a stale KV entry from a previous worker produces — the
 * failure is closed, and therefore silent, which is why the cache key moved to v6 in the same
 * commit as 0017.
 */
export function isPremiumActive(tenant: EntitlementFacts, now: Date = new Date()): boolean {
  if (tenant.DisabledAt != null) return false;
  const stamp = premiumNow(now);
  const comped = typeof tenant.PremiumUntil === 'string' && tenant.PremiumUntil > stamp;
  const billed =
    tenant.Plan === 'pro' && typeof tenant.BilledUntil === 'string' && tenant.BilledUntil > stamp;
  return comped || billed;
}

/**
 * Does this tenant have a live paid subscription? `BilledUntil` in the future, and not disabled —
 * independent of `PremiumUntil` entirely, because an owner comp is a gift of the PAID surface and
 * not of a subscription. A Pro subscriber satisfies this too: the question is "is she paying", and
 * she is.
 *
 * NOTHING IN THIS REPO CALLS THIS YET, and it is exported and tested anyway. AD-13 asks for the rule
 * in one expression in one file; a rule written down in half is the thing that requirement is
 * defending against, and the half left unwritten is the half that gets re-derived somewhere else.
 */
export function isSoloActive(tenant: EntitlementFacts, now: Date = new Date()): boolean {
  if (tenant.DisabledAt != null) return false;
  return typeof tenant.BilledUntil === 'string' && tenant.BilledUntil > premiumNow(now);
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
