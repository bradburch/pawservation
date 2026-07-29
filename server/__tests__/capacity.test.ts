import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildCapacity,
  rangeConflictReason,
  rangeHasConflict,
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
 * ORDER INDEPENDENCE. The overlap rule is a claim about a STATE of the calendar — the sitter is
 * either in two places on some night or she is not — so it must not matter which of two bookings
 * arrived first. It is easy to get wrong (and was: rules 1 and 3 originally looked only at the
 * incoming request, so a one-night boarding followed by a long house sit was accepted while the
 * same pair booked the other way round was refused), and a fixed-fixture test can never catch it,
 * because it only ever books in one order.
 *
 * So: sweep every cross-kind pair of stays in a small window and assert the two orderings agree.
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
          if (a.kind === b.kind) continue; // same kind: the rule never applies, in either order
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
