import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildCapacity,
  isWellFormedCapacityEvent,
  rangeConflictReason,
  rangeHasConflict,
  whereaboutsDayBlocked,
  type CapacityEvent,
  type CapacityRequest,
  type PoolKind,
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
    // POOLS ONLY, so the whereabouts rule is switched off (`overlapAllowance: null`). With it ON,
    // both of these are refused whatever the caps say — a night holds one house sit, and it is
    // tenant-wide, so a second housesit-kind SERVICE is no escape either. That is the point of
    // the `a night holds at most ONE house sit` suite below; here the question is the pool.
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-04', 'housesitting')]);
    const sameService: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: 1,
      overlapAllowance: null,
    };
    const otherService: CapacityRequest = {
      serviceType: 'overnight-sit',
      kind: 'housesit',
      cap: 1,
      overlapAllowance: null,
    };
    expect(rangeHasConflict('2028-09-02', '2028-09-03', sameService, cap)).toBe(true);
    expect(rangeHasConflict('2028-09-02', '2028-09-03', otherService, cap)).toBe(false);
    // …and with the rule running, the pool answer stops mattering: both refuse.
    expect(
      rangeHasConflict('2028-09-02', '2028-09-03', { ...otherService, overlapAllowance: 1 }, cap),
    ).toBe(true);
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

  it('a full stay CHECKS OUT into the next request: the checkout day frees the pool', () => {
    // Aug 1→3 occupies the nights of the 1st and the 2nd; the 3rd is checkout, with no overnight,
    // so the pool is genuinely empty that night and a cap-filling 2-pet request starts on it.
    const cap = buildCapacity([boarding('2028-08-01', '2028-08-03', 'boarding', 2)]);
    expect(rangeHasConflict('2028-08-03', '2028-08-05', req({ cap: 2, petCount: 2 }), cap)).toBe(
      false,
    );
  });

  it('an endpoint on an existing stay’s LAST OCCUPIED NIGHT is refused, not forgiven', () => {
    // The distinction the old "soft bookend" concession missed. Mar 1→5 occupies the nights of the
    // 1st–4th; the 5th is checkout. On the 4th the existing stay is STILL THERE — "the next day has
    // room" is true of it, but so is "there is one pet in this pool tonight", and a 2-pet request
    // arriving on the 4th would put 3 pets in a 2-pet pool that night.
    const cap = buildCapacity([boarding('2028-03-01', '2028-03-05', 'boarding', 1)]);
    expect(rangeConflictReason('2028-03-04', '2028-03-07', req({ cap: 2, petCount: 2 }), cap)).toBe(
      'blocked_or_full',
    );
    // …and the same in the other direction: a request DEPARTING on that night.
    expect(rangeConflictReason('2028-03-02', '2028-03-05', req({ cap: 2, petCount: 2 }), cap)).toBe(
      'blocked_or_full',
    );
    // One pet still fits alongside the one already there (1 + 1 <= 2) — the fix refuses the
    // over-capacity set, not the endpoint.
    expect(rangeHasConflict('2028-03-04', '2028-03-07', req({ cap: 2, petCount: 1 }), cap)).toBe(
      false,
    );
    // And the CHECKOUT day (the 5th) is still open to the cap-filling set.
    expect(rangeHasConflict('2028-03-05', '2028-03-07', req({ cap: 2, petCount: 2 }), cap)).toBe(
      false,
    );
  });

  it('an endpoint on the FIRST night of an existing stay is refused, not forgiven', () => {
    // The other half of the same confusion, and the reason `isBoundary` cannot excuse anything: the
    // flag is set on an existing stay's START day as well as its checkout day, and only the checkout
    // frees the pool. Sep 6→9 occupies the nights of the 6th, 7th and 8th. A 2-pet request Sep 3→7
    // departs on the 6th — where two pets are already sleeping — so forgiving it as a "bookend"
    // seats 4 pets in a 2-pet pool.
    const cap = buildCapacity([boarding('2028-09-06', '2028-09-09', 'boarding', 2)]);
    expect(rangeConflictReason('2028-09-03', '2028-09-07', req({ cap: 2, petCount: 2 }), cap)).toBe(
      'blocked_or_full',
    );
    // …and arriving on that same first night, from the other direction.
    expect(rangeConflictReason('2028-09-06', '2028-09-09', req({ cap: 2, petCount: 2 }), cap)).toBe(
      'blocked_or_full',
    );
    // Stopping the night BEFORE the existing stay arrives is still fine: Sep 3→6 occupies the 3rd,
    // 4th and 5th, none of which the existing stay touches.
    expect(rangeHasConflict('2028-09-03', '2028-09-06', req({ cap: 2, petCount: 2 }), cap)).toBe(
      false,
    );
  });

  it('a day filled by ANOTHER stay is not freed by a third stay checking out on it', () => {
    // A day can be a boundary for a reason that has nothing to do with the pets in the pool. Sep 5
    // is boarding A's CHECKOUT (it contributes nothing) and boarding B's third night (it contributes
    // 2, filling the cap). The boundary flag cannot distinguish them, so it must not be trusted:
    // arriving on Sep 5 puts 3 pets in a 2-pet pool.
    //
    // ONE night is requested on purpose. Over a longer stay the walk would refuse a LATER day
    // anyway and the verdict would look right for the wrong reason; Sep 5 is both endpoints of a
    // one-night stay, so it is the only day the walk can refuse on.
    const cap = buildCapacity([
      boarding('2028-09-01', '2028-09-05', 'boarding', 1),
      boarding('2028-09-03', '2028-09-08', 'boarding', 2),
    ]);
    expect(rangeConflictReason('2028-09-05', '2028-09-06', req({ cap: 2, petCount: 1 }), cap)).toBe(
      'blocked_or_full',
    );
  });

  it('a BLOCKED day stays a hard stop even when a booking bookends it', () => {
    // Blocked events set no boundary of their own, but another booking's start/checkout can set one
    // on the same day — and an endpoint concession that only asks `isBoundary` would then wave the
    // block through. The sitter is away on Sep 6; nothing may be booked over it, at either end.
    const cap = buildCapacity([
      blocked('2028-09-06', '2028-09-07'),
      boarding('2028-09-06', '2028-09-09', 'boarding', 1),
    ]);
    expect(rangeConflictReason('2028-09-04', '2028-09-07', req({ cap: null }), cap)).toBe(
      'blocked_or_full',
    );
    expect(rangeConflictReason('2028-09-06', '2028-09-09', req({ cap: null }), cap)).toBe(
      'blocked_or_full',
    );
    // The same block bookended by a CHECKOUT rather than a start — still a hard stop.
    const onCheckout = buildCapacity([
      blocked('2028-09-06', '2028-09-07'),
      boarding('2028-09-03', '2028-09-06', 'boarding', 1),
    ]);
    expect(rangeConflictReason('2028-09-06', '2028-09-08', req({ cap: null }), onCheckout)).toBe(
      'blocked_or_full',
    );
  });

  it('a 1-pet pool is not double-booked on the last night either', () => {
    // The same defect with the smallest possible numbers: cap 1, one pet in it, one more asked for.
    const cap = buildCapacity([boarding('2028-03-01', '2028-03-05', 'boarding', 1)]);
    expect(rangeHasConflict('2028-03-04', '2028-03-07', req({ cap: 1, petCount: 1 }), cap)).toBe(
      true,
    );
    expect(rangeHasConflict('2028-03-05', '2028-03-07', req({ cap: 1, petCount: 1 }), cap)).toBe(
      false,
    );
  });

  it('the house-sit POOL is per service, but no cap can stack two sits on one night', () => {
    // This test used to assert that an UNLIMITED house-sit pool let two sits stack on one night.
    // It did, and that was the defect: the pool counts PETS and the rule that matters counts
    // HOUSES. With the whereabouts rule running, the cap stops being the deciding input entirely.
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-04')]);
    const sit = (over: Partial<CapacityRequest> = {}): CapacityRequest => ({
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: 1,
      overlapAllowance: 1,
      ...over,
    });
    expect(rangeHasConflict('2028-09-02', '2028-09-03', sit(), cap)).toBe(true);
    expect(rangeHasConflict('2028-09-02', '2028-09-03', sit({ cap: null }), cap)).toBe(true);
    expect(rangeHasConflict('2028-09-02', '2028-09-03', sit({ cap: 99 }), cap)).toBe(true);
    // Only switching the rule off restores the old stacking, which is what NULL means.
    expect(
      rangeHasConflict('2028-09-02', '2028-09-03', sit({ cap: null, overlapAllowance: null }), cap),
    ).toBe(false);
  });

  it('the structural house-sit rule stays TENANT-WIDE: day.boarding.total from ANY boarding-kind service', () => {
    // The boarding occupancy lives on a DIFFERENT boarding-kind service ('kitty-condo') than the
    // house-sit request could ever share a pool with — the overlap rule must still fire, because
    // it models the sitter's physical absence, not a pool.
    const sit: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: null,
      overlapAllowance: 1,
    };
    const long = buildCapacity([boarding('2028-09-01', '2028-09-10', 'kitty-condo', 1)]);
    expect(rangeHasConflict('2028-09-02', '2028-09-04', sit, long)).toBe(true); // overlaps 2 days
    // …and the ONE legal handover against that same foreign-pool service: the boarding departs
    // Sep 4 (its last night), the sit arrives on it and has Sep 5 and Sep 6 to itself.
    const short = buildCapacity([boarding('2028-09-01', '2028-09-05', 'kitty-condo', 1)]);
    expect(rangeHasConflict('2028-09-04', '2028-09-07', sit, short)).toBe(false);
  });

  it('house-sit occupancy counts PETS: a 3-pet sit fills 3 units', () => {
    // The POOL arithmetic, isolated: `overlapAllowance: null` so the whereabouts rule (which would
    // refuse both of these on sight, pets be damned) does not decide the answer for it.
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-04', 'housesitting', 3)]);
    const sit = (over: Partial<CapacityRequest> = {}): CapacityRequest => ({
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: null,
      petCount: 1,
      overlapAllowance: null,
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
    // Pool arithmetic again, so the whereabouts rule is off — otherwise it, not `unitsOf`, is what
    // produced the `true`s below and the test would pass while proving nothing.
    const capNull = buildCapacity([
      houseSit('2028-09-01', '2028-09-04', 'housesitting', undefined),
    ]);
    const sit: CapacityRequest = {
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: 1,
      overlapAllowance: null,
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

  it('BOARDING never clashes with boarding: her own home, so only the pool cap applies', () => {
    // Two boardings on the same days is a pure capacity question — the whereabouts rule has
    // nothing to say about it, at any allowance. This is the half of `kindsClash` that must NOT
    // change when house sitting becomes exclusive: boarders are all at her own house, so several
    // a night is ordinary and `MaxConcurrentPets` is the only thing bounding them.
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
 * `overlapAllowance`; the day is a HANDOVER (we arrive as every opposite-kind booking there
 * departs, or we depart as every one of them arrives); and the stay is not shared END TO END — at
 * least one of its own days is free of the opposite kind. `null` = the rule does not run.
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
    // Sep 4 is house sit A's last night (we arrive as A departs) and Sep 6 is house sit B's first
    // (we depart as B arrives). Two real handovers — exactly what "one at each end" buys — and
    // Sep 5 is the boarding's own night, which is what keeps it a stay rather than a double
    // booking (rule 3).
    const events = [houseSit('2028-09-01', '2028-09-05'), houseSit('2028-09-06', '2028-09-10')];
    expect(verdicts(events, '2028-09-04', '2028-09-07', bdReq)).toEqual([true, true, false, false]);
  });

  it('row 9b — the same wedge with NO night of its own is refused at every allowance', () => {
    // Drop the free middle night and the "two handovers" become a stay the sitter is never home
    // for. Rule 2 is satisfied on both days; rule 3 is what refuses it.
    const events = [houseSit('2028-09-01', '2028-09-05'), houseSit('2028-09-05', '2028-09-09')];
    expect(verdicts(events, '2028-09-04', '2028-09-06', bdReq)).toEqual([true, true, true, false]);
  });

  it('row 13 — a one-night stay laid on a one-night opposite stay is refused', () => {
    // Both stays are a single night, so each is its own arrival AND departure and rule 2 passes.
    // Nothing is handing over: the dog is at her house for the one night she is at a client's.
    expect(
      verdicts([houseSit('2028-09-04', '2028-09-05')], '2028-09-04', '2028-09-05', bdReq),
    ).toEqual([true, true, true, false]);
  });

  it('row 14 — a CHAIN of one-night stays cannot double a whole stay either', () => {
    // The gap rule 2 alone leaves open: two back-to-back one-night sits satisfy the handover test
    // on both of a two-night boarding's days, so the count budget (2) is met and every day is a
    // "handover". Rule 3 refuses it — the boarding has no night of its own.
    const events = [houseSit('2028-09-04', '2028-09-05'), houseSit('2028-09-05', '2028-09-06')];
    expect(verdicts(events, '2028-09-04', '2028-09-06', bdReq)).toEqual([true, true, true, false]);
  });

  it('row 15 — a ONE-NIGHT opposite stay can never be handed over, however long the request', () => {
    // The request keeps Sep 5 and Sep 6 to itself, so rule 3 passes FOR IT — but the house sit's
    // only night is Sep 4, and sharing it leaves that stay with nothing of its own. Rules 1 and 3
    // are asked of BOTH stays, so this is the same verdict as booking the pair the other way round
    // (row 13's ordering) — which is the whole point of judging the neighbour too.
    expect(
      verdicts([houseSit('2028-09-04', '2028-09-05')], '2028-09-04', '2028-09-07', bdReq),
    ).toEqual([true, true, true, false]);
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

  it('the two concessions compose underneath the rule: a checkout in, a handover out', () => {
    // The request ARRIVES on Sep 3, which is the existing 2-pet boarding's CHECKOUT day — the pool
    // is empty that night, so a cap-filling pair fits. It DEPARTS on Sep 6, which is a cross-kind
    // handover: the house sit arrives as this boarding leaves. Two different concessions, both
    // genuine, at the two ends of one request — and the house sit keeps Sep 7–9, so the neighbour
    // test passes too.
    //
    // This test used to give the existing boarding an end date of Sep 4, making Sep 3 its LAST
    // OCCUPIED NIGHT rather than its checkout, and relied on the old "soft bookend" concession to
    // forgive it. That was 2 + 2 = 4 pets in a 2-pet pool on the night of Sep 3, so the assertion
    // was pinning a real double booking; the concession is gone and the scenario is now the sound
    // one it was always described as.
    const events = [
      boarding('2028-09-01', '2028-09-03', 'boarding', 2),
      houseSit('2028-09-06', '2028-09-10', 'housesitting'),
    ];
    const request: CapacityRequest = {
      serviceType: 'boarding',
      kind: 'boarding',
      cap: 2,
      petCount: 2,
      overlapAllowance: 1,
    };
    expect(rangeHasConflict('2028-09-03', '2028-09-07', request, buildCapacity(events))).toBe(
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

/**
 * A NIGHT HOLDS AT MOST ONE HOUSE SIT. The same whereabouts rule, turned on its own kind, and with
 * the HANDOVER CONCESSION WITHHELD.
 *
 * House sitting happens at the CLIENT's home, so the sitter can sleep in exactly one of them a
 * night whether it holds one cat or four dogs. Until this rule existed, `rangeConflictReason` read
 * only the OPPOSITE pool for a house-sit request, so two sits at two clients were held apart by
 * nothing but `MaxConcurrentPets` — which counts pets, and could only express "one house sit a
 * night" by also refusing anyone who arrives with two dogs.
 *
 * Widening the clashing set was not enough on its own, and the reason is the occupancy model:
 * `EventSpan.lastOccupied` is `end_date - 1`, the last NIGHT slept, not the checkout morning. So a
 * "handover day" is a night BOTH stays occupy. Against a boarding that is a real tolerance (the
 * boarder is collected that evening and the sitter still sleeps in one place); against another
 * house sit it IS the double booking. The Smiths Mon→Fri plus the Joneses Thu→Sun is the shape,
 * and on Thursday night she is booked to sleep in two homes.
 *
 * So the concession is CROSS-KIND ONLY: two house sits may never share a night on ANY numbered
 * allowance. `null` ("No limit") still switches the whole rule off, same-kind included.
 *
 * What this does NOT touch: back-to-back sits, which share no night at all (the first one's
 * `lastOccupied` is the Thursday, the second one's `start` is the Friday) and were legal at
 * allowance 0 before any of this. And BOARDING, which is all at her own house.
 */
describe('a night holds at most ONE house sit (same-kind whereabouts)', () => {
  const hsReq = (overlapAllowance: number | null, over: Partial<CapacityRequest> = {}) => ({
    serviceType: 'housesitting',
    kind: 'housesit' as const,
    cap: null,
    petCount: 1,
    overlapAllowance,
    ...over,
  });
  const verdicts = (events: CapacityEvent[], start: string, end: string): boolean[] =>
    [0, 1, 2, null].map((a) => rangeHasConflict(start, end, hsReq(a), buildCapacity(events)));

  it('refuses a house sit laid across the middle of another house sit', () => {
    // Sep 3 is interior to the existing sit: it neither arrives nor departs there, so nothing is
    // handing over and the sitter would be in two homes for three nights.
    expect(verdicts([houseSit('2028-09-01', '2028-09-10')], '2028-09-03', '2028-09-06')).toEqual([
      true,
      true,
      true,
      false, // NULL switches the whole rule off, here exactly as it does for boarding vs house sit
    ]);
  });

  it('THE SMITHS AND THE JONESES: a shared night is refused at EVERY numbered allowance', () => {
    // The existing sit occupies Sep 1–4 (Sep 5 is its checkout). The request arrives Sep 4, which
    // is that sit's LAST NIGHT — so both stays occupy the night of Sep 4 and she is booked to
    // sleep in two homes. Cross-kind this is the canonical legal handover (see the table above);
    // same-kind there is nothing to hand over, so it is refused at 0, 1 and 2 alike.
    expect(verdicts([houseSit('2028-09-01', '2028-09-05')], '2028-09-04', '2028-09-07')).toEqual([
      true,
      true,
      true,
      false, // NULL is the one escape hatch, and it switches the whole rule off
    ]);
  });

  it('…and in the OPPOSITE ORDER, which is the same night from the other side', () => {
    // Order independence for the new refusal specifically: whichever of the pair reaches the
    // calendar first, the night of Sep 4 is claimed twice.
    expect(verdicts([houseSit('2028-09-04', '2028-09-07')], '2028-09-01', '2028-09-05')).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('refuses the shared night even when it is the only night either stay shares', () => {
    // Nothing about the LENGTH of the stays rescues it: a ten-night sit and a three-night sit
    // touching on exactly one night are still two homes on that night.
    expect(verdicts([houseSit('2028-09-01', '2028-09-11')], '2028-09-10', '2028-09-13')).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('BACK-TO-BACK is not an overlap at all, at every allowance including 0', () => {
    // THE SENTENCE THE WHOLE RULE RESTS ON. A checkout day carries no occupancy: the first sit's
    // last night is Sep 4 and the second's first night is Sep 5, so out of one house in the
    // morning and into the next that evening shares NO night. This was legal at allowance 0 before
    // the allowance existed, and withholding the handover concession cannot touch it — which is
    // why "two house sits may never share a night" does not cost a sitter her normal working week.
    expect(verdicts([houseSit('2028-09-01', '2028-09-05')], '2028-09-05', '2028-09-08')).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // …and the mirror, arriving BEFORE rather than after.
    expect(verdicts([houseSit('2028-09-05', '2028-09-08')], '2028-09-01', '2028-09-05')).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // A whole chain of them, which is a working week.
    const chain = [
      houseSit('2028-09-01', '2028-09-04'),
      houseSit('2028-09-04', '2028-09-06'),
      houseSit('2028-09-08', '2028-09-11'),
    ];
    expect(verdicts(chain, '2028-09-06', '2028-09-08')).toEqual([false, false, false, false]);
  });

  it('two ONE-NIGHT house sits on the same night are refused at every allowance', () => {
    // One night, claimed twice. Condition 3 ("the stay kept no day of its own") already refused
    // this before the concession was withheld; now the shared night alone is enough.
    expect(verdicts([houseSit('2028-09-04', '2028-09-05')], '2028-09-04', '2028-09-05')).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('a ONE-NIGHT existing sit can never be shared, however long the request', () => {
    // A one-night sit has exactly one night and any touch claims it. Stated separately because a
    // sitter takes single overnights constantly and the copy promises her this outcome.
    expect(verdicts([houseSit('2028-09-04', '2028-09-05')], '2028-09-04', '2028-09-07')).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('PET COUNT IS IRRELEVANT: one pet blocks one pet in a five-pet pool', () => {
    // The whole point. `MaxConcurrentPets` has four spare places and the answer is still no,
    // because the question is which HOUSE she sleeps in.
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-10', 'housesitting', 1)]);
    expect(
      rangeHasConflict('2028-09-03', '2028-09-06', hsReq(1, { cap: 5, petCount: 1 }), cap),
    ).toBe(true);
    // …and the pool genuinely does have the room, which is what the old rule was reading.
    expect(
      rangeHasConflict('2028-09-03', '2028-09-06', hsReq(null, { cap: 5, petCount: 1 }), cap),
    ).toBe(false);
  });

  it('is TENANT-WIDE: a house sit on ANOTHER housesit-kind service counts', () => {
    // Same argument as the cross-kind rule: it models her whereabouts, not a pool, so a second
    // house-sitting service is no escape hatch.
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-10', 'overnight-sit')]);
    expect(rangeHasConflict('2028-09-03', '2028-09-06', hsReq(1), cap)).toBe(true);
  });

  it('names the SAME-kind reason, so the sentence a customer reads is true', () => {
    const sits = buildCapacity([houseSit('2028-09-01', '2028-09-10')]);
    expect(rangeConflictReason('2028-09-03', '2028-09-06', hsReq(1), sits)).toBe(
      'same_kind_overlap',
    );
    // The cross-kind reason is untouched and still reported for a boarding neighbour.
    const beds = buildCapacity([boarding('2028-09-01', '2028-09-10')]);
    expect(rangeConflictReason('2028-09-03', '2028-09-06', hsReq(1), beds)).toBe(
      'cross_kind_overlap',
    );
    // A day carrying both: the same-kind fact is the more specific one and wins.
    const both = buildCapacity([
      boarding('2028-09-01', '2028-09-10'),
      houseSit('2028-09-01', '2028-09-10'),
    ]);
    expect(rangeConflictReason('2028-09-03', '2028-09-06', hsReq(1), both)).toBe(
      'same_kind_overlap',
    );
    // …and a BOARDING request over a full boarding pool is not an overlap of any kind.
    const full = buildCapacity([boarding('2028-09-01', '2028-09-10', 'boarding', 2)]);
    expect(
      rangeConflictReason('2028-09-03', '2028-09-06', req({ cap: 2, overlapAllowance: 1 }), full),
    ).toBe('blocked_or_full');
  });

  it('the neighbour test does not count a sit as its own clashing occupancy', () => {
    // `neighborsViolated` asks what clashes with the NEIGHBOUR, and a house sit clashes with house
    // sits — so without the `!== span` identity filter every day of a neighbour sit would look
    // shared, `shared >= days` would always hold, and the plainest legal CROSS-KIND handover would
    // be refused. A boarding arriving on a house sit's last night is that handover.
    expect(
      rangeHasConflict(
        '2028-09-04',
        '2028-09-07',
        req({ cap: null, overlapAllowance: 1 }),
        buildCapacity([houseSit('2028-09-01', '2028-09-05')]),
      ),
    ).toBe(false);
  });

  it('CROSS-KIND handovers are untouched by the same-kind rule, in both directions', () => {
    // The pin that stops this change tightening the boarding side by accident. Each pair shares
    // exactly the night of Sep 4: one stay's last night, the other's first. Legal at 1 and 2.
    for (const allowance of [1, 2]) {
      // A house sit arriving on a boarding's last night.
      expect(
        rangeHasConflict(
          '2028-09-04',
          '2028-09-07',
          hsReq(allowance),
          buildCapacity([boarding('2028-09-01', '2028-09-05')]),
        ),
      ).toBe(false);
      // A boarding arriving on a house sit's last night.
      expect(
        rangeHasConflict(
          '2028-09-04',
          '2028-09-07',
          req({ cap: null, overlapAllowance: allowance }),
          buildCapacity([houseSit('2028-09-01', '2028-09-05')]),
        ),
      ).toBe(false);
      // …and a house sit DEPARTING on the day a boarding arrives, the other direction of the
      // directional handover test.
      expect(
        rangeHasConflict(
          '2028-09-01',
          '2028-09-05',
          hsReq(allowance),
          buildCapacity([boarding('2028-09-04', '2028-09-08')]),
        ),
      ).toBe(false);
    }
    // Allowance 0 still refuses all three, unchanged.
    expect(
      rangeHasConflict(
        '2028-09-04',
        '2028-09-07',
        hsReq(0),
        buildCapacity([boarding('2028-09-01', '2028-09-05')]),
      ),
    ).toBe(true);
  });

  it('a boarding may still hand over with a house sit that is BACK-TO-BACK with another sit', () => {
    // The two rules meeting: a chain of back-to-back sits shares no night with itself, so a
    // boarding handing over into the first of them is judged exactly as it was before.
    const cap = buildCapacity([
      houseSit('2028-09-05', '2028-09-08'),
      houseSit('2028-09-08', '2028-09-11'),
    ]);
    expect(
      rangeHasConflict('2028-09-01', '2028-09-06', req({ cap: null, overlapAllowance: 1 }), cap),
    ).toBe(false);
  });

  it('boarding vs boarding is untouched: several stays a night, bounded only by the cap', () => {
    // The asymmetry, pinned. Three separate boardings across one night, cap 3: fine. Cap 2: the
    // POOL refuses it, and never the whereabouts rule.
    const events = [
      boarding('2028-09-01', '2028-09-10', 'boarding', 1),
      boarding('2028-09-02', '2028-09-08', 'boarding', 1),
    ];
    for (const allowance of [0, 1, 2, null]) {
      expect(
        rangeHasConflict(
          '2028-09-03',
          '2028-09-06',
          req({ cap: 3, overlapAllowance: allowance }),
          buildCapacity(events),
        ),
      ).toBe(false);
      expect(
        rangeConflictReason(
          '2028-09-03',
          '2028-09-06',
          req({ cap: 2, overlapAllowance: allowance }),
          buildCapacity(events),
        ),
      ).toBe('blocked_or_full');
    }
  });

  it('whereaboutsDayBlocked strikes out EVERY night of a sit for a house-sit request', () => {
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-05')]); // occupies Sep 1–4
    const day = (d: string) => cap.get(d)!;
    // Same-kind has no handover to concede, so the day-level paint is exact here rather than
    // conservative: every occupied night is unusable by every house-sit request, at 0, 1 and 2.
    for (const allowance of [0, 1, 2]) {
      for (const date of ['2028-09-01', '2028-09-02', '2028-09-03', '2028-09-04']) {
        expect(whereaboutsDayBlocked(day(date), date, 'housesit', allowance)).toBe(true);
      }
    }
    // NULL switches the paint off with the rule.
    expect(whereaboutsDayBlocked(day('2028-09-04'), '2028-09-04', 'housesit', null)).toBe(false);
    // The CHECKOUT day carries no occupancy at all (it is only in the map to record a boundary),
    // so it is never struck out and a back-to-back sit may start on it, at every allowance.
    expect(day('2028-09-05').housesit.spans).toEqual([]);
    for (const allowance of [0, 1, 2]) {
      expect(whereaboutsDayBlocked(day('2028-09-05'), '2028-09-05', 'housesit', allowance)).toBe(
        false,
      );
    }
    // CROSS-KIND paint is unchanged: a BOARDING request may still hand over on this sit's arrival
    // day (it departs on it) and on its last night (it arrives on it), so neither is struck out.
    expect(whereaboutsDayBlocked(day('2028-09-01'), '2028-09-01', 'boarding', 1)).toBe(false);
    expect(whereaboutsDayBlocked(day('2028-09-04'), '2028-09-04', 'boarding', 1)).toBe(false);
    expect(whereaboutsDayBlocked(day('2028-09-02'), '2028-09-02', 'boarding', 1)).toBe(true);
    expect(whereaboutsDayBlocked(day('2028-09-04'), '2028-09-04', 'boarding', 0)).toBe(true);
    // …and a house-sit request may still hand over with a BOARDING day, unchanged.
    const beds = buildCapacity([boarding('2028-09-01', '2028-09-05')]);
    expect(whereaboutsDayBlocked(beds.get('2028-09-04')!, '2028-09-04', 'housesit', 1)).toBe(false);
    // A BOARDING request is untouched by a boarding day.
    expect(whereaboutsDayBlocked(beds.get('2028-09-02')!, '2028-09-02', 'boarding', 1)).toBe(false);
  });

  it('a ONE-NIGHT neighbour sit strikes out its day for the grid too', () => {
    const cap = buildCapacity([houseSit('2028-09-04', '2028-09-05')]);
    expect(whereaboutsDayBlocked(cap.get('2028-09-04')!, '2028-09-04', 'housesit', 2)).toBe(true);
  });
});

/**
 * ORDER INDEPENDENCE. The overlap rule is a claim about a STATE of the calendar — the sitter is
 * either in two places on some night or she is not — so it must not matter which of two bookings
 * arrived first. It is easy to get wrong (and was: rules 1 and 3 originally looked only at the
 * incoming request, so a one-night boarding followed by a long house sit was accepted while the
 * same pair booked the other way round was refused), and a fixed-fixture test can never catch it,
 * because it only ever books in one order.
 *
 * So: sweep every CLASHING pair of stays in a small window and assert the two orderings agree.
 * "Clashing" is `kindsClash`: boarding against a house sit in either direction, and house sit
 * against house sit. Boarding-on-boarding is the one pair the rule never judges, so it is skipped
 * rather than asserted on — sweeping it would only be re-testing the pool cap.
 */
describe('the overlap rule is order-independent', () => {
  const BASE = '2028-11-01';
  type Stay = { kind: PoolKind; start: string; end: string };

  const stays: Stay[] = [];
  for (const kind of ['boarding', 'housesit'] as const)
    for (let offset = 0; offset <= 5; offset++)
      for (let nights = 1; nights <= 3; nights++)
        stays.push({
          kind,
          start: addDays(BASE, offset),
          end: addDays(BASE, offset + nights),
        });

  const eventOf = (s: Stay): CapacityEvent => ({
    start_date: s.start,
    end_date: s.end,
    kind: s.kind,
    serviceType: s.kind === 'boarding' ? 'boarding' : 'housesitting',
    petCount: 1,
  });
  const requestOf = (s: Stay, overlapAllowance: number | null): CapacityRequest => ({
    serviceType: s.kind === 'boarding' ? 'boarding' : 'housesitting',
    kind: s.kind,
    cap: null, // pools unlimited: this sweep is about the cross-kind rule and nothing else
    petCount: 1,
    overlapAllowance,
  });
  /** Would `incoming` be accepted onto a calendar holding only `existing`? */
  const accepts = (existing: Stay, incoming: Stay, allowance: number | null): boolean =>
    !rangeHasConflict(
      incoming.start,
      incoming.end,
      requestOf(incoming, allowance),
      buildCapacity([eventOf(existing)]),
    );

  for (const allowance of [0, 1, 2, null]) {
    it(`agrees with itself in both orders at allowance ${allowance}`, () => {
      const disagreements: string[] = [];
      let pairs = 0;
      for (const a of stays) {
        for (const b of stays) {
          // Boarding on boarding is the only pair the whereabouts rule never judges (her own home
          // holds both). House sit on house sit IS judged, and is swept here for the same reason
          // the cross-kind pairs are: the fix reused this machinery, so it inherited this hazard.
          if (a.kind === 'boarding' && b.kind === 'boarding') continue;
          pairs += 1;
          const bAfterA = accepts(a, b, allowance);
          const aAfterB = accepts(b, a, allowance);
          if (bAfterA !== aAfterB) {
            disagreements.push(
              `${a.kind} ${a.start}→${a.end} vs ${b.kind} ${b.start}→${b.end}: ` +
                `second-is-b ${bAfterA ? 'accept' : 'refuse'}, second-is-a ${aAfterB ? 'accept' : 'refuse'}`,
            );
          }
        }
      }
      expect({ pairs: pairs > 0, disagreements }).toEqual({ pairs: true, disagreements: [] });
    });
  }

  it('the two-booking repro from review refuses in BOTH orders at the default allowance', () => {
    // A one-night boarding on Sep 4 and a house sit Sep 1→5. Whichever is booked first, the other
    // must be refused: the dog would spend its only night alone while the sitter sleeps at a
    // client's house. Before the neighbour check, the house-sit-second ordering was ACCEPTED.
    const bd: Stay = { kind: 'boarding', start: '2028-09-04', end: '2028-09-05' };
    const hs: Stay = { kind: 'housesit', start: '2028-09-01', end: '2028-09-05' };
    expect({ hsAfterBd: accepts(bd, hs, 1), bdAfterHs: accepts(hs, bd, 1) }).toEqual({
      hsAfterBd: false,
      bdAfterHs: false,
    });
  });

  it('the three-booking ratchet cannot double a stay one handover at a time', () => {
    // bd Sep4→Sep6 (empty calendar, fine), then hs Sep1→Sep5 (one handover on Sep 4, and the
    // boarding still keeps Sep 5 — legal), then hs Sep5→Sep9, which would take the boarding's
    // LAST free night and leave it 2 doubled nights at an allowance of 1.
    const bd: CapacityEvent = {
      start_date: '2028-09-04',
      end_date: '2028-09-06',
      kind: 'boarding',
      serviceType: 'boarding',
      petCount: 1,
    };
    const hsA: CapacityEvent = {
      start_date: '2028-09-01',
      end_date: '2028-09-05',
      kind: 'housesit',
      serviceType: 'housesitting',
      petCount: 1,
    };
    const sit = (over: Partial<CapacityRequest> = {}): CapacityRequest => ({
      serviceType: 'housesitting',
      kind: 'housesit',
      cap: null,
      petCount: 1,
      overlapAllowance: 1,
      ...over,
    });
    // Step 2 is legal on its own…
    expect(rangeHasConflict('2028-09-01', '2028-09-05', sit(), buildCapacity([bd]))).toBe(false);
    // …and step 3 is what the neighbour check refuses.
    expect(rangeHasConflict('2028-09-05', '2028-09-09', sit(), buildCapacity([bd, hsA]))).toBe(
      true,
    );
  });
});

/**
 * A row whose dates do not parse used to be SKIPPED, which is the one direction this engine must
 * never fail in: the corrupt row contributed nothing, so the day it really occupies read as
 * bookable and the sitter got a booking on top of it. Corrupt data fails toward OCCUPIED — the
 * same direction `normalizeAllowance` already fails (an unrecognised allowance reads as the
 * stricter 0), and the same direction the calendar-sync layer already takes for a timed Google
 * event (over-block, never under-block).
 */
describe('malformed events fail toward OCCUPIED, never toward free', () => {
  const malformedEnd: CapacityEvent = {
    start_date: '2028-11-02',
    end_date: 'not-a-date',
    kind: 'boarding',
    serviceType: 'boarding',
    petCount: 1,
  };
  const malformedStart: CapacityEvent = {
    start_date: '',
    end_date: '2028-11-06',
    kind: 'boarding',
    serviceType: 'boarding',
    petCount: 1,
  };
  const backwards: CapacityEvent = {
    start_date: '2028-11-10',
    end_date: '2028-11-08',
    kind: 'housesit',
    serviceType: 'housesitting',
    petCount: 1,
  };

  it('an unparseable END date blocks the one day the row can still be pinned to', () => {
    const cap = buildCapacity([malformedEnd]);
    expect(cap.get('2028-11-02')?.blocked).toBe(1);
    // A hard stop, not pool arithmetic: nothing about a corrupt row is trustworthy, so an
    // unlimited cap must not wave it through either.
    expect(rangeHasConflict('2028-11-01', '2028-11-04', req({ cap: null }), cap)).toBe(true);
    expect(rangeConflictReason('2028-11-02', '2028-11-03', req({ cap: 9 }), cap)).toBe(
      'blocked_or_full',
    );
  });

  it('an END BEFORE the start is corrupt too, and blocks its start day', () => {
    const cap = buildCapacity([backwards]);
    expect(cap.get('2028-11-10')?.blocked).toBe(1);
    expect(rangeHasConflict('2028-11-10', '2028-11-11', req({ cap: null }), cap)).toBe(true);
  });

  it('an unparseable START pins nothing, so it cannot block — but it is still reported', () => {
    const cap = buildCapacity([malformedStart]);
    expect(cap.size).toBe(0); // no date to key it under; a date-map cannot express it
    expect(isWellFormedCapacityEvent(malformedStart)).toBe(false);
  });

  it('an end date that is PRESENT but empty is damage, not "no end date"', () => {
    // `end_date: ''` used to fall through the `||` as "no end", i.e. a single-day event that
    // occupies nothing — so a range booking whose EndDate had been blanked left its nights free.
    const blankEnd: CapacityEvent = {
      start_date: '2028-11-15',
      end_date: '',
      kind: 'boarding',
      serviceType: 'boarding',
      petCount: 2,
    };
    expect(isWellFormedCapacityEvent(blankEnd)).toBe(false);
    expect(buildCapacity([blankEnd]).get('2028-11-15')?.blocked).toBe(1);
    // An ABSENT end date is still the legitimate single-day shape: no occupancy, no block.
    const noEnd: CapacityEvent = { start_date: '2028-11-15', kind: 'boarding', serviceType: 'x' };
    expect(buildCapacity([noEnd]).get('2028-11-15')?.blocked).toBe(0);
  });

  it('the predicate names exactly the corrupt rows, so a human can be told about them', () => {
    expect(isWellFormedCapacityEvent(malformedEnd)).toBe(false);
    expect(isWellFormedCapacityEvent(backwards)).toBe(false);
    expect(isWellFormedCapacityEvent(boarding('2028-11-02', '2028-11-04'))).toBe(true);
    // A single-day event carries no end date at all and is perfectly well formed — it just
    // occupies nothing (see buildCapacity).
    expect(
      isWellFormedCapacityEvent({ start_date: '2028-11-02', kind: 'boarding', serviceType: 'x' }),
    ).toBe(true);
    // …as is an end date EQUAL to the start (the same "occupies nothing" shape).
    expect(isWellFormedCapacityEvent(boarding('2028-11-02', '2028-11-02'))).toBe(true);
  });

  it('one corrupt row never costs the well-formed rows beside it', () => {
    const cap = buildCapacity([malformedStart, boarding('2028-11-20', '2028-11-22'), malformedEnd]);
    expect(cap.get('2028-11-20')?.byService.get('boarding')).toBe(1);
    expect(cap.get('2028-11-02')?.blocked).toBe(1);
  });
});
