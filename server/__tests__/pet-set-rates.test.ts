import { describe, expect, it } from 'vitest';
import {
  buildGroupKey,
  buildMixKey,
  mixFromPetTypes,
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
    expect(buildGroupKey(['p_b', 'p_a'], null)).toBe('p_a,p_b');
    expect(buildGroupKey(['p_a', 'p_b'], null)).toBe('p_a,p_b');
  });
  it('appends the duration suffix only when a duration is given', () => {
    expect(buildGroupKey(['p_a'], 60)).toBe('p_a|60');
    expect(buildGroupKey(['p_a'], null)).toBe('p_a');
  });
  it('empties to an empty string', () => {
    expect(buildGroupKey([], 60)).toBe('');
  });
  it('dedups repeated ids so a one-pet booking cannot match a two-pet rate', () => {
    expect(buildGroupKey(['p_a', 'p_a'], null)).toBe('p_a');
  });
});

describe('resolvePetSetRate — precedence, exact match only', () => {
  const base = {
    durationMinutes: null,
    serviceType: 'walk',
    optionKey: 'w30',
    groupRates: [],
    mixRates: [],
  };

  it('prefers an exact pet-id rate over a matching species rate', () => {
    const got = resolvePetSetRate({
      ...base,
      petIds: ['p_a', 'p_b'],
      petTypes: ['dog', 'dog'],
      groupRates: [{ groupKey: 'p_a,p_b', rate: 44 }],
      mixRates: [{ mixKey: 'dog:2', rate: 35, serviceType: 'walk', optionKey: 'w30' }],
    });
    expect(got).toEqual({ source: 'group', rate: 44 });
  });

  it('falls to the species rate when no pet-id rate matches', () => {
    const got = resolvePetSetRate({
      ...base,
      petIds: ['p_c', 'p_d'],
      petTypes: ['dog', 'dog'],
      groupRates: [{ groupKey: 'p_a,p_b', rate: 44 }],
      mixRates: [{ mixKey: 'dog:2', rate: 35, serviceType: 'walk', optionKey: 'w30' }],
    });
    expect(got).toEqual({ source: 'mix', rate: 35 });
  });

  it('returns null when neither matches', () => {
    expect(resolvePetSetRate({ ...base, petIds: ['p_x'], petTypes: ['bird'] })).toBeNull();
  });

  it('NEVER scales a one-pet rate to two pets', () => {
    expect(
      resolvePetSetRate({
        ...base,
        petIds: ['p_a', 'p_b'],
        petTypes: ['dog', 'dog'],
        mixRates: [{ mixKey: 'dog:1', rate: 20, serviceType: 'walk', optionKey: 'w30' }],
      }),
    ).toBeNull();
  });

  it('NEVER sums across species', () => {
    expect(
      resolvePetSetRate({
        ...base,
        petIds: ['p_a', 'p_b'],
        petTypes: ['dog', 'cat'],
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
      petIds: ['p_a', 'p_b'],
      petTypes: ['dog', 'dog'],
      serviceType: 'walk',
      optionKey: 'w30',
      mixRates,
    });
    expect(got).toEqual({ source: 'mix', rate: 35 });

    // And a service/option combo with no matching rate resolves to null, not a mismatched hit.
    expect(
      resolvePetSetRate({
        ...base,
        petIds: ['p_a', 'p_b'],
        petTypes: ['dog', 'dog'],
        serviceType: 'walk',
        optionKey: 'w60',
        mixRates,
      }),
    ).toBeNull();
  });

  it('does not match a subset or superset group', () => {
    const groupRates = [{ groupKey: 'p_a,p_b', rate: 44 }];
    expect(
      resolvePetSetRate({ ...base, petIds: ['p_a'], petTypes: ['dog'], groupRates }),
    ).toBeNull();
    expect(
      resolvePetSetRate({
        ...base,
        petIds: ['p_a', 'p_b', 'p_c'],
        petTypes: ['dog', 'dog', 'dog'],
        groupRates,
      }),
    ).toBeNull();
  });

  it('respects the duration suffix — a 60-min group rate does not price a 30-min booking', () => {
    const groupRates = [{ groupKey: 'p_a|60', rate: 40 }];
    expect(
      resolvePetSetRate({
        ...base,
        petIds: ['p_a'],
        petTypes: ['dog'],
        durationMinutes: 60,
        groupRates,
      }),
    ).toEqual({ source: 'group', rate: 40 });
    expect(
      resolvePetSetRate({
        ...base,
        petIds: ['p_a'],
        petTypes: ['dog'],
        durationMinutes: 30,
        groupRates,
      }),
    ).toBeNull();
  });

  it('returns null for an empty pet set', () => {
    expect(
      resolvePetSetRate({
        ...base,
        petIds: [],
        petTypes: [],
        mixRates: [{ mixKey: 'dog:1', rate: 20, serviceType: 'walk', optionKey: 'w30' }],
      }),
    ).toBeNull();
  });
});
