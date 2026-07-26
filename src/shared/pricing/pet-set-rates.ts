/**
 * Explicit rates for a set of pets — the ONE place a pet set becomes a rate lookup.
 *
 * A sitter may price a set two ways, and they are tried in this order:
 *
 * 1. **Specific animals** — `PetGroupPricing.GroupKey` is the sorted, comma-joined pet-id list
 *    with a `|<duration>` suffix for timed services. "Pedro & Remy, 60 min."
 * 2. **A species count** — `TenantServicePetRates.MixKey` is `cat:1|dog:2`, species sorted.
 *    "Any 2 dogs." Set once, applies to every client.
 *
 * Every lookup is EXACT, and that is the point of this module: a rate for one dog must never
 * produce a price for two. No summation across pets, no scaling by count, no proration, no
 * nearest-match. If the sitter has not priced the exact set, there is no rate, and the caller
 * decides what that means (the option's flat rate for a single pet; refuse for two or more).
 */

/** Species slug → count. Counts are >= 1; non-positive entries are not part of a mix. */
export type PetMix = Record<string, number>;

/** A stored pet-id rate, reduced to what resolution needs. */
export type GroupRate = { groupKey: string; rate: number };

/**
 * A stored species-count rate, reduced to what resolution needs. Unlike `GroupRate` — whose
 * source table is already queried per-service (`listPetGroupPricing(db, tenantId, serviceType)`)
 * — `TenantServicePetRates` rows for an entire tenant share one `MixKey` namespace across every
 * service/option, so `serviceType`/`optionKey` travel with each rate and `resolvePetSetRate`
 * filters on them before ever comparing `mixKey`. Without that scope, a boarding `dog:2` rate and
 * an unrelated walk `dog:2` rate would be indistinguishable to `.find()`.
 */
export type MixRate = { mixKey: string; rate: number; serviceType: string; optionKey: string };

/** Which layer supplied the rate, so callers can explain the price. */
export type RateResolution = { source: 'group' | 'mix'; rate: number } | null;

/** Canonical species-count key: species sorted, `slug:count` joined by `|`. '' when empty. */
export function buildMixKey(mix: PetMix): string {
  const slugs = Object.entries(mix)
    .filter(([, count]) => Number.isInteger(count) && count > 0)
    .map(([slug]) => slug)
    .sort();
  return slugs.map((slug) => `${slug}:${mix[slug]}`).join('|');
}

/**
 * Tally a list of species slugs (one entry per pet) into a mix. Uses a null-prototype
 * accumulator: species slugs are sitter-controlled `[a-z0-9-]+` strings (slugifyServiceLabel),
 * so `'constructor'` is reachable, and a `{}` literal would resolve `mix['constructor']` through
 * `Object.prototype` instead of setting an own property — silently dropping that pet from the
 * mix and corrupting `buildMixKey`/`petCountOf` for the whole set.
 */
export function mixFromPetTypes(petTypes: string[]): PetMix {
  const mix: PetMix = Object.create(null);
  for (const slug of petTypes) mix[slug] = (mix[slug] ?? 0) + 1;
  return mix;
}

/** Total pets in a mix. */
export function petCountOf(mix: PetMix): number {
  return Object.values(mix).reduce((sum, count) => sum + count, 0);
}

/**
 * Canonical pet-id key: ids deduped then sorted so selection order cannot change the key,
 * comma-joined, with `|<duration>` appended for timed services. Pet ids are UUIDs and so
 * comma-free, which is what makes the join unambiguous. '' when there are no pets.
 *
 * Deduping happens HERE, not at the caller: a caller that accepts client-supplied `petIds` may
 * validate only set membership (every id belongs to this customer), not uniqueness, and a
 * repeated id must never be allowed to manufacture a phantom multi-pet set (`['p_a','p_a']`
 * matching a 2-pet rate for what is really a single pet).
 */
export function buildGroupKey(petIds: string[], durationMinutes: number | null): string {
  if (petIds.length === 0) return '';
  const ids = [...new Set(petIds)].sort().join(',');
  return durationMinutes === null ? ids : `${ids}|${durationMinutes}`;
}

/**
 * The rate for EXACTLY this pet set, or null. Pet-id rates win over species rates; nothing
 * else is consulted and nothing is derived. See the module comment.
 *
 * `serviceType`/`optionKey` scope which `mixRates` entries are even eligible to match — required
 * because `MixRate` rows are drawn from a tenant-wide table (see the `MixRate` doc comment).
 *
 * Callers must derive `petTypes` from the SAME deduped pet set as `petIds` (`buildGroupKey`
 * dedups `petIds` internally, but `petTypes` is a separate array this function does not dedup
 * against `petIds` — a caller that lets duplicate ids leak into `petTypes` can still manufacture
 * a phantom multi-pet mix even though the group-key side is now safe).
 */
export function resolvePetSetRate(args: {
  petIds: string[];
  petTypes: string[];
  durationMinutes: number | null;
  serviceType: string;
  optionKey: string;
  groupRates: GroupRate[];
  mixRates: MixRate[];
}): RateResolution {
  const groupKey = buildGroupKey(args.petIds, args.durationMinutes);
  if (groupKey) {
    const hit = args.groupRates.find((r) => r.groupKey === groupKey);
    if (hit) return { source: 'group', rate: hit.rate };
  }
  const mixKey = buildMixKey(mixFromPetTypes(args.petTypes));
  if (mixKey) {
    const hit = args.mixRates.find(
      (r) =>
        r.mixKey === mixKey && r.serviceType === args.serviceType && r.optionKey === args.optionKey,
    );
    if (hit) return { source: 'mix', rate: hit.rate };
  }
  return null;
}
