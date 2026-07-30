import { describe, expect, it } from 'vitest';
import {
  buildGroupKey,
  buildMixKey,
  mixFromPetTypes,
  parseMixKey,
  petCountOf,
  resolvePetSetRate,
} from '../../src/shared/index.js';

describe('buildMixKey', () => {
  it('sorts species so one mix yields one key', () => {
    expect(buildMixKey({ dog: 2, cat: 1 })).toBe('cat:1|dog:2');
    expect(buildMixKey({ cat: 1, dog: 2 })).toBe('cat:1|dog:2');
  });
  it('renders a single species without a separator', () => {
    expect(buildMixKey({ dog: 2 })).toBe('dog:2');
  });
  it('drops non-positive counts and empties to an empty string', () => {
    expect(buildMixKey({ dog: 2, cat: 0 })).toBe('dog:2');
    expect(buildMixKey({})).toBe('');
  });
  it('drops negative counts', () => {
    expect(buildMixKey({ dog: 2, cat: -1 })).toBe('dog:2');
  });
  it('drops non-integer counts', () => {
    expect(buildMixKey({ dog: 1.5, cat: 1 })).toBe('cat:1');
  });
  it('empties when all counts are invalid', () => {
    expect(buildMixKey({ dog: -1, cat: 1.5 })).toBe('');
  });
});

describe('mixFromPetTypes / petCountOf', () => {
  it('tallies species and totals counts', () => {
    expect(mixFromPetTypes(['dog', 'dog', 'cat'])).toEqual({ dog: 2, cat: 1 });
    expect(petCountOf({ dog: 2, cat: 1 })).toBe(3);
    expect(mixFromPetTypes([])).toEqual({});
    expect(petCountOf({})).toBe(0);
  });

  it('is not corrupted by a species slug that collides with an Object.prototype member', () => {
    // 'constructor' is a reachable species slug (slugifyServiceLabel allows [a-z0-9-]+). A
    // {}-literal accumulator resolves `mix['constructor']` through the prototype chain instead
    // of setting an own property, silently dropping the third pet from the mix.
    const mix = mixFromPetTypes(['dog', 'dog', 'constructor']);
    expect(buildMixKey(mix)).toBe('constructor:1|dog:2');
    expect(petCountOf(mix)).toBe(3);
  });
});

describe('buildGroupKey', () => {
  it('sorts pet ids so selection order does not matter', () => {
    expect(buildGroupKey(['p_b', 'p_a'])).toBe('p_a,p_b');
    expect(buildGroupKey(['p_a', 'p_b'])).toBe('p_a,p_b');
  });
  it('empties to an empty string', () => {
    expect(buildGroupKey([])).toBe('');
  });
  it('dedups repeated ids so a one-pet booking cannot match a two-pet rate', () => {
    expect(buildGroupKey(['p_a', 'p_a'])).toBe('p_a');
  });
});

describe('resolvePetSetRate — precedence, exact match only', () => {
  const base = {
    serviceType: 'walk',
    optionKey: 'w30',
    groupRates: [],
    mixRates: [],
  };

  it('prefers an exact pet-id rate over a matching species rate', () => {
    const got = resolvePetSetRate({
      ...base,
      pets: [
        { id: 'p_a', petType: 'dog' },
        { id: 'p_b', petType: 'dog' },
      ],
      groupRates: [{ groupKey: 'p_a,p_b', rate: 44, serviceType: 'walk', optionKey: 'w30' }],
      mixRates: [{ mixKey: 'dog:2', rate: 35, serviceType: 'walk', optionKey: 'w30' }],
    });
    expect(got).toEqual({ source: 'group', rate: 44 });
  });

  it('falls to the species rate when no pet-id rate matches', () => {
    const got = resolvePetSetRate({
      ...base,
      pets: [
        { id: 'p_c', petType: 'dog' },
        { id: 'p_d', petType: 'dog' },
      ],
      groupRates: [{ groupKey: 'p_a,p_b', rate: 44, serviceType: 'walk', optionKey: 'w30' }],
      mixRates: [{ mixKey: 'dog:2', rate: 35, serviceType: 'walk', optionKey: 'w30' }],
    });
    expect(got).toEqual({ source: 'mix', rate: 35 });
  });

  it('returns null when neither matches', () => {
    expect(resolvePetSetRate({ ...base, pets: [{ id: 'p_x', petType: 'bird' }] })).toBeNull();
  });

  it('NEVER scales a one-pet rate to two pets', () => {
    expect(
      resolvePetSetRate({
        ...base,
        pets: [
          { id: 'p_a', petType: 'dog' },
          { id: 'p_b', petType: 'dog' },
        ],
        mixRates: [{ mixKey: 'dog:1', rate: 20, serviceType: 'walk', optionKey: 'w30' }],
      }),
    ).toBeNull();
  });

  it('stays a pure EXACT-MATCH resolver even though PetRateMode exists (0005)', () => {
    // The per-service multiplier lives in `estimateCost` (server-only), never here. This module
    // has no mode parameter, no fallback and no arithmetic: given a two-dog set and only a
    // one-dog rate it returns null in every world, and it is `estimateCost` — reading the
    // sitter's stored mode — that decides whether null means "refuse" or "x2".
    const args = {
      ...base,
      pets: [
        { id: 'p_a', petType: 'dog' },
        { id: 'p_b', petType: 'dog' },
      ],
      mixRates: [{ mixKey: 'dog:1', rate: 20, serviceType: 'walk', optionKey: 'w30' }],
    };
    expect(resolvePetSetRate(args)).toBeNull();
    // A stray mode-shaped argument cannot change the answer — there is nothing to change it with.
    expect(resolvePetSetRate({ ...args, petRateMode: 'linear' } as typeof args)).toBeNull();
    // And the exported signature takes exactly these five keys; a sixth would be a design change.
    expect(Object.keys(args).sort()).toEqual([
      'groupRates',
      'mixRates',
      'optionKey',
      'pets',
      'serviceType',
    ]);
  });

  it('NEVER sums across species', () => {
    expect(
      resolvePetSetRate({
        ...base,
        pets: [
          { id: 'p_a', petType: 'dog' },
          { id: 'p_b', petType: 'cat' },
        ],
        mixRates: [
          { mixKey: 'dog:1', rate: 20, serviceType: 'walk', optionKey: 'w30' },
          { mixKey: 'cat:1', rate: 15, serviceType: 'walk', optionKey: 'w30' },
        ],
      }),
    ).toBeNull();
  });

  it('does not select a same-mixKey rate scoped to a different service or option', () => {
    // Same tenant, same mixKey (`dog:2`), two unrelated rates: boarding/standard = $80,
    // walk/w30 = $35. Resolving the walk booking must get $35 — the scope check is what
    // prevents a tenant-wide `.find()` from matching whichever row happens to come first.
    const mixRates = [
      { mixKey: 'dog:2', rate: 80, serviceType: 'boarding', optionKey: 'standard' },
      { mixKey: 'dog:2', rate: 35, serviceType: 'walk', optionKey: 'w30' },
    ];
    const got = resolvePetSetRate({
      ...base,
      pets: [
        { id: 'p_a', petType: 'dog' },
        { id: 'p_b', petType: 'dog' },
      ],
      serviceType: 'walk',
      optionKey: 'w30',
      mixRates,
    });
    expect(got).toEqual({ source: 'mix', rate: 35 });

    // And a service/option combo with no matching rate resolves to null, not a mismatched hit.
    expect(
      resolvePetSetRate({
        ...base,
        pets: [
          { id: 'p_a', petType: 'dog' },
          { id: 'p_b', petType: 'dog' },
        ],
        serviceType: 'walk',
        optionKey: 'w60',
        mixRates,
      }),
    ).toBeNull();
  });

  it('does not match a subset or superset group', () => {
    const groupRates = [{ groupKey: 'p_a,p_b', rate: 44, serviceType: 'walk', optionKey: 'w30' }];
    expect(
      resolvePetSetRate({ ...base, pets: [{ id: 'p_a', petType: 'dog' }], groupRates }),
    ).toBeNull();
    expect(
      resolvePetSetRate({
        ...base,
        pets: [
          { id: 'p_a', petType: 'dog' },
          { id: 'p_b', petType: 'dog' },
          { id: 'p_c', petType: 'dog' },
        ],
        groupRates,
      }),
    ).toBeNull();
  });

  it('does not select a same-groupKey rate scoped to a different OptionKey', () => {
    // The exact bug this amendment fixes: two options of one service ("Morning 30" / "Evening
    // 30") can share a duration, so a duration suffix alone could not tell them apart and one
    // option's group rate would silently price the other. OptionKey must be checked.
    const groupRates = [{ groupKey: 'p_a,p_b', rate: 44, serviceType: 'walk', optionKey: 'w30' }];
    expect(
      resolvePetSetRate({
        ...base,
        pets: [
          { id: 'p_a', petType: 'dog' },
          { id: 'p_b', petType: 'dog' },
        ],
        serviceType: 'walk',
        optionKey: 'w30-evening',
        groupRates,
      }),
    ).toBeNull();
    expect(
      resolvePetSetRate({
        ...base,
        pets: [
          { id: 'p_a', petType: 'dog' },
          { id: 'p_b', petType: 'dog' },
        ],
        serviceType: 'walk',
        optionKey: 'w30',
        groupRates,
      }),
    ).toEqual({ source: 'group', rate: 44 });
  });

  it('does not select a same-groupKey rate scoped to a different ServiceType', () => {
    const groupRates = [
      { groupKey: 'p_a,p_b', rate: 44, serviceType: 'walk', optionKey: 'standard' },
    ];
    expect(
      resolvePetSetRate({
        ...base,
        pets: [
          { id: 'p_a', petType: 'dog' },
          { id: 'p_b', petType: 'dog' },
        ],
        serviceType: 'boarding',
        optionKey: 'standard',
        groupRates,
      }),
    ).toBeNull();
  });

  it('returns null for an empty pet set', () => {
    expect(
      resolvePetSetRate({
        ...base,
        pets: [],
        mixRates: [{ mixKey: 'dog:1', rate: 20, serviceType: 'walk', optionKey: 'w30' }],
      }),
    ).toBeNull();
  });
});

describe('resolvePetSetRate — one correlated pet array (no id/type desync)', () => {
  const mixRates = [{ mixKey: 'dog:2', rate: 60, serviceType: 'walk', optionKey: 'd30' }];

  it('a repeated pet is ONE pet on BOTH keys — it cannot manufacture a two-dog match', () => {
    const res = resolvePetSetRate({
      pets: [
        { id: 'p_a', petType: 'dog' },
        { id: 'p_a', petType: 'dog' },
      ],
      serviceType: 'walk',
      optionKey: 'd30',
      groupRates: [],
      mixRates,
    });
    // Before this change the group key deduped to 'p_a' while the mix key still read 'dog:2',
    // and this returned the $60 two-dog rate for a single dog.
    expect(res).toBeNull();
  });

  it('two DIFFERENT pets of the same species still count as two', () => {
    const res = resolvePetSetRate({
      pets: [
        { id: 'p_a', petType: 'dog' },
        { id: 'p_b', petType: 'dog' },
      ],
      serviceType: 'walk',
      optionKey: 'd30',
      groupRates: [],
      mixRates,
    });
    expect(res).toEqual({ source: 'mix', rate: 60 });
  });

  it('dedup keeps the FIRST occurrence, so a corrupt repeat cannot change the species', () => {
    const res = resolvePetSetRate({
      pets: [
        { id: 'p_a', petType: 'dog' },
        { id: 'p_a', petType: 'cat' },
      ],
      serviceType: 'walk',
      optionKey: 'd30',
      groupRates: [{ groupKey: 'p_a', rate: 15, serviceType: 'walk', optionKey: 'd30' }],
      mixRates,
    });
    expect(res).toEqual({ source: 'group', rate: 15 });
  });
});

describe('parseMixKey', () => {
  it('inverts buildMixKey', () => {
    expect(parseMixKey('cat:1|dog:2')).toEqual({ cat: 1, dog: 2 });
    expect(buildMixKey(parseMixKey('cat:1|dog:2'))).toBe('cat:1|dog:2');
  });

  it('returns an empty mix for the empty key', () => {
    expect(Object.keys(parseMixKey(''))).toHaveLength(0);
  });

  it('rebuild equality rejects every non-canonical key', () => {
    // Wrong order, zero/negative/float counts, duplicate species, malformed parts:
    for (const bad of [
      'dog:2|cat:1',
      'dog:0',
      'dog:-1',
      'dog:1.5',
      'dog:1|dog:2',
      'dog',
      ':2',
      'dog:x',
    ]) {
      expect(buildMixKey(parseMixKey(bad))).not.toBe(bad);
    }
  });

  it('returns a null-prototype record, so a species slugged "constructor" is an own property', () => {
    const mix = parseMixKey('constructor:2');
    expect(mix['constructor']).toBe(2);
    expect(buildMixKey(mix)).toBe('constructor:2');
  });
});
