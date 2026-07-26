import { describe, expect, it } from 'vitest';
import { buildAccounts, type OwnerPetLink } from '../../src/shared/index.js';

describe('buildAccounts (union-find over owner<->pet links)', () => {
  it('merges two owners who share ONE pet into a single account', () => {
    const links: OwnerPetLink[] = [
      { ownerId: 'u_ann', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'p_chip' },
    ];
    expect(buildAccounts(links)).toEqual([
      { id: 'p_bella', ownerIds: ['u_ann', 'u_bob'], petIds: ['p_bella', 'p_chip'] },
    ]);
  });

  it('keeps disjoint owners in separate accounts', () => {
    const links: OwnerPetLink[] = [
      { ownerId: 'u_ann', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'p_chip' },
    ];
    expect(buildAccounts(links)).toEqual([
      { id: 'p_bella', ownerIds: ['u_ann'], petIds: ['p_bella'] },
      { id: 'p_chip', ownerIds: ['u_bob'], petIds: ['p_chip'] },
    ]);
  });

  it('merges a TRANSITIVE chain — ann-bella-bob-chip-cara-dot-dave — into one account', () => {
    // The multi-hop property, and the whole reason this is union-find rather than "group by pet":
    // ann and dave share no pet, no owner and no direct link, yet they bill together because a
    // chain of shared pets connects them. Every invoice in PRs 2-5 is computed per account, so a
    // merge that stopped at one hop would split one household's statement into four.
    const chain: OwnerPetLink[] = [
      { ownerId: 'u_ann', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'p_chip' },
      { ownerId: 'u_cara', petId: 'p_chip' },
      { ownerId: 'u_cara', petId: 'p_dot' },
      { ownerId: 'u_dave', petId: 'p_dot' },
    ];
    const expected = [
      {
        id: 'p_bella',
        ownerIds: ['u_ann', 'u_bob', 'u_cara', 'u_dave'],
        petIds: ['p_bella', 'p_chip', 'p_dot'],
      },
    ];
    expect(buildAccounts(chain)).toEqual(expected);
    // The same chain walked from the far end. Every link introduces exactly one new node in EITHER
    // direction, so this is not about fusing components (see the next test for that) — it pins that
    // the answer does not depend on which end of the chain the rows arrived from, which is what
    // makes the account id stable when the repo's ORDER BY changes.
    expect(buildAccounts([...chain].reverse())).toEqual(expected);
  });

  it('fuses two already-multi-node components when a single late link bridges them', () => {
    // Distinct from the chain above: the first four links build two SEPARATE 3-node components, and
    // only the last one bridges them. That link is the case where union() is handed two nodes that
    // are each already deep in a tree, so it must union their ROOTS — resolving only one level of
    // indirection would merge two subtrees and strand the rest.
    const accounts = buildAccounts([
      { ownerId: 'u_ann', petId: 'p_bella' }, // component A: ann - bella - bob
      { ownerId: 'u_bob', petId: 'p_bella' },
      { ownerId: 'u_cara', petId: 'p_chip' }, // component B: cara - chip - dave
      { ownerId: 'u_dave', petId: 'p_chip' },
      { ownerId: 'u_bob', petId: 'p_chip' }, // the bridge: A and B are one household
    ]);
    expect(accounts).toEqual([
      {
        id: 'p_bella',
        ownerIds: ['u_ann', 'u_bob', 'u_cara', 'u_dave'],
        petIds: ['p_bella', 'p_chip'],
      },
    ]);
  });

  it('uses the lexicographically-first pet id as the account id, whatever the input order', () => {
    const forward = buildAccounts([
      { ownerId: 'u_ann', petId: 'p_zeta' },
      { ownerId: 'u_ann', petId: 'p_alpha' },
    ]);
    const reversed = buildAccounts([
      { ownerId: 'u_ann', petId: 'p_alpha' },
      { ownerId: 'u_ann', petId: 'p_zeta' },
    ]);
    expect(forward[0]!.id).toBe('p_alpha');
    expect(forward).toEqual(reversed);
  });

  it('is deterministic under shuffled input and duplicate links', () => {
    const a = buildAccounts([
      { ownerId: 'u_bob', petId: 'p_chip' },
      { ownerId: 'u_ann', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'p_bella' },
    ]);
    const b = buildAccounts([
      { ownerId: 'u_bob', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'p_chip' },
      { ownerId: 'u_ann', petId: 'p_bella' },
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual([
      { id: 'p_bella', ownerIds: ['u_ann', 'u_bob'], petIds: ['p_bella', 'p_chip'] },
    ]);
  });

  it('returns an empty array for no links', () => {
    expect(buildAccounts([])).toEqual([]);
  });

  it('an owner id equal to a pet id does not merge two accounts', () => {
    // Owner and pet keys are namespaced internally, so a shared string is not a shared node.
    const accounts = buildAccounts([
      { ownerId: 'x', petId: 'p_bella' },
      { ownerId: 'u_bob', petId: 'x' },
    ]);
    expect(accounts).toEqual([
      { id: 'p_bella', ownerIds: ['x'], petIds: ['p_bella'] },
      { id: 'x', ownerIds: ['u_bob'], petIds: ['x'] },
    ]);
  });
});
