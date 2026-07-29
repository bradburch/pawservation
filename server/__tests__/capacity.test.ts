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
  overlapAllowance: 1, // the product default (Tenants.HousesitBoardingOverlapDays)
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
    const sameService: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: 1,
      overlapAllowance: 1,
    };
    const otherService: CapacityRequest = {
      serviceType: 'overnight-sit',
      kind: 'housesit',
      cap: 1,
      overlapAllowance: 1,
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
    const oneSit: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: 1,
      overlapAllowance: 1,
    };
    const noCap: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: null,
      overlapAllowance: 1,
    };
    expect(rangeHasConflict('2028-09-02', '2028-09-03', oneSit, cap)).toBe(true);
    expect(rangeHasConflict('2028-09-02', '2028-09-03', noCap, cap)).toBe(false);
  });

  it('the structural house-sit rule stays TENANT-WIDE: day.boarding.total from ANY boarding-kind service', () => {
    // The boarding occupancy lives on a DIFFERENT boarding-kind service ('kitty-condo') than the
    // house-sit request could ever share a pool with — the overlap rule must still fire, because
    // it models the sitter's physical absence, not a pool.
    const cap = buildCapacity([boarding('2028-09-01', '2028-09-10', 'kitty-condo', 1)]);
    const sit: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: null,
      overlapAllowance: 1,
    };
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
      overlapAllowance: 1,
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
    const sit: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: 1,
      overlapAllowance: 1,
    };
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

  it('cross-kind rule ignores SAME-kind occupancy entirely (only the pool cap applies)', () => {
    // Two boardings on the same days is a pure capacity question — the whereabouts rule has
    // nothing to say about it, at any allowance.
    const cap = buildCapacity([boarding('2028-09-01', '2028-09-10', 'boarding', 1)]);
    for (const allowance of [0, 1, 2, null]) {
      expect(
        rangeHasConflict(
          '2028-09-02',
          '2028-09-08',
          req({ cap: null, overlapAllowance: allowance }),
          cap,
        ),
      ).toBe(false);
    }
  });

  it('house-sit over-cap is rejected on an EMPTY calendar (standalone guard, pets)', () => {
    const empty = buildCapacity([]);
    const sit: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: 2,
      petCount: 3,
      overlapAllowance: 1,
    };
    expect(rangeHasConflict('2028-09-02', '2028-09-04', sit, empty)).toBe(true);
  });
});

/**
 * The house-sit/boarding overlap rule (0006), as a truth table — the design's §3, executable.
 *
 * The rule is TENANT-WIDE and SYMMETRIC: it models the sitter's own whereabouts (she cannot sleep
 * at a client's house and keep a boarder at her own), so it reads OPPOSITE-kind occupancy whichever
 * kind is asking. A shared day is legal only when all three hold: the running count is within
 * `overlapAllowance`; the day is an ENDPOINT of the requested range; and no opposite-kind booking
 * is mid-stay on it (the existing side of the handover). `null` = the rule does not run.
 *
 * Dates: end is EXCLUSIVE, so `Sep1 → Sep5` occupies Sep 1–4 and Sep 5 is an unoccupied checkout.
 */
describe('house-sit / boarding overlap allowance', () => {
  const bdReq = (overlapAllowance: number | null): CapacityRequest => ({
    serviceType: 'boarding',
    kind: 'boarding',
    cap: null,
    petCount: 1,
    overlapAllowance,
  });
  const hsReq = (overlapAllowance: number | null): CapacityRequest => ({
    serviceType: 'housesitting',
    kind: 'housesit',
    cap: null,
    petCount: 1,
    overlapAllowance,
  });
  /** [allowance 0, 1, 2, null] verdicts for one (existing calendar, request) pair. */
  const verdicts = (
    events: CapacityEvent[],
    start: string,
    end: string,
    request: (a: number | null) => CapacityRequest,
  ): boolean[] => {
    const cap = buildCapacity(events);
    return [0, 1, 2, null].map((a) => rangeHasConflict(start, end, request(a), cap));
  };

  it('row 1 — a boarding that STARTS the day a house sit ends does not overlap at all', () => {
    // The owner's own example. A checkout day carries no occupancy, so there is nothing to share:
    // legal even at allowance 0.
    expect(
      verdicts([houseSit('2028-09-01', '2028-09-05')], '2028-09-05', '2028-09-08', bdReq),
    ).toEqual([false, false, false, false]);
  });

  it('row 2 — boarding starting on the house sit’s LAST night: one tail-touch day', () => {
    expect(
      verdicts([houseSit('2028-09-01', '2028-09-05')], '2028-09-04', '2028-09-07', bdReq),
    ).toEqual([true, false, false, false]);
  });

  it('row 3 — the same touch with the kinds swapped (house sit over boarding)', () => {
    expect(
      verdicts([boarding('2028-09-01', '2028-09-05')], '2028-09-04', '2028-09-08', hsReq),
    ).toEqual([true, false, false, false]);
  });

  it('row 4 — the shared day may be the request’s LAST day, not just its first', () => {
    // Existing boarding starts Sep 4; the requested house sit's last occupied day is Sep 4.
    expect(
      verdicts([boarding('2028-09-04', '2028-09-09')], '2028-09-01', '2028-09-05', hsReq),
    ).toEqual([true, false, false, false]);
  });

  it('row 5 — two shared days, one of them mid-sit: refused even at allowance 2', () => {
    // Sep 4 is interior to the house sit (Sep 1–5 occupied), Sep 5 is its last night. The count
    // fits in 2, but Sep 4 has no handover on the existing side.
    expect(
      verdicts([houseSit('2028-09-01', '2028-09-06')], '2028-09-04', '2028-09-07', bdReq),
    ).toEqual([true, true, true, false]);
  });

  it('row 6 — a ONE-NIGHT boarding wholly inside a house sit is refused', () => {
    // The case the whole "endpoint of the EXISTING booking too" question turns on: a single-night
    // stay is trivially "at its own endpoint", so only the existing side's mid-stay test refuses
    // it. Without that test, allowance 1 would legalise the sitter being in two places for a night.
    expect(
      verdicts([houseSit('2028-09-01', '2028-09-10')], '2028-09-04', '2028-09-05', bdReq),
    ).toEqual([true, true, true, false]);
  });

  it('row 7 — a house sit laid across the middle of a boarding is refused', () => {
    expect(
      verdicts([boarding('2028-09-01', '2028-09-10')], '2028-09-04', '2028-09-06', hsReq),
    ).toEqual([true, true, true, false]);
  });

  it('row 8 — a long interior overlap is refused at every allowance but null', () => {
    expect(
      verdicts([houseSit('2028-09-01', '2028-09-10')], '2028-09-03', '2028-09-08', bdReq),
    ).toEqual([true, true, true, false]);
  });

  it('row 9 — a stay wedged between two house sits needs allowance 2', () => {
    // Sep 4 is house sit A's last night (we arrive as A departs) and Sep 5 is house sit B's first
    // (we depart as B arrives). Two real handovers — exactly what "one at each end" buys.
    const events = [houseSit('2028-09-01', '2028-09-05'), houseSit('2028-09-05', '2028-09-09')];
    expect(verdicts(events, '2028-09-04', '2028-09-06', bdReq)).toEqual([true, true, false, false]);
  });

  it('a day where one boarding is finishing and another is mid-stay is NOT a handover', () => {
    // The handover test is "EVERY opposite-kind booking here departs", not "one of them does":
    // `departing` and `events` are both counted per event, so a tail that happens to coincide with
    // another stay's middle does not excuse the overlap.
    const events = [
      boarding('2028-09-01', '2028-09-05', 'boarding'),
      boarding('2028-09-01', '2028-09-10', 'kitty-condo'),
    ];
    expect(verdicts(events, '2028-09-04', '2028-09-07', hsReq)).toEqual([true, true, true, false]);
  });

  it('the rule is TENANT-WIDE: occupancy on ANY service of the opposite kind counts', () => {
    // A boarding-kind service the house sit could never share a pool with still blocks it.
    expect(
      verdicts(
        [boarding('2028-09-01', '2028-09-10', 'kitty-condo')],
        '2028-09-02',
        '2028-09-04',
        hsReq,
      ),
    ).toEqual([true, true, true, false]);
  });

  it('bookend sharing still works underneath the rule: same-kind cap, cross-kind tail', () => {
    // A full 2-pet boarding ending Sep 4 (checkout) plus a house sit whose last night is Sep 3.
    // The request's first day is Sep 3: shared with the sit's tail (allowed at 1) and with the
    // full boarding's own bookend (allowed by boundary sharing). Both rules pass at once.
    const events = [
      boarding('2028-09-01', '2028-09-04', 'boarding', 2),
      houseSit('2028-09-01', '2028-09-04', 'housesitting'),
    ];
    const request: CapacityRequest = {
      serviceType: 'boarding',
      kind: 'boarding',
      cap: 2,
      petCount: 2,
      overlapAllowance: 1,
    };
    expect(rangeHasConflict('2028-09-03', '2028-09-06', request, buildCapacity(events))).toBe(
      false,
    );
  });

  it('a stay laid exactly ON TOP of an opposite-kind stay is refused at EVERY allowance', () => {
    // Both days of a two-night request are its own endpoints, so an "is it an endpoint" test alone
    // would call this a pair of legal tail touches at allowance 2 — a total double booking. The
    // handover test refuses it: on Sep 4 we arrive but the house sit does not depart, and on Sep 5
    // we depart but it does not arrive.
    const events = [houseSit('2028-09-04', '2028-09-06')];
    expect(verdicts(events, '2028-09-04', '2028-09-06', bdReq)).toEqual([true, true, true, false]);
    // …and the same in the other direction.
    expect(
      verdicts([boarding('2028-09-04', '2028-09-06')], '2028-09-04', '2028-09-06', hsReq),
    ).toEqual([true, true, true, false]);
  });

  it('a single interior day is refused even though the COUNT allows it', () => {
    // The pre-0006 rule counted days and nothing else, so this one-night house sit dropped into the
    // middle of a nine-night boarding passed at "≤ 1 day". It is not a handover: the boarding
    // neither arrives nor departs on Sep 5.
    expect(
      verdicts([boarding('2028-09-01', '2028-09-10')], '2028-09-05', '2028-09-06', hsReq),
    ).toEqual([true, true, true, false]);
  });

  it('an allowance that is not a number reads as 0, never as "no limit"', () => {
    // Only reachable from an untyped caller (an out-of-tree mirror of this engine, or a tenant row
    // deserialized before the column existed). The refusing branch is the safe one.
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-05')]);
    const stale = { ...bdReq(1), overlapAllowance: undefined as unknown as number };
    expect(rangeHasConflict('2028-09-04', '2028-09-07', stale, cap)).toBe(true);
  });

  it('allowance 0 refuses a single shared day but never a mere adjacency', () => {
    const events = [houseSit('2028-09-01', '2028-09-05')];
    expect(verdicts(events, '2028-09-04', '2028-09-06', bdReq)[0]).toBe(true); // shares Sep 4
    expect(verdicts(events, '2028-09-05', '2028-09-08', bdReq)[0]).toBe(false); // starts at checkout
  });
});
