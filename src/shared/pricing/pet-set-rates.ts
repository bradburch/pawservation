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

/** A stored species-count rate, reduced to what resolution needs. */
export type MixRate = { mixKey: string; rate: number };

/** Which layer supplied the rate, so callers can explain the price. */
export type RateResolution = { source: 'group' | 'mix'; rate: number } | null;

/** Canonical species-count key: species sorted, `slug:count` joined by `|`. '' when empty. */
export function buildMixKey(mix: PetMix): string {
  return Object.entries(mix)
    .filter(([, count]) => Number.isInteger(count) && count > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([slug, count]) => `${slug}:${count}`)
    .join('|');
}

/** Tally a list of species slugs (one entry per pet) into a mix. */
export function mixFromPetTypes(petTypes: string[]): PetMix {
  const mix: PetMix = {};
  for (const slug of petTypes) mix[slug] = (mix[slug] ?? 0) + 1;
  return mix;
}

/** Total pets in a mix. */
export function petCountOf(mix: PetMix): number {
  return Object.values(mix).reduce((sum, count) => sum + count, 0);
}

/**
 * Canonical pet-id key: ids sorted so selection order cannot change the key, comma-joined,
 * with `|<duration>` appended for timed services. Pet ids are UUIDs and so comma-free, which
 * is what makes the join unambiguous. '' when there are no pets.
 */
export function buildGroupKey(petIds: string[], durationMinutes: number | null): string {
  if (petIds.length === 0) return '';
  const ids = [...petIds].sort().join(',');
  return durationMinutes === null ? ids : `${ids}|${durationMinutes}`;
}

/**
 * The rate for EXACTLY this pet set, or null. Pet-id rates win over species rates; nothing
 * else is consulted and nothing is derived. See the module comment.
 */
export function resolvePetSetRate(args: {
  petIds: string[];
  petTypes: string[];
  durationMinutes: number | null;
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
    const hit = args.mixRates.find((r) => r.mixKey === mixKey);
    if (hit) return { source: 'mix', rate: hit.rate };
  }
  return null;
}
