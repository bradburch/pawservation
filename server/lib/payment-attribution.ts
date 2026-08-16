/**
 * Propose how one already-recorded credit should attach to a household's unpaid bookings — the
 * pure decision at the center of payment attribution. A sitter who imported payment history from
 * another system can end up with money the product cannot place: correct against the household,
 * unattached to any stay, so every booking still reads unpaid and the client reads "in credit".
 * This is the proposer, not the applier — it decides a split, it never writes one.
 *
 * PURE. No D1, no env, no fetch — takes plain data, returns plain data.
 *
 * The one invariant this module exists to uphold is CONSERVATION:
 * `splits.reduce((sum, s) => sum + s.amount, 0) + remainder === credit.amount`, exactly, in every
 * branch. Whole dollars throughout, exact integer arithmetic — no `Math.round`, no floating point.
 * A rounded split would silently create or destroy money. That guarantee only holds for inputs
 * that are actually whole dollars, so `credit.amount` and every booking's `outstanding` are
 * checked with `Number.isInteger` (and non-negativity) before any arithmetic runs — a fractional
 * or negative amount is refused rather than quietly producing a fractional or negative split.
 * `outstanding` is validated against the FULL, unfiltered `bookings` list, before the
 * `outstanding > 0` filter that picks out candidates: `NaN > 0` and `-50 > 0` are both false, so
 * checking only the filtered set would silently drop an unreadable booking from consideration
 * — indistinguishable from one that is genuinely settled — instead of refusing outright.
 *
 * The other rule is refusal over guessing: when the nearest-by-date choice is a genuine tie
 * among two or more different bookings and the credit cannot cover all of them, this returns
 * `ambiguous` naming every tied booking, rather than picking one by id order, array order, or
 * size. That choice belongs to the sitter — the same posture `resolveMatchClient`
 * (server/lib/payment-import.ts) takes toward a colliding payer name, and the calendar backfill
 * takes toward an event it cannot place unambiguously.
 *
 * THAT INCLUDES A TIE THE CREDIT CANNOT AFFORD AT ALL, when it is the first thing the credit
 * meets. It was once reasoned that a credit unable to fully fund even the cheapest tied booking
 * had no decision in it — the choice was "moot" — and the leftover simply became `remainder`. It
 * is not moot: a $50 credit against two equidistant $100 boardings is a real question about which
 * stay it is a deposit on, and reporting `ok` with `splits: []` answered it with a confident
 * proposal that proposed nothing and that `applyAttribution` then refuses to apply. What IS a
 * leftover is the same tie met AFTER something was funded — the credit settled the stay it was
 * for, and the rest is remainder. See the tie branch in the allocation loop for both halves.
 *
 * That rule has a second edge, added after the first dry run against production: a tie is not the
 * only shape ambiguity takes. Proximity is this function's ONLY matching rule, so a candidate 600
 * days from the payment is not a better match than one 601 days away — it is the absence of a
 * match, which the ordering below cannot tell apart from a real one. Candidates outside the
 * proximity windows around the credit's `paidDate` are therefore dropped before any ordering
 * happens, and a credit left with none of them is refused as `no-recent-booking` rather than
 * placed somewhere arbitrary. See those constants' own doc comments for the measured
 * distributions the numbers are calibrated against.
 *
 * PROXIMITY IS DIRECTIONAL, because a payment settles services that have ALREADY HAPPENED. Two
 * windows, not one: `MAX_LATE_PAYMENT_DAYS` for a stay on or before the paid date (generous —
 * settling weeks late, or bundling several weeks into one transfer, is the ordinary case the
 * sitter named) and the much tighter `MAX_PREPAYMENT_DAYS` for a stay after it. Ordering follows
 * the same asymmetry: candidates on or before the paid date come first, nearest first, then those
 * after it, nearest first. So a stay a week in the past always outranks one a week in the future,
 * and — the point of the change — the two no longer TIE, which is what an absolute distance made
 * them do. Ties are now only possible within one direction, and there they are refused exactly as
 * before: two stays equally far in the past are still the sitter's call, not this function's.
 *
 * PROXIMITY IS ALSO MEASURED TO THE WHOLE STAY, not to the day it starts — `intervalDistance`, the
 * single helper every rule above and below asks. A payment made while a house sit is running is 0
 * days from it; one made after checkout is measured from the end date. Only the near side keeps
 * measuring from the start, because "prepayment" means money that arrived before the work began.
 * See that function's own comment for the sitter's report that produced it.
 *
 * A LEFTOVER IS NOT THE SAME CLAIM AS A MATCH. The nearest stay is the one this credit is FOR,
 * and it may be part-paid — a deposit against a big boarding is real. Every stay after it is a
 * spill, an assertion that one payment covered several stays, and it only receives money when the
 * remainder SETTLES IT IN FULL; otherwise allocation stops there and the rest is `remainder`.
 * `MAX_SPILL_DAYS` bounds how far a spill target may be as a secondary check. See the spill rule
 * inside the allocation loop, and `MAX_SPILL_DAYS`'s own comment, for the measured cases.
 *
 * AMOUNT CONGRUENCE IS A TIE-BREAKER AND NOTHING MORE. The sitter asked for exactness directly —
 * *"a $100 payment near a $100 stay is a strong signal"* — and on her live data it is nearly
 * signal-free: 151 of her credits are $40 and 39 of her stays owe $40, so "exact" picks out one of
 * 151 indistinguishable candidates. So exactness enters ONLY among candidates already inside the
 * windows, ONLY behind side and distance, and ONLY when the amount is DISTINCTIVE in the household
 * — one unpaid stay owing it, one unattributed credit of it. See `distinctiveAmounts` for the
 * measurement and `CONGRUENCE_RANK_BONUS` for why it cannot outweigh a single day.
 *
 * THE DISTINCTIVENESS SET IS PASSED IN, NEVER DERIVED HERE, and that is the whole reason this
 * function stays PURE and per-credit: "no OTHER credit of this household has this amount" is
 * knowledge about credits this function must never see. The preview route holds both lists and
 * computes the set once per household; this function only ever asks whether an amount is in it.
 *
 * Dates are just as load-bearing as amounts: an unparseable or impossible `startDate` / `endDate` /
 * `paidDate` can't be sorted by distance without silently falling into an array-order tie-break
 * (`NaN` comparator results are unspecified), so every date is validated with the house
 * `isRealDate` (server/lib/validation.ts) — tolerant of a trailing `T…` time-of-day, stripped
 * before validation — before any distance is computed. Distances themselves are computed with
 * `parseDateUtc`/`MS_PER_DAY` (src/shared/util/dates.ts), the codebase's one date parse, so a
 * time-of-day on `paidDate` can never make every distance fractional and quietly disable tie
 * detection.
 */

import { isRealDate } from './validation.js';
import { MS_PER_DAY, parseDateUtc } from '../../src/shared/index.js';

/**
 * THE DERIVED `ExternalRef` SCHEME — `attr:<segment>:<the original ref, verbatim>`, where
 * `<segment>` is a split's 1-based index or `r` for the remainder. `applyAttribution`
 * (server/db/repo.ts) writes them; the importers read them back through `expandImportedRefs`.
 * Both halves live here, together, because the ONLY property that matters is that they are exact
 * inverses: `recoverSourceRef(deriveAttributedRef(x, s)) === x` for every x. Split across two
 * modules, that could drift, and drifting silently frees an idempotency key.
 *
 * WHY THE ORIGINAL IS THE TAIL RATHER THAN A SUFFIX. Attribution deletes the imported
 * account-level row, so after it runs the original ref exists NOWHERE in `Payments` — and both
 * importers dedupe by exact set membership against exactly that column. A ref the importers
 * cannot recover is a key that is free again, and a re-upload of the same export (overlapping
 * monthly exports are the CSV importer's documented expected case) records every attributed
 * payment a second time as a brand-new credit. The partial unique index cannot save it either:
 * with the original gone, there is nothing left for it to collide with.
 *
 * A SUFFIX CANNOT BE UNDONE, which is why the marker leads. `csv:<hash>:<rank>` already ends in
 * `:` plus digits, so `csv:abc:3` is indistinguishable from a `csv:abc` that was suffixed `:3` —
 * recovery would have to guess. With the original carried verbatim as the tail, recovery is
 * "strip the marker and the segment; everything after is the original", whatever it contains.
 *
 * NO NATURAL REF CAN BE MISTAKEN FOR A DERIVED ONE. The writers of a non-NULL `ExternalRef` in
 * this repo are the Venmo importer (a transaction id, `TXN_ID_RE` = `[A-Za-z0-9_-]{1,64}`, which
 * cannot contain a colon at all), the CSV importer (always namespaced `csv:`, including when it
 * keys on a sitter's own reference cell), and this scheme itself; hand-recorded payments carry
 * NULL. Rows loaded out of tree are not covered by that survey — the live `brad-paws` import
 * wrote `bp_pay_*` refs directly — which is exactly why the check below is a parse rather than a
 * survey. Nothing natural is known to begin `attr:`, but that is an argument, not a guarantee, so
 * `recoverSourceRef` is written to REQUIRE a well-formed segment (digits, or `r`) rather than
 * trusting the marker alone: `attr:x:whatever` is read as an ordinary ref, not unwrapped.
 *
 * NESTING IS ORDINARY. A remainder is still an account-level credit and can be attributed again,
 * giving `attr:1:attr:r:<original>`; recovery unwraps repeatedly, and terminates because every
 * unwrap strictly shortens the string.
 */
const DERIVED_REF_MARKER = 'attr:';
const DERIVED_REF_RE = /^attr:(?:\d+|r):/;

/** The ref one derived row carries. NULL in (a hand-recorded payment) means NULL out. */
export function deriveAttributedRef(sourceRef: string | null, segment: string): string | null {
  return sourceRef === null ? null : `${DERIVED_REF_MARKER}${segment}:${sourceRef}`;
}

/** The importer key a derived ref was made from, or `null` if `ref` is not a derived ref. */
export function recoverSourceRef(ref: string): string | null {
  let current = ref;
  while (DERIVED_REF_RE.test(current)) {
    const separator = current.indexOf(':', DERIVED_REF_MARKER.length);
    // Structural termination, not regex-dependent: today `DERIVED_REF_RE` guarantees this second
    // colon, so the break is unreachable — but a future widening of the marker grammar would
    // otherwise turn `slice(0)` into no progress, and this runs on a request path, so the failure
    // would be a hang rather than a test failure.
    if (separator === -1) break;
    current = current.slice(separator + 1);
  }
  return current === ref ? null : current;
}

/**
 * The set both importers dedupe against: every ref this tenant literally holds, PLUS the original
 * importer key behind each derived one. Without that second half, attributing an imported payment
 * would hand its key back to the next upload of the same file.
 *
 * A pre-read set, not a database constraint — so it is the whole protection for an attributed
 * key, where an unattributed one is also backstopped by the partial unique index. Note the gap is
 * between two concurrent IMPORTS, not between an import and an attribution: attribution commits
 * the delete and the derived inserts in one `db.batch`, so a set read either side of it sees the
 * key literally or recovers it, never neither. Two imports of the same already-attributed file
 * running concurrently could still both pass this check, which is why the routes go on catching a
 * unique violation from the insert itself rather than treating this set as the last word.
 */
export function expandImportedRefs(refs: string[]): Set<string> {
  const set = new Set(refs);
  for (const ref of refs) {
    const source = recoverSourceRef(ref);
    if (source !== null) set.add(source);
  }
  return set;
}

/**
 * HOW LONG AFTER A STAY A PAYMENT MAY ARRIVE AND STILL SETTLE IT, in whole days — the window for a
 * candidate that BEGAN on or before the credit's `paidDate`, measured (via `intervalDistance`) from
 * the day the stay ENDED. A payment made DURING a stay is 0 days from it and is inside this window
 * by construction, which is the point: it is neither late nor a prepayment, and the work was under
 * way, so it belongs on this side.
 *
 * Date proximity is the ONLY matching rule here, and it only carries signal while the candidates
 * are actually near. Without a floor, a stay 600 days away beats one 601 days away and the result
 * is reported as a confident proposal: the tie check refuses two candidates that are equally near,
 * but nothing refused two that are equally MEANINGLESS. That is the same guess
 * `docs/superpowers/specs/2026-08-10-payment-attribution-design.md` rejects — ambiguity reported,
 * never resolved by picking — arriving through a door the tie check does not watch.
 *
 * THE NUMBER, MEASURED. A dry run over the live `brad-paws` tenant (payments from Aug 2023, only
 * July 2026 bookings adopted) produced 47 proposals / 77 splits distributed like this:
 *
 *   same week          2 splits    $80
 *   same month         1 split     $40
 *   2–6 months         3 splits   $120
 *   6–18 months       19 splits   $505
 *   over 18 months    52 splits $1,895   ← 72% of the money
 *
 * At those distances the proposer is a conveyor belt, not a judgment: one household's $42 credit
 * was split $5 onto one walk and $37 onto the next purely because that is where the running
 * bucket happened to be full. A sitter reads a proposal as a judgment, so the honest answer is a
 * refusal she can place herself.
 *
 * 90 days is DELIBERATELY GENEROUS IN THIS DIRECTION, and generous is the right direction to err
 * here: the sitter named this exact case — *"someone may forget to pay one week and then send 2
 * weeks in one payment"* — and settling weeks late, or bundling several weeks into one transfer,
 * is ordinary rather than exceptional. A payment more than a quarter after any stay it could have
 * paid for is not a proximity match; it is the absence of one. Raise this only against a
 * measurement, and never to make a batch look tidier.
 */
export const MAX_LATE_PAYMENT_DAYS = 90;

/**
 * HOW FAR AHEAD OF A STAY A PAYMENT MAY ARRIVE AND STILL BE READ AS PREPAYING IT, in whole days —
 * the window for a candidate whose `startDate` falls AFTER the credit's `paidDate`, measured from
 * that start date — the one endpoint that does not move when the stay is a range, because money
 * that arrived before the work began is early by however long it is until the work begins.
 * DELIBERATELY TIGHTER than `MAX_LATE_PAYMENT_DAYS`, because the two directions are not the same
 * event.
 *
 * A payment settles services that have already happened; that is the ordinary direction, and it
 * is why the windows are asymmetric at all. Money arriving BEFORE a stay is a real thing too — a
 * deposit on a booking coming up — but it is money for something imminent and named, not for a
 * pack walk a quarter out. A credit 84 days ahead of a walk is not a prepayment for that walk; it
 * is the absence of a match, and the honest answer is to say so.
 *
 * THE NUMBER, MEASURED. The same live tenant, re-measured after the staleness floor landed: 53 of
 * 58 remaining splits ($2,345 of $2,640) were payments made ~84–90 days BEFORE the stay they were
 * matched to — April/May money landing on July walks purely because the April/May walks have not
 * been adopted from the calendar yet. Only 5 splits ($295) were paid on or after their stay.
 * Those 53 are exactly what a symmetric 90-day window cannot tell apart from a real prepayment,
 * and 30 days is the line that separates "a deposit on the stay coming up" from "the earlier
 * stays are simply missing from the data".
 */
export const MAX_PREPAYMENT_DAYS = 30;

/**
 * HOW FAR FROM THE PAYMENT A STAY MAY BE AND STILL RECEIVE A LEFTOVER — the bound on the SECOND
 * and later stays only, in whole days. Deliberately much tighter than either primary window,
 * because a spill is a different claim from a match: the primary windows have to tolerate someone
 * settling up months late for ONE stay, whereas a payment that bundles SEVERAL stays is covering a
 * batch from around the same fortnight — a client sending two or three weeks of walks in one
 * transfer, which is the case the sitter actually named.
 *
 * SECONDARY, AND SAID PLAINLY: the load-bearing rule is the full-settlement one below, not this
 * number. The measured cases are separated by COVERAGE, not distance — Kelly Snider's bad $10
 * spill was 12 days out while several of Jenna Siflinger's good ones were 9, so no distance bound
 * could have told those two apart. This exists because the sitter asked for a bound, and because a
 * leftover that exactly settles a stay from months ago is still a coincidence rather than a
 * judgment. If the two rules ever seem to disagree, the full-settlement one is the one to trust.
 */
export const MAX_SPILL_DAYS = 14;

export type UnpaidBooking = {
  bookingId: string;
  startDate: string;
  /**
   * The stay's exclusive checkout, or `null` for a SINGLE-DAY service. Nullability is how the
   * schema itself draws the range/single distinction (`BookingRequests.EndDate` — "exclusive
   * checkout for boarding/blocked ranges; NULL for single-day walks"), stamped at insert from the
   * service's `shape` (`server/lib/booking-ops.ts`: `shape === 'range' ? end : null`). So reading
   * the column is reading the shape; nothing here needs the service row to know which it has.
   */
  endDate: string | null;
  outstanding: number;
};
export type Credit = { paymentId: string; amount: number; paidDate: string };
export type Split = { bookingId: string; amount: number };
export type Proposal =
  | { ok: true; paymentId: string; splits: Split[]; remainder: number }
  | {
      ok: false;
      paymentId: string;
      reason:
        | 'no-unpaid-bookings'
        | 'no-recent-booking'
        | 'ambiguous'
        | 'invalid-date'
        | 'invalid-amount'
        | 'duplicate-booking-id';
      detail: string;
    };

/** `value` (optionally carrying a `T…` time-of-day) names a real calendar day. */
function isUsableDate(value: string): boolean {
  return isRealDate(value.split('T')[0]);
}

/**
 * HOW FAR A PAYMENT IS FROM A STAY — measured to the WHOLE INTERVAL `[startDate, endDate]`, not to
 * a point. THE ONE PLACE the question is answered, deliberately: the directional windows,
 * `MAX_SPILL_DAYS` and `proximityRank` (which every ordering in the feature goes through) all ask
 * it, and any one of them measuring differently is a rule that silently disagrees with the rest.
 *
 *   paid date INSIDE the stay  → 0     (the money arrived while the work was under way)
 *   paid date BEFORE the stay  → days to `startDate`
 *   paid date AFTER  the stay  → days to `endDate`
 *
 * WHY, IN THE SITTER'S OWN WORDS: *"This payment is in August. The end date is far away. Not all
 * payments should be windowed by start date — end date is also a consideration."* Measuring from
 * the start alone is right for a pack walk, which begins and ends the same day, and wrong for a
 * stay that spans weeks: her house sit ran 2026-07-29 → 2026-08-21 and the client sent money on
 * 2026-08-18 — while the sitter was in the house — which a start-date rule reads as 20 days late,
 * far enough to lose the stay to any short booking nearer the payment, and far enough to fall out
 * of the windows entirely once the stay is longer still.
 *
 * A SINGLE-DAY SERVICE IS UNCHANGED, exactly. `endDate` is NULL there (see `UnpaidBooking`), the
 * interval collapses to the start date, and every distance is the one this module computed before.
 * A stored end BEFORE its own start is not an interval either, and collapses the same way rather
 * than being trusted into a negative-width span.
 */
function intervalDistance(booking: UnpaidBooking, paidDate: string): number {
  const start = parseDateUtc(booking.startDate);
  const paid = parseDateUtc(paidDate);
  if (paid < start) return (start - paid) / MS_PER_DAY;
  const end = booking.endDate === null ? start : Math.max(start, parseDateUtc(booking.endDate));
  return paid > end ? (paid - end) / MS_PER_DAY : 0;
}

/**
 * Does this stay begin AFTER the payment was made? The signed half of proximity, kept alongside
 * `intervalDistance` rather than folded into it: distance answers "how near", this answers "which
 * side", and every rule below needs both.
 *
 * MEASURED FROM THE START, AND ONLY THE START, which is what makes the three cases come out right
 * once distance is an interval. "Prepayment" means money that arrived before the work began, so it
 * is exactly `startDate > paidDate`. Everything else — a payment ON the first day, DURING the stay,
 * or after checkout — is the late side, and that is the correct home for a payment made mid-stay:
 * the work was under way, so the money settles rather than anticipates, and it must rank with the
 * stays behind the payment rather than the ones still to come. A stay ON the paid date is likewise
 * not after it — same-day is settlement, the strongest match there is. Compared through the same
 * `parseDateUtc` as the distance, so a `T…` time-of-day on either date is stripped identically and
 * can never flip a same-day stay to the future side.
 */
function isAfterPaymentDate(startDate: string, paidDate: string): boolean {
  return parseDateUtc(startDate) > parseDateUtc(paidDate);
}

/** The proximity window a candidate on this side of the payment must fall inside. */
function proximityWindow(startDate: string, paidDate: string): number {
  return isAfterPaymentDate(startDate, paidDate) ? MAX_PREPAYMENT_DAYS : MAX_LATE_PAYMENT_DAYS;
}

/**
 * HOW FAR BEHIND EVERY SETTLING CANDIDATE A PREPAYMENT RANKS — added to a future-side candidate's
 * distance in `proximityRank` so that SIDE dominates DISTANCE, exactly as the doctrine at the top
 * of this file says it must. Any value above the widest window would do (a rank is only ever
 * compared for a candidate inside `MAX_LATE_PAYMENT_DAYS` / `MAX_PREPAYMENT_DAYS`, so a raw
 * distance can never reach it); a round million is used so the two halves of a rank read apart at
 * a glance in a failing test.
 */
export const PREPAYMENT_RANK_OFFSET = 1_000_000;

/**
 * THE ONE ORDERING KEY OF THIS ENTIRE FEATURE — lower is the better claim on a stay. Side first
 * (every candidate on or before the paid date outranks every candidate after it, at any distance),
 * then distance, nearest first, then — and only as a tie-break among candidates side and distance
 * have already declared equal — AMOUNT CONGRUENCE. It is a plain number, comparable with `<` and
 * `-`, so a sort, a tie test and a cross-credit comparison are all written against the same value
 * rather than against three re-derivations of it.
 *
 * CONGRUENCE IS STRICTLY THE LAST TERM, and `CONGRUENCE_RANK_BONUS` (half a day, against distances
 * that are always whole days) is what enforces that in arithmetic rather than in prose. It cannot
 * widen a window, cannot cross the side boundary, and cannot beat a candidate one day nearer. A
 * caller that passes no `Congruence` gets exactly the key this function returned before congruence
 * existed — the parameter is optional precisely so that adding household knowledge is a decision a
 * caller makes, never a default it inherits.
 *
 * EVERY ORDERING IN THIS FEATURE GOES THROUGH HERE, AND THEY MUST NEVER DIVERGE AGAIN. They did,
 * and it cost two systematic misattributions — the bug this key was introduced to kill
 * (`attribution-unify-distance`): `proposeAttribution` ordered its own candidates side-first while
 * the CROSS-CREDIT ranking that decides which credit is proposed each round — `nearestCandidateRank`
 * below, and the preview route's spill-contention filter — used raw, side-blind days. Neither
 * consequence was occasional:
 *
 *   1. OPPOSITE-SIDE TIES RESOLVED BACKWARDS, STRUCTURALLY. A stay with one credit five days after
 *      it and another five days before it ranked both at 5, and the oldest-paid tie-break then
 *      handed the stay to the PREPAYMENT every time — because at equal raw distance the earlier
 *      paid date IS the early side. The reading this module calls secondary won by default.
 *   2. A CREDIT COULD WIN ITS ROUND ON A STAY IT NEVER FUNDED. Ranked at 3 days on a stay ahead of
 *      it while sitting 40 days behind another, it won the queue on the near one, then allocated
 *      past-first and spent itself on the far one — and the stay that won it the round went to a
 *      worse-placed credit, or to nobody.
 */
/**
 * HOW MUCH BETTER A CONGRUENT CANDIDATE RANKS THAN AN OTHERWISE IDENTICAL ONE — the third and
 * LOWEST-PRIORITY term of `proximityRank`, subtracted after side and distance have already been
 * combined. Composite ordering: SIDE → DISTANCE → CONGRUENCE, and this number is what makes that
 * ordering true rather than merely intended.
 *
 * HALF A DAY, AND THE HALF IS LOAD-BEARING. Every distance this module computes is a whole number
 * of calendar days — `intervalDistance` divides by `MS_PER_DAY` on values `parseDateUtc` has
 * already floored to midnight, stripping any `T…` time-of-day — so the smallest gap two distinct
 * distances can have is 1. A bonus strictly below 1 can therefore ONLY separate candidates whose
 * proximity is exactly equal; it can never move a congruent stay past one that is even a single day
 * nearer. And it is nowhere near `PREPAYMENT_RANK_OFFSET`, so it can never carry a prepayment
 * across the side boundary either. Raising it to 1 would silently promote congruence above
 * distance, which is the mutation the "never beats distance" test exists to catch.
 *
 * IT WIDENS NOTHING. The bonus is applied to a rank, and a rank is only ever computed for a
 * candidate that has already passed the directional window test (`candidateRank`) or the `nearby`
 * filter (`proposeAttribution`). A distant exact match is not a near one; it is refused.
 */
export const CONGRUENCE_RANK_BONUS = 0.5;

/**
 * THE CREDIT-SIDE HALF OF CONGRUENCE — the amount being ranked, plus the household's distinctive
 * amounts. Both are needed and neither is enough: exactness alone is what the measurement below
 * says is near-signal-free, and a distinctive-amount set says nothing until a specific credit is
 * compared against a specific stay.
 */
export type Congruence = {
  /** The amount of the credit whose claim on a stay is being ranked. */
  creditAmount: number;
  /** This household's one-to-one amounts — the output of `distinctiveAmounts`. */
  distinctiveAmounts: ReadonlySet<number>;
};

/**
 * THE AMOUNTS THAT MEAN SOMETHING IN THIS HOUSEHOLD — every amount matched by EXACTLY ONE unpaid
 * stay's outstanding AND EXACTLY ONE unattributed credit. A one-to-one correspondence, and nothing
 * weaker.
 *
 * WHY THE GATE IS THIS STRICT, MEASURED. The sitter asked for exactness directly: *"a $100 payment
 * near a $100 stay is a strong signal."* True in principle, and nearly signal-free on her live
 * data. Across 48 households there are exactly THREE cases where one credit of $X faces one stay
 * owing $X — and all three are $40, against 151 credits of $40, 143 of $30, 86 of $60, and 39 stays
 * owing $40. Her genuinely distinctive stays ($2,530, $400, $300, $180) each occur once and none
 * has an exactly-matching credit at all. So on a uniform $40 walk, "exact" identifies one of 151
 * indistinguishable credits; on a $2,530 house sit it would be near-conclusive. Distinctiveness is
 * the difference between those two, and it is why 151 identical credits can never claim each
 * other's stays through this rule.
 *
 * TWO PLAIN NUMBER LISTS rather than bookings and payment rows, because that is genuinely all this
 * question needs, and because the caller that has both lists (the preview route, which already
 * holds a household's live outstanding map and its credit rows) can answer it without building a
 * single throwaway object.
 *
 * OUTSTANDINGS ARE FILTERED THE WAY THE PROPOSER FILTERS THEM — `> 0`, so a settled stay cannot
 * make an amount ambiguous, and an unreadable one (`NaN`) is excluded by the same comparison rather
 * than counted as its own distinct amount. Unreadable outstandings are refused outright by
 * `proposeAttribution`; nothing here has to diagnose them.
 */
export function distinctiveAmounts(outstandings: number[], creditAmounts: number[]): Set<number> {
  const stays = new Map<number, number>();
  for (const outstanding of outstandings) {
    if (!(outstanding > 0)) continue;
    stays.set(outstanding, (stays.get(outstanding) ?? 0) + 1);
  }
  const credits = new Map<number, number>();
  for (const amount of creditAmounts) credits.set(amount, (credits.get(amount) ?? 0) + 1);

  const distinctive = new Set<number>();
  for (const [amount, count] of stays)
    if (count === 1 && credits.get(amount) === 1) distinctive.add(amount);
  return distinctive;
}

/**
 * Does this credit settle this stay EXACTLY, on an amount that is one-to-one in the household?
 * Both halves, never one: exactness alone is 151 credits claiming each other's $40 walks.
 *
 * `congruence === undefined` means the caller holds no household knowledge — the pure proposer
 * called with two arguments, as every test written before this feature calls it — and the answer is
 * simply "no". Congruence is an OPTIONAL refinement of an ordering that is already total; nothing
 * degrades without it.
 */
function isCongruent(booking: UnpaidBooking, congruence?: Congruence): boolean {
  if (congruence === undefined) return false;
  return (
    booking.outstanding === congruence.creditAmount &&
    congruence.distinctiveAmounts.has(congruence.creditAmount)
  );
}

export function proximityRank(
  booking: UnpaidBooking,
  paidDate: string,
  congruence?: Congruence,
): number {
  const distance = intervalDistance(booking, paidDate);
  const proximity = isAfterPaymentDate(booking.startDate, paidDate)
    ? PREPAYMENT_RANK_OFFSET + distance
    : distance;
  // SUBTRACTED LAST, FROM THE COMBINED PROXIMITY — so it can only ever separate candidates that
  // side and distance have already declared equal. See `CONGRUENCE_RANK_BONUS` for why half a day
  // is the value that makes "strictly lower priority" a property of the arithmetic rather than a
  // claim in a comment.
  return isCongruent(booking, congruence) ? proximity - CONGRUENCE_RANK_BONUS : proximity;
}

/**
 * HOW GOOD A CLAIM THIS PAYMENT HAS ON THIS STAY, as a `proximityRank` — or `null` when the stay is
 * not a candidate for that payment at all: unreadable dates on either side, or a distance outside
 * the directional window that applies (`MAX_LATE_PAYMENT_DAYS` behind the payment,
 * `MAX_PREPAYMENT_DAYS` ahead of it). Deliberately says nothing about `outstanding` — that is the
 * caller's question, and the two callers ask it differently.
 *
 * THE ONE ANSWER TO "IS THIS STAY A MATCH FOR THIS PAYMENT, AND HOW GOOD A ONE", shared by
 * `nearestCandidateRank` below (which ranks a household's credits by it) and by the preview
 * route's cross-credit exclusion (which drops from a credit's candidate list any stay a different,
 * not-yet-proposed credit of the same household is STRICTLY better placed on). Both are decisions
 * ACROSS credits, which is why neither lives in `proposeAttribution` — and both answer with the
 * same key the proposer orders by, which is the whole point: see `proximityRank` for what a second
 * notion of closeness cost the one time there was one.
 */
export function candidateRank(
  booking: UnpaidBooking,
  paidDate: string,
  congruence?: Congruence,
): number | null {
  if (!isUsableDate(paidDate) || !isUsableDate(booking.startDate)) return null;
  // An unreadable END is skipped for the same reason an unreadable start is: the distance would be
  // `NaN`, and the refusal (with its reason and its sentence) belongs to `proposeAttribution`.
  if (booking.endDate !== null && !isUsableDate(booking.endDate)) return null;
  if (intervalDistance(booking, paidDate) > proximityWindow(booking.startDate, paidDate))
    return null;
  return proximityRank(booking, paidDate, congruence);
}

/**
 * THE BEST CLAIM THIS CREDIT HAS ON ANY STAY IT COULD ACTUALLY BE PLACED ON, as a `proximityRank`
 * — or `null` when there is no such stay at all. The one number a caller needs to decide WHICH
 * CREDIT GOES NEXT, and nothing more.
 *
 * A RANK RATHER THAN A DAY COUNT, and that is load-bearing rather than cosmetic: the stay a credit
 * is ranked on has to be the stay `proposeAttribution` would actually fund FIRST, or a credit wins
 * its round on a claim it never makes and spends itself elsewhere (see `proximityRank`, failure 2).
 * Because both sides now go through that one key, the minimum taken here IS the head of the order
 * the proposer allocates in — by construction, not by inspection.
 *
 * WHY THIS EXISTS SEPARATELY FROM `proposeAttribution`. Proposing is a decision about one credit
 * against one candidate list; ordering a household's credits is a decision ACROSS credits, and it
 * belongs to the caller that holds them all (the preview route, where the per-household loop and
 * its decrementing outstanding map already live). Left to oldest-`PaidDate`-first, that caller
 * makes the placement every credit-local rule is powerless to stop: the oldest credit greedily
 * takes its own nearest stay, consumes it, and a credit that lands ON one of those stays finds
 * nothing left. Nothing inside `proposeAttribution` can see that, because by construction it never
 * sees the other credits.
 *
 * A HELPER RATHER THAN A WIDER RETURN SHAPE, deliberately: `proposeAttribution` stays PURE and its
 * `Proposal` union keeps meaning exactly what it means today ("here is the split, or here is why
 * there isn't one"). Ranking needs an answer for credits it is NOT proposing yet, and asking the
 * proposer for one would mean either running the full allocation n² times or widening a refusal to
 * carry a distance it was refusing to act on.
 *
 * ELIGIBILITY IS THE SAME QUESTION `proposeAttribution` ASKS, and it is asked here through
 * `candidateRank` rather than re-derived: only stays with outstanding left, inside the
 * directional windows, on readable dates. A ranking that counted a stay the proposer would then
 * drop would send a credit to the front of the queue for a match it cannot make. `null` therefore
 * means "this credit has nothing to claim right now" — the caller's signal to rank it last, not a
 * refusal in its own right; the refusal, with its reason and its sentence, still comes from
 * `proposeAttribution` alone.
 */
export function nearestCandidateRank(
  paidDate: string,
  bookings: UnpaidBooking[],
  congruence?: Congruence,
): number | null {
  let best: number | null = null;
  for (const b of bookings) {
    if (!(b.outstanding > 0)) continue;
    const rank = candidateRank(b, paidDate, congruence);
    if (rank === null) continue;
    if (best === null || rank < best) best = rank;
  }
  return best;
}

export function proposeAttribution(
  credit: Credit,
  bookings: UnpaidBooking[],
  householdDistinctiveAmounts?: ReadonlySet<number>,
): Proposal {
  if (!Number.isInteger(credit.amount) || credit.amount < 0) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-amount',
      detail: `Payment ${credit.paymentId} has a non-whole-dollar or negative amount (${credit.amount}); refusing rather than risk a fractional or negative split.`,
    };
  }

  if (!isUsableDate(credit.paidDate)) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-date',
      detail: `Payment ${credit.paymentId} has an unreadable paid date ("${credit.paidDate}"); refusing rather than sort against an undefined distance.`,
    };
  }

  // Validated against ALL bookings, before the `outstanding > 0` filter below: both `NaN > 0`
  // and `-50 > 0` are false, so an unreadable outstanding would otherwise be silently dropped
  // from consideration rather than refused — indistinguishable from a booking that is genuinely
  // settled. Unreadable is not the same as zero.
  const badOutstanding = bookings.find(
    (b) => !Number.isInteger(b.outstanding) || b.outstanding < 0,
  );
  if (badOutstanding) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-amount',
      detail: `Booking ${badOutstanding.bookingId} has an unreadable outstanding amount (${badOutstanding.outstanding}); refusing rather than silently drop it from consideration.`,
    };
  }

  const unpaid = bookings.filter((b) => b.outstanding > 0);
  if (unpaid.length === 0) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'no-unpaid-bookings',
      detail: `No unpaid bookings to attribute payment ${credit.paymentId} against.`,
    };
  }

  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const b of unpaid) {
    if (seen.has(b.bookingId)) duplicateIds.add(b.bookingId);
    seen.add(b.bookingId);
  }
  if (duplicateIds.size > 0) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'duplicate-booking-id',
      detail: `Booking id(s) ${[...duplicateIds].join(', ')} appear more than once among this household's unpaid bookings; refusing rather than risk applying the credit to the same booking twice.`,
    };
  }

  const badDate = unpaid.find((b) => !isUsableDate(b.startDate));
  if (badDate) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-date',
      detail: `Booking ${badDate.bookingId} has an unreadable start date ("${badDate.startDate}"); refusing rather than sort against an undefined distance.`,
    };
  }

  // The END is just as load-bearing as the start now that distance is measured to the whole
  // interval — an unreadable one makes `intervalDistance` `NaN`, which compares false against every
  // ceiling and would drop the booking silently instead of refusing. NULL is not unreadable: it is
  // how a single-day service says it has no end at all.
  const badEndDate = unpaid.find((b) => b.endDate !== null && !isUsableDate(b.endDate));
  if (badEndDate) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-date',
      detail: `Booking ${badEndDate.bookingId} has an unreadable end date ("${badEndDate.endDate}"); refusing rather than sort against an undefined distance.`,
    };
  }

  // THE STALENESS FLOOR, APPLIED TO THE CANDIDATE LIST RATHER THAN TO THE CREDIT — see
  // `MAX_LATE_PAYMENT_DAYS` / `MAX_PREPAYMENT_DAYS`. Filtering, not refusing wholesale, is the
  // whole point: a credit that genuinely settles a nearby stay must still settle it, with anything
  // left over becoming `remainder` instead of dribbling onto a stay two years away. Only when
  // NOTHING is near enough is there no proximity match to report at all.
  //
  // Which window applies depends on WHICH SIDE of the payment the stay falls — the generous one
  // behind it, the tight one ahead of it — so the filter asks `proximityWindow` per candidate
  // rather than comparing against a single ceiling.
  //
  // It runs here, after the date and amount guards and after `no-unpaid-bookings`, because it
  // depends on both: a distance off an unreadable date is `NaN` (which compares false against any
  // ceiling, so an unreadable booking would be silently filtered out rather than refused), and
  // "this household is settled" is a different fact from "nothing is near enough" that the sitter
  // acts on differently.
  const nearby = unpaid.filter(
    (b) => intervalDistance(b, credit.paidDate) <= proximityWindow(b.startDate, credit.paidDate),
  );
  if (nearby.length === 0) {
    // `unpaid` is non-empty here (checked above), so this reduce needs no seed.
    const nearest = unpaid.reduce((best, b) =>
      intervalDistance(b, credit.paidDate) < intervalDistance(best, credit.paidDate) ? b : best,
    );
    // Rounded for the SENTENCE only, never for the comparison above: a `paidDate` carrying a
    // time-of-day makes every distance fractional, and "612.5 days" is noise in a sitter's ear.
    const gap = Math.round(intervalDistance(nearest, credit.paidDate));
    // DIRECTION IS PART OF THE DIAGNOSIS, not decoration: "the nearest stay is 84 days later" and
    // "84 days earlier" tell the sitter two completely different things about her data — the first
    // that the stays this money paid for have not been adopted yet, the second that the payment is
    // ahead of anything it could plausibly be a deposit for.
    const after = isAfterPaymentDate(nearest.startDate, credit.paidDate);
    // WHICH ENDPOINT THE GAP WAS MEASURED FROM IS NAMED, because it is now a real choice and a
    // sentence that names the other one is a sentence the sitter cannot check. Nothing reaching
    // here is INSIDE a stay (that distance is 0, which is under every window), so a candidate is
    // either ahead of the payment — measured, as always, from the day it starts — or behind it,
    // measured from the day it ended, when it has an end at all. A single-day service has none,
    // so it keeps the sentence it has always had.
    const measuredFrom =
      !after && nearest.endDate !== null
        ? `ends ${nearest.endDate.split('T')[0]}`
        : `starts ${nearest.startDate.split('T')[0]}`;
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'no-recent-booking',
      detail:
        `The nearest unpaid stay to payment ${credit.paymentId} ${measuredFrom}, ${gap} days ${after ? 'after' : 'before'} it — ` +
        (after
          ? `further ahead than the ${MAX_PREPAYMENT_DAYS} days within which a payment reads as prepaying a stay still to come. `
          : `further back than the ${MAX_LATE_PAYMENT_DAYS} days within which a payment reads as settling a stay that already happened. `) +
        `If you know which stay this paid for, choose it yourself.`,
    };
  }

  // Order by `proximityRank` — PAST FIRST: every candidate on or before the paid date, nearest
  // first, then every candidate after it, nearest first. The direction term dominates, so a stay a
  // week behind the payment outranks one a week ahead of it instead of tying with it — the
  // forgotten week beats the undelivered one, which is the whole shape of the change. Ties within
  // one direction are left in place here — grouping and refusing an unresolved tie happens
  // explicitly below, not by however `sort` happens to order equal elements.
  //
  // THE KEY IS SHARED, NOT RESTATED. This sort used to spell the side-then-distance comparison out
  // by hand, and the cross-credit ranking that feeds this function then answered a DIFFERENT
  // question — see `proximityRank` for the two misattributions that produced. Both call it now;
  // neither may go back to computing its own.
  const congruence: Congruence | undefined =
    householdDistinctiveAmounts === undefined
      ? undefined
      : { creditAmount: credit.amount, distinctiveAmounts: householdDistinctiveAmounts };

  const ordered = [...nearby].sort(
    (a, b) =>
      proximityRank(a, credit.paidDate, congruence) - proximityRank(b, credit.paidDate, congruence),
  );

  let remaining = credit.amount;
  const splits: Split[] = [];
  let i = 0;

  while (i < ordered.length && remaining > 0) {
    // Collect every booking tied with ordered[i] for "nearest" — a contiguous run in sorted
    // order, since equal sort keys sort adjacent to each other. Tied means EQUAL `proximityRank`,
    // the same key the sort above used: a stay 7 days behind the payment and one 7 days ahead of
    // it are the same number of days out but not the same candidate, and treating them as tied is
    // exactly the bug direction fixed.
    //
    // `distance` is the RAW day count, kept separately because `MAX_SPILL_DAYS` below is a
    // statement about days, not about rank.
    const rank = proximityRank(ordered[i], credit.paidDate, congruence);
    const distance = intervalDistance(ordered[i], credit.paidDate);
    let j = i;
    while (
      j + 1 < ordered.length &&
      proximityRank(ordered[j + 1], credit.paidDate, congruence) === rank
    ) {
      j++;
    }
    const group = ordered.slice(i, j + 1);

    // THE SPILL RULE — everything below applies to the SECOND and later stays only. The nearest
    // stay is a MATCH: this credit is the money for that stay, and part-paying it is a deposit,
    // an ordinary thing a sitter records. Every stay after it is a SPILL: a claim that one
    // payment covered several stays, which is only credible when the money actually finishes each
    // one off.
    //
    // Measured on the live tenant: every good spill fully settles what it lands on (Jenna's $120
    // onto four walks at exactly $30, Dwayne's $175 onto three at exactly $40, Asja's $1,340
    // across eleven stays each covered in full). The one bad spill is the only partial — Kelly
    // Snider's $50 settling a $40 walk and then dribbling $10 onto a $100 boarding twelve days
    // earlier, which is a tip on the walk being reported as a tenth of a boarding.
    //
    // `splits.length > 0` is exactly "a stay has already been funded": `remaining > 0` guards the
    // loop and every branch below funds a strictly positive amount, so the first pass through
    // here is the only one with no splits behind it.
    const isSpill = splits.length > 0;

    // The proximity half — see `MAX_SPILL_DAYS`, and note it is the secondary rule. It is checked
    // before the group is examined at all, because a group beyond the bound is not a spill target
    // in the first place: exactly as with a tie the credit could never have afforded, there is no
    // decision here for the sitter to be asked about, so the rest becomes `remainder`.
    if (isSpill && distance > MAX_SPILL_DAYS) break;

    if (group.length === 1) {
      const booking = group[0];
      // The full-settlement half, and the load-bearing one. Stopping — rather than skipping ahead
      // to some cheaper stay further out that the leftover COULD settle — is the same promise the
      // unaffordable-tie case below keeps: nearest-first is the order this function proposes in,
      // not a suggestion it routes around when the front of the line gets stuck.
      if (isSpill && remaining < booking.outstanding) break;
      const take = Math.min(remaining, booking.outstanding);
      splits.push({ bookingId: booking.bookingId, amount: take });
      remaining -= take;
      i = j + 1;
      continue;
    }

    // A genuine tie among two or more bookings — and one needing no separate full-settlement
    // check of its own, spill or not: the branches below already fund a tied group ONLY when
    // `remaining` covers every member outright, and otherwise stop or refuse.
    const smallestOutstanding = Math.min(...group.map((b) => b.outstanding));
    if (remaining < smallestOutstanding) {
      // WHETHER THIS IS A DECISION OR A LEFTOVER DEPENDS ENTIRELY ON WHETHER ANYTHING WAS FUNDED,
      // and the two answers are not close together. `splits.length === 0` means the credit funded
      // NOTHING and this tie is the reason: a $50 credit against two equidistant $100 boardings
      // is a real question — which stay is it a deposit on? — and only the sitter can answer it.
      // This used to be called "moot" and reported as `ok` with `splits: []` and the whole amount
      // as `remainder`, which was worse than saying nothing: a confident-looking proposal that
      // proposed nothing, and one `applyAttribution` (server/db/repo.ts) refuses outright because
      // a zero-split attribution is not applicable. Refusing as `ambiguous` puts the choice where
      // it belongs, with the tied stays named — and the preview route already treats that reason
      // as placeable, so the sitter gets them as candidates.
      if (splits.length === 0) {
        return {
          ok: false,
          paymentId: credit.paymentId,
          reason: 'ambiguous',
          detail:
            `Payment ${credit.paymentId} is equidistant from bookings ${group.map((b) => b.bookingId).join(', ')}, ` +
            `and does not fully cover any of them — choose which one it is a deposit on.`,
        };
      }
      // Something WAS funded, so this credit is not stuck: it settled the stay it is for, and what
      // is left is a leftover rather than a claim. Stop here rather than reaching past the
      // unaffordable tied group to fund a farther, cheaper, unambiguous booking later in
      // `ordered` — skipping ahead would be a judgment call about which stay the sitter meant to
      // settle, and nearest-first order is a promise this function keeps, not a suggestion it
      // routes around when the front of the line gets stuck. The unspent amount is reported as
      // `remainder`, not lost.
      break;
    }

    const totalOutstanding = group.reduce((sum, b) => sum + b.outstanding, 0);
    if (remaining >= totalOutstanding) {
      // Every tied booking gets paid in full — again nothing to choose between them.
      for (const booking of group) {
        splits.push({ bookingId: booking.bookingId, amount: booking.outstanding });
        remaining -= booking.outstanding;
      }
      i = j + 1;
      continue;
    }

    // The credit can fully fund at least one tied booking but not all of them: which one(s) is
    // the sitter's call, not ours.
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'ambiguous',
      detail:
        `Payment ${credit.paymentId} is equidistant from bookings ${group.map((b) => b.bookingId).join(', ')}, ` +
        `and does not cover all of them — choose which to attribute it to.`,
    };
  }

  return { ok: true, paymentId: credit.paymentId, splits, remainder: remaining };
}
