/**
 * Union-find over the owner<->pet graph: each connected component is one BILLING ACCOUNT.
 * Two customers who share a single pet are one household and get one statement.
 *
 * Pure and dependency-free (src/shared/ rules). Two things live deliberately OUTSIDE this module:
 *
 *  - **Deceased pets.** The caller filters them out of `links` (the repo does it in SQL), so this
 *    module never learns that a `DeceasedAt` column exists.
 *  - **A "drop components with no owners or no pets" rule.** The input is EDGES, so every component
 *    has at least one owner and at least one pet by construction; such a filter could never fire.
 *
 * The account id is the lexicographically-first pet id in the component, because the invoice number
 * is keyed off exactly that value — there is no second identity to reconcile. Output is fully
 * sorted (accounts by id, and both id lists within each account) so identical links always produce
 * byte-identical accounts, however the rows arrived.
 */

/** One owner<->pet edge. Both ids are opaque strings; this module never parses them. */
export type OwnerPetLink = { ownerId: string; petId: string };

/** A connected component: every owner and every pet that bill together. */
export type Account = { id: string; ownerIds: string[]; petIds: string[] };

export function buildAccounts(links: OwnerPetLink[]): Account[] {
  // Owners and pets share one disjoint-set forest. Keys are namespaced ('o:' / 'p:') so an owner id
  // that happens to equal a pet id can never fuse two unrelated accounts.
  const parent = new Map<string, string>();

  const add = (key: string): void => {
    if (!parent.has(key)) parent.set(key, key);
  };

  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression: point every node on the walk straight at the root.
    let node = key;
    while (node !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const link of links) {
    const ownerKey = `o:${link.ownerId}`;
    const petKey = `p:${link.petId}`;
    add(ownerKey);
    add(petKey);
    union(ownerKey, petKey);
  }

  const groups = new Map<string, { ownerIds: string[]; petIds: string[] }>();
  for (const key of parent.keys()) {
    const root = find(key);
    const group = groups.get(root) ?? { ownerIds: [], petIds: [] };
    if (key.startsWith('o:')) group.ownerIds.push(key.slice(2));
    else group.petIds.push(key.slice(2));
    groups.set(root, group);
  }

  return [...groups.values()]
    .map((group) => {
      const petIds = [...group.petIds].sort();
      return { id: petIds[0]!, ownerIds: [...group.ownerIds].sort(), petIds };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
