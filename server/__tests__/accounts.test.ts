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
    // The same chain walked from the far end: the links that fuse two ALREADY-MERGED components
    // arrive last here and first there, so this also pins that find() resolves through a multi-node
    // parent walk rather than one level of indirection.
    expect(buildAccounts([...chain].reverse())).toEqual(expected);
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
