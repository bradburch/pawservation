/**
 * Explicit rates for a set of pets — the ONE place a pet set becomes a rate lookup.
 *
 * A sitter may price a set two ways, and they are tried in this order:
 *
 * 1. **Specific animals** — `PetGroupPricing.GroupKey` is the sorted, comma-joined pet-id list.
 *    "Pedro & Remy." Keyed per option (`OptionKey`), so a rate set for one option of a service
 *    never prices a different option of the same service.
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

/**
 * One pet, as resolution sees it: an id and a species slug that CANNOT drift apart. Resolution
 * takes this single array rather than parallel `petIds`/`petTypes` arrays — two arrays could
 * disagree in length or in order, and a repeated id deduped on one side but not the other let a
 * one-pet booking match a two-dog rate.
 */
export type PricedPet = { id: string; petType: string };

/**
 * A stored pet-id rate, reduced to what resolution needs. `PetGroupPricing` rows are queried
 * per-service (`listPetGroupPricing(db, tenantId, serviceType)`) but a service can have several
 * options sharing a duration (`server/routes/admin.ts:252-255` — "two 30-minute check-ins with
 * different names/rates"), so `groupKey` alone cannot tell them apart. `optionKey` travels with
 * each rate and `resolvePetSetRate` filters on it before ever comparing `groupKey` — the same
 * scope check `MixRate` needs, and for the same reason.
 */
export type GroupRate = { groupKey: string; rate: number; serviceType: string; optionKey: string };

/**
 * A stored species-count rate, reduced to what resolution needs. `TenantServicePetRates` rows for
 * an entire tenant share one `MixKey` namespace across every service/option, so `serviceType`/
 * `optionKey` travel with each rate and `resolvePetSetRate` filters on them before ever comparing
 * `mixKey`. Without that scope, a boarding `dog:2` rate and an unrelated walk `dog:2` rate would
 * be indistinguishable to `.find()`.
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
 * Inverse of `buildMixKey` for CANONICAL keys. Deliberately lenient on malformed input —
 * strictness is the round-trip: `buildMixKey(parseMixKey(k)) === k` holds iff `k` is canonical
 * (sorted species, positive-integer counts, no duplicates), which is exactly the check write
 * paths use. Returns a null-prototype record for the same reason `mixFromPetTypes` does:
 * 'constructor' is a reachable species slug.
 */
export function parseMixKey(mixKey: string): PetMix {
  const mix: PetMix = Object.create(null);
  if (mixKey === '') return mix;
  for (const part of mixKey.split('|')) {
    const sep = part.lastIndexOf(':');
    if (sep <= 0) continue; // malformed part — the rebuild-equality check catches it
    mix[part.slice(0, sep)] = Number(part.slice(sep + 1));
  }
  return mix;
}

/**
 * Canonical pet-id key: ids deduped then sorted so selection order cannot change the key,
 * comma-joined. Pet ids are UUIDs and so comma-free, which is what makes the join unambiguous.
 * '' when there are no pets. Duration is NOT part of this key — `OptionKey` (carried alongside
 * on `GroupRate`/the stored row) already pins duration, since two options of one service may
 * share a duration and a suffix here could not distinguish them.
 *
 * Deduping happens here AND in `dedupePets`: a caller that accepts client-supplied `petIds` may
 * validate only set membership (every id belongs to this customer), not uniqueness, and a
 * repeated id must never be allowed to manufacture a phantom multi-pet set (`['p_a','p_a']`
 * matching a 2-pet rate for what is really a single pet).
 */
export function buildGroupKey(petIds: string[]): string {
  if (petIds.length === 0) return '';
  return [...new Set(petIds)].sort().join(',');
}

/**
 * The rate for EXACTLY this pet set, or null. Pet-id rates win over species rates; nothing
 * else is consulted and nothing is derived. See the module comment.
 *
 * `serviceType`/`optionKey` scope which `groupRates` and `mixRates` entries are even eligible to
 * match — required because both `GroupRate` and `MixRate` rows are drawn from queries that can
 * span more than one option (see their doc comments).
 *
 * `pets` is deduplicated by `id` ONCE, here, and BOTH keys are derived from that one deduped
 * list — so the pet-id key and the species key can never describe different sets. Callers may
 * pass a client-supplied list that was validated for membership (every pet belongs to this
 * customer) without also being validated for uniqueness; a repeat is a repeat of the same
 * animal, never a second one. Dedup keeps the FIRST occurrence of an id.
 */
export function resolvePetSetRate(args: {
  pets: PricedPet[];
  serviceType: string;
  optionKey: string;
  groupRates: GroupRate[];
  mixRates: MixRate[];
}): RateResolution {
  const distinct = dedupePets(args.pets);
  const groupKey = buildGroupKey(distinct.map((p) => p.id));
  if (groupKey) {
    const hit = args.groupRates.find(
      (r) =>
        r.groupKey === groupKey &&
        r.serviceType === args.serviceType &&
        r.optionKey === args.optionKey,
    );
    if (hit) return { source: 'group', rate: hit.rate };
  }
  const mixKey = buildMixKey(mixFromPetTypes(distinct.map((p) => p.petType)));
  if (mixKey) {
    const hit = args.mixRates.find(
      (r) =>
        r.mixKey === mixKey && r.serviceType === args.serviceType && r.optionKey === args.optionKey,
    );
    if (hit) return { source: 'mix', rate: hit.rate };
  }
  return null;
}

/**
 * The one deduplication in the price path: by pet id, first occurrence wins. Exported because
 * `estimateCost` needs the same deduped count to decide "one pet" vs "two or more" — deciding it
 * from a raw `pets.length` would let `['p_a','p_a']` be refused as a two-pet set.
 */
export function dedupePets(pets: PricedPet[]): PricedPet[] {
  const seen = new Set<string>();
  const out: PricedPet[] = [];
  for (const p of pets) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}
