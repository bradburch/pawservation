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

  it('drops an owner entirely when their only pet is absent (the deceased-pet case)', () => {
    // The CALLER filters deceased pets out of the input, so u_bob's only link never arrives and
    // his zero-pet component cannot exist — no filter inside the function can or should fire.
    const links: OwnerPetLink[] = [{ ownerId: 'u_ann', petId: 'p_bella' }];
    const accounts = buildAccounts(links);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.ownerIds).toEqual(['u_ann']);
    expect(accounts.some((a) => a.ownerIds.includes('u_bob'))).toBe(false);
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
