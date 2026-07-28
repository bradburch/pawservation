import { describe, expect, it } from 'vitest';
import { groupIntoAccounts, type OwnerPetSets } from '../../src/shared/index.js';

/** Terser fixtures: an owner with only living pets, or only dead ones. */
const live = (ownerId: string, ...livePetIds: string[]): OwnerPetSets => ({
  ownerId,
  livePetIds,
  deceasedPetIds: [],
});

describe('groupIntoAccounts (renderable accounts on top of buildAccounts)', () => {
  it('merges two owners who share ONE living pet into one active account', () => {
    expect(
      groupIntoAccounts([live('u_ann', 'p_bella'), live('u_bob', 'p_bella', 'p_chip')]),
    ).toEqual([
      {
        key: 'account:p_bella',
        active: true,
        ownerIds: ['u_ann', 'u_bob'],
        livePetIds: ['p_bella', 'p_chip'],
        deceasedPetIds: [],
      },
    ]);
  });

  it('keeps disjoint owners in separate accounts', () => {
    const groups = groupIntoAccounts([live('u_ann', 'p_bella'), live('u_bob', 'p_chip')]);
    expect(groups.map((g) => g.ownerIds)).toEqual([['u_ann'], ['u_bob']]);
    expect(groups.every((g) => g.active)).toBe(true);
  });

  // Rule 2: the union-find never sees a dead pet, but the card still has to show it.
  it('attaches a deceased pet to the account of its still-active owner', () => {
    const groups = groupIntoAccounts([
      { ownerId: 'u_ann', livePetIds: ['p_bella'], deceasedPetIds: ['p_gus'] },
    ]);
    expect(groups).toEqual([
      {
        key: 'account:p_bella',
        active: true,
        ownerIds: ['u_ann'],
        livePetIds: ['p_bella'],
        deceasedPetIds: ['p_gus'],
      },
    ]);
  });

  // Rule 3: THE trap. A shared pet that has died must not merge two households' billing.
  it('does NOT let a shared DECEASED pet fuse two active accounts', () => {
    const groups = groupIntoAccounts([
      { ownerId: 'u_ann', livePetIds: ['p_bella'], deceasedPetIds: ['p_gus'] },
      { ownerId: 'u_bob', livePetIds: ['p_chip'], deceasedPetIds: ['p_gus'] },
    ]);
    expect(groups).toHaveLength(2);
    // Rule 6: it is shown on BOTH cards, because both households owned him.
    expect(groups.map((g) => g.deceasedPetIds)).toEqual([['p_gus'], ['p_gus']]);
  });

  // Rule 4: an owner with zero living pets is in NO account — they must still get a card.
  it('gives an owner whose only pet has died a "no active pets" card holding that pet', () => {
    expect(
      groupIntoAccounts([{ ownerId: 'u_ann', livePetIds: [], deceasedPetIds: ['p_gus'] }]),
    ).toEqual([
      {
        key: 'memorial:p_gus',
        active: false,
        ownerIds: ['u_ann'],
        livePetIds: [],
        deceasedPetIds: ['p_gus'],
      },
    ]);
  });

  it('keeps two owners of the same deceased pet in ONE inactive card, not two', () => {
    const groups = groupIntoAccounts([
      { ownerId: 'u_ann', livePetIds: [], deceasedPetIds: ['p_gus'] },
      { ownerId: 'u_bob', livePetIds: [], deceasedPetIds: ['p_gus'] },
    ]);
    expect(groups).toEqual([
      {
        key: 'memorial:p_gus',
        active: false,
        ownerIds: ['u_ann', 'u_bob'],
        livePetIds: [],
        deceasedPetIds: ['p_gus'],
      },
    ]);
  });

  // Rule 5: reachable in production — DELETE .../pets/:petId removes a customer's LAST pet.
  it('gives an owner with no pets at all their own empty card', () => {
    expect(groupIntoAccounts([{ ownerId: 'u_ann', livePetIds: [], deceasedPetIds: [] }])).toEqual([
      {
        key: 'owner:u_ann',
        active: false,
        ownerIds: ['u_ann'],
        livePetIds: [],
        deceasedPetIds: [],
      },
    ]);
  });

  it('returns active accounts first and is order-independent', () => {
    const owners: OwnerPetSets[] = [
      { ownerId: 'u_zoe', livePetIds: [], deceasedPetIds: [] },
      { ownerId: 'u_ann', livePetIds: ['p_bella'], deceasedPetIds: [] },
      { ownerId: 'u_bob', livePetIds: [], deceasedPetIds: ['p_gus'] },
    ];
    const keys = groupIntoAccounts(owners).map((g) => g.key);
    expect(keys).toEqual(['account:p_bella', 'memorial:p_gus', 'owner:u_zoe']);
    expect(groupIntoAccounts([...owners].reverse()).map((g) => g.key)).toEqual(keys);
  });

  it('returns nothing for no owners', () => {
    expect(groupIntoAccounts([])).toEqual([]);
  });
});
