import { describe, expect, it } from 'vitest';
import {
  buildCapacity,
  rangeHasConflict,
  type CapacityEvent,
  type CapacityRequest,
} from '../../src/shared/index.js';

const boarding = (
  start: string,
  end: string,
  serviceType = 'boarding',
  petCount = 1,
): CapacityEvent => ({ start_date: start, end_date: end, kind: 'boarding', serviceType, petCount });
const houseSit = (
  start: string,
  end: string,
  serviceType = 'housesitting',
  petCount = 1,
): CapacityEvent => ({ start_date: start, end_date: end, kind: 'housesit', serviceType, petCount });
const blocked = (start: string, end: string): CapacityEvent => ({
  start_date: start,
  end_date: end,
  kind: 'blocked',
});

const req = (over: Partial<CapacityRequest> = {}): CapacityRequest => ({
  serviceType: 'boarding',
  kind: 'boarding',
  cap: null,
  petCount: 1,
  ...over,
});

describe('rangeHasConflict with per-service CapacityRequest', () => {
  it('null cap auto-passes-through (many overlaps, no limit)', () => {
    const cap = buildCapacity([
      boarding('2028-08-01', '2028-08-10', 'boarding', 5),
      boarding('2028-08-01', '2028-08-10', 'boarding', 9),
    ]);
    expect(rangeHasConflict('2028-08-02', '2028-08-06', req({ petCount: 7 }), cap)).toBe(false);
  });

  it('still blocks admin-blocked dates even when unlimited', () => {
    const cap = buildCapacity([blocked('2028-08-03', '2028-08-05')]);
    expect(rangeHasConflict('2028-08-01', '2028-08-06', req(), cap)).toBe(true);
  });

  it("enforces the request's own boarding cap incl. petCount math", () => {
    const cap = buildCapacity([boarding('2028-08-01', '2028-08-05', 'boarding', 2)]);
    // 2 already boarding mid-range: 1 more fits (2+1<=3), 2 more do not (2+2>3).
    expect(rangeHasConflict('2028-08-02', '2028-08-04', req({ cap: 3, petCount: 1 }), cap)).toBe(
      false,
    );
    expect(rangeHasConflict('2028-08-02', '2028-08-04', req({ cap: 3, petCount: 2 }), cap)).toBe(
      true,
    );
  });

  it('two boarding-kind services do NOT share a pool', () => {
    // Service A is completely full on these dates…
    const cap = buildCapacity([boarding('2028-08-01', '2028-08-05', 'boarding', 2)]);
    const full = req({ serviceType: 'boarding', cap: 2, petCount: 1 });
    expect(rangeHasConflict('2028-08-02', '2028-08-04', full, cap)).toBe(true);
    // …but service B (kitty-condo) with its own cap 2 still books the same dates.
    const other = req({ serviceType: 'kitty-condo', cap: 2, petCount: 1 });
    expect(rangeHasConflict('2028-08-02', '2028-08-04', other, cap)).toBe(false);
  });

  it('two housesit-kind services keep independent pools', () => {
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-04', 'housesitting')]);
    const sameService: CapacityRequest = { serviceType: 'housesitting', kind: 'housesit', cap: 1 };
    const otherService: CapacityRequest = {
      serviceType: 'overnight-sit',
      kind: 'housesit',
      cap: 1,
    };
    expect(rangeHasConflict('2028-09-02', '2028-09-03', sameService, cap)).toBe(true);
    expect(rangeHasConflict('2028-09-02', '2028-09-03', otherService, cap)).toBe(false);
  });

  it('rejects more pets than the cap even on an EMPTY calendar (standalone over-cap guard)', () => {
    const empty = buildCapacity([]);
    expect(rangeHasConflict('2028-08-02', '2028-08-04', req({ cap: 3, petCount: 5 }), empty)).toBe(
      true,
    );
    expect(rangeHasConflict('2028-08-02', '2028-08-04', req({ cap: 3, petCount: 3 }), empty)).toBe(
      false,
    );
    expect(
      rangeHasConflict('2028-08-02', '2028-08-04', req({ cap: null, petCount: 99 }), empty),
    ).toBe(false);
  });

  it('shares a boundary day (soft bookend) under a per-service cap', () => {
    const cap = buildCapacity([boarding('2028-08-01', '2028-08-03', 'boarding', 2)]);
    expect(rangeHasConflict('2028-08-03', '2028-08-05', req({ cap: 2, petCount: 2 }), cap)).toBe(
      false,
    );
  });

  it('house-sit cap counts only its own service; unlimited lets them stack', () => {
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-04')]);
    const oneSit: CapacityRequest = { serviceType: 'housesitting', kind: 'housesit', cap: 1 };
    const noCap: CapacityRequest = { serviceType: 'housesitting', kind: 'housesit', cap: null };
    expect(rangeHasConflict('2028-09-02', '2028-09-03', oneSit, cap)).toBe(true);
    expect(rangeHasConflict('2028-09-02', '2028-09-03', noCap, cap)).toBe(false);
  });

  it('the structural house-sit rule stays TENANT-WIDE: boardingTotal from ANY boarding-kind service', () => {
    // The boarding occupancy lives on a DIFFERENT boarding-kind service ('kitty-condo') than the
    // house-sit request could ever share a pool with — the ≤1-day overlap must still fire, because
    // it models the sitter's physical absence, not a pool.
    const cap = buildCapacity([boarding('2028-09-01', '2028-09-10', 'kitty-condo', 1)]);
    const sit: CapacityRequest = { serviceType: 'housesitting', kind: 'housesit', cap: null };
    expect(rangeHasConflict('2028-09-02', '2028-09-04', sit, cap)).toBe(true); // overlaps 2 days
    expect(rangeHasConflict('2028-09-01', '2028-09-02', sit, cap)).toBe(false); // exactly 1 day
  });

  it('house-sit occupancy counts PETS: a 3-pet sit fills 3 units', () => {
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-04', 'housesitting', 3)]);
    const sit = (over: Partial<CapacityRequest> = {}): CapacityRequest => ({
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: null,
      petCount: 1,
      ...over,
    });
    // cap 3 is exactly filled by the existing 3-pet sit → one more pet blocks.
    expect(rangeHasConflict('2028-09-02', '2028-09-03', sit({ cap: 3, petCount: 1 }), cap)).toBe(
      true,
    );
    // cap 4 leaves room for one more pet.
    expect(rangeHasConflict('2028-09-02', '2028-09-03', sit({ cap: 4, petCount: 1 }), cap)).toBe(
      false,
    );
  });

  it('house-sit petCount null/0 still counts as 1', () => {
    const capNull = buildCapacity([
      houseSit('2028-09-01', '2028-09-04', 'housesitting', undefined),
    ]);
    const sit: CapacityRequest = { serviceType: 'housesitting', kind: 'housesit', cap: 1 };
    // 1 existing pet (defaulted) fills cap 1 → a second 1-pet request blocks.
    expect(rangeHasConflict('2028-09-02', '2028-09-03', sit, capNull)).toBe(true);

    const capZero = buildCapacity([
      {
        start_date: '2028-10-01',
        end_date: '2028-10-04',
        kind: 'housesit',
        serviceType: 'housesitting',
        petCount: 0,
      },
    ]);
    expect(rangeHasConflict('2028-10-02', '2028-10-03', sit, capZero)).toBe(true);
  });

  it('house-sit over-cap is rejected on an EMPTY calendar (standalone guard, pets)', () => {
    const empty = buildCapacity([]);
    const sit: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: 2,
      petCount: 3,
    };
    expect(rangeHasConflict('2028-09-02', '2028-09-04', sit, empty)).toBe(true);
  });
});
