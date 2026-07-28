/**
 * Renderable accounts: `buildAccounts` plus the two things it deliberately refuses to know about.
 *
 * `buildAccounts` takes EDGES and its caller filters deceased pets out of them, so by construction
 * every component it returns has at least one owner and at least one living pet. Two consequences
 * fall to this module rather than to that one:
 *
 *  - **A dead pet still belongs on a household's card.** It is ATTACHED to every active account
 *    whose owners overlap its owners — attachment only, never a union, so a pet two households
 *    once shared and has since died can never merge their billing.
 *  - **An owner with no living pet appears in NO account.** They must still be visible, so the
 *    leftovers are re-grouped by the SAME union-find over their deceased edges (two people whose
 *    only shared pet has died get one card, not two), and anyone still unplaced — reachable in
 *    production, since removing a customer's last pet is allowed — gets a solo empty card.
 *
 * Ids only, in and out: no wire types, no display strings, no dependencies (src/shared rules).
 */
import { buildAccounts, type OwnerPetLink } from './accounts.js';

/** One owner's pets, already split by the caller on whatever "deceased" means to it. */
export type OwnerPetSets = { ownerId: string; livePetIds: string[]; deceasedPetIds: string[] };

/**
 * One card. `active: false` means "no living pets" — the owners are real and must still render.
 * `key` is prefixed by kind so the three sources (live account / deceased-only group / pet-less
 * owner) can never collide on a pet or owner id.
 */
export type AccountGroup = {
  key: string;
  active: boolean;
  ownerIds: string[];
  livePetIds: string[];
  deceasedPetIds: string[];
};

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function linksFrom(owners: OwnerPetSets[], pick: (o: OwnerPetSets) => string[]): OwnerPetLink[] {
  const links: OwnerPetLink[] = [];
  for (const owner of owners) {
    for (const petId of pick(owner)) links.push({ ownerId: owner.ownerId, petId });
  }
  return links;
}

export function groupIntoAccounts(owners: OwnerPetSets[]): AccountGroup[] {
  const accounts = buildAccounts(linksFrom(owners, (o) => o.livePetIds));

  // petId -> owners of that DECEASED pet, for the attachment pass.
  const deceasedOwners = new Map<string, Set<string>>();
  for (const owner of owners) {
    for (const petId of owner.deceasedPetIds) {
      const set = deceasedOwners.get(petId) ?? new Set<string>();
      set.add(owner.ownerId);
      deceasedOwners.set(petId, set);
    }
  }

  const placed = new Set<string>();
  for (const account of accounts) {
    for (const ownerId of account.ownerIds) placed.add(ownerId);
  }

  const active: AccountGroup[] = accounts.map((account) => {
    const ownerSet = new Set(account.ownerIds);
    const deceasedPetIds = [...deceasedOwners.entries()]
      .filter(([, ownerIds]) => [...ownerIds].some((id) => ownerSet.has(id)))
      .map(([petId]) => petId)
      .sort(byString);
    return {
      key: `account:${account.id}`,
      active: true,
      ownerIds: account.ownerIds,
      livePetIds: account.petIds,
      deceasedPetIds,
    };
  });

  // Leftovers: nobody here owns a living pet, so buildAccounts placed none of them.
  const leftover = owners.filter((o) => !placed.has(o.ownerId));
  const memorial = buildAccounts(linksFrom(leftover, (o) => o.deceasedPetIds));
  const inactive: AccountGroup[] = memorial.map((account) => ({
    key: `memorial:${account.id}`,
    active: false,
    ownerIds: account.ownerIds,
    livePetIds: [],
    deceasedPetIds: account.petIds,
  }));
  const grouped = new Set(memorial.flatMap((a) => a.ownerIds));
  for (const owner of leftover) {
    if (grouped.has(owner.ownerId)) continue;
    inactive.push({
      key: `owner:${owner.ownerId}`,
      active: false,
      ownerIds: [owner.ownerId],
      livePetIds: [],
      deceasedPetIds: [],
    });
  }
  inactive.sort((a, b) => byString(a.key, b.key));

  return [...active, ...inactive];
}
