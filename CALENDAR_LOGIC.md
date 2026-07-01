# Booking Calendar Logic (portable)

A self-contained specification + reference implementation of the booking
calendar's **date arithmetic** and **capacity / conflict engine**. Copy the two
code blocks below into any TypeScript project (they have zero external
dependencies) and the accompanying rules explain _why_ they work the way they
do.

Originally extracted from `@brad-paws/shared` (`util/dates.ts` +
`booking/capacity.ts`) — a pet-boarding scheduler. Rename the service types to
suit your domain.

---

## 1. The core modeling decision

**Booking dates are abstract calendar days, not instants.**

A date like `2026-06-07` means "the June 7th business day", _not_ a moment in
time. To do arithmetic on these without a timezone silently shifting them, we
anchor every date string to **UTC midnight** via `Date.UTC(...)`. All day/night
math is then integer arithmetic over `MS_PER_DAY`.

Consequences:

- **DST-immune.** Adding a day is always `+86_400_000` ms; no 23- or 25-hour
  days can creep in because we never touch a real local timezone during
  arithmetic.
- **Runtime-independent.** Works identically on a server running in UTC and in a
  browser running in any zone. The runtime's local timezone is only consulted
  when _displaying_ dates or asking "what day is it right now" (see
  `getPacificDateStr`).

**`endDate` is exclusive — it is the checkout day, with no overnight.**

A stay from `Jun 7` → `Jun 12` occupies the nights of the 7th, 8th, 9th, 10th,
and 11th = **5 nights**. The 12th is checkout. This is why:

- `nightsBetween(checkIn, checkOut)` is a plain subtraction.
- Every range loop iterates `for (date = start; date < endExclusive; ...)`.
- The last _occupied_ night is `addDays(endExclusive, -1)`.

Pick one convention and hold it everywhere; mixing inclusive/exclusive ends is
the #1 source of off-by-one booking bugs.

---

## 2. Date utilities (dependency-free)

Everything below depends only on `parseDateUtc`, `addDays`, and `MS_PER_DAY`.
Drop this in as `dates.ts`.

```ts
/** Milliseconds in one day. */
export const MS_PER_DAY = 86_400_000;

/** The business timezone. All "local" date math/formatting routes through this. */
export const BUSINESS_TZ = 'America/Los_Angeles'; // change to your business's zone

/** Split a `YYYY-MM-DD` (or ISO `YYYY-MM-DDTHH:MM:SS…`) into `[year, monthIndex, day]`. */
function ymd(dateStr: string): [number, number, number] {
  const [year, month, day] = dateStr.split('T')[0].split('-').map(Number);
  return [year, month - 1, day]; // month is 0-based for Date.*
}

/**
 * Parse a `YYYY-MM-DD` string to the UTC milliseconds of that calendar date at
 * midnight. This anchoring is what makes all downstream arithmetic timezone-
 * neutral. Every other helper here builds on it.
 */
export function parseDateUtc(dateStr: string): number {
  return Date.UTC(...ymd(dateStr));
}

/**
 * Add `days` (may be negative) to a `YYYY-MM-DD` date, returning `YYYY-MM-DD`.
 * Pure calendar arithmetic, DST-immune. The one stepper used everywhere.
 */
export function addDays(dateStr: string, days: number): string {
  return new Date(parseDateUtc(dateStr) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The single source of truth for counting nights in a booking.
 * `checkIn` is the inclusive first night; `checkOutExclusive` is checkout (no
 * overnight). Jun 7 → Jun 12 = 5 nights. DST-immune.
 */
export function nightsBetween(checkIn: string, checkOutExclusive: string): number {
  return Math.round((parseDateUtc(checkOutExclusive) - parseDateUtc(checkIn)) / MS_PER_DAY);
}

/**
 * Today (or `date`) as a `YYYY-MM-DD` string in the BUSINESS timezone. Use this
 * — not the runtime's local/UTC date — for every "is this in the past / what
 * day is it" check, so a booking near midnight resolves to the correct business
 * day. `en-CA` locale yields `YYYY-MM-DD`.
 */
export function getBusinessDateStr(date: Date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
}
```

> The original also ships `addMonths` (with end-of-month clamping),
> `parseLocalDate`, `parseDateToUtcNoon`, `dateToStr`, `hoursUntilStart` (for
> cancellation-fee windows), and `parseSqliteUtc`. They're independent of the
> capacity engine — copy them only if you need month-stepping, display
> formatting, or SQLite-timestamp parsing.

---

## 3. Domain model & rules

The example domain has four **request** types plus an admin block:

| Type        | Span        | Capacity rule                                    |
| ----------- | ----------- | ------------------------------------------------ |
| `boarding`  | multi-night | **max 2 pets/day** (counted in pets, not events) |
| `house-sit` | multi-night | **max 1/day**, may overlap boarding ≤ 1 day      |
| `walk`      | single-day  | unlimited; only a `blocked` day stops it         |
| `check-in`  | single-day  | unlimited; only a `blocked` day stops it         |
| `blocked`   | any span    | **hard stop** — nothing else may share the day   |

Two subtleties worth internalizing before porting:

1. **Boarding capacity is measured in pets, not bookings.** A single 2-dog
   boarding fills _both_ of the day's 2 slots. Every capacity/conflict function
   takes a `petCount` / `requestPets` so a multi-pet request is checked against
   the actual remaining room.

2. **Bookend sharing (soft boundaries).** The check-in day and checkout day of a
   booking are "boundary" days. A new booking's _endpoint_ may land on an
   existing booking's boundary day even if that day looks full — because one
   booking is arriving as the other departs. **`blocked` days get no boundary**
   (a hard block is never shareable).

---

## 4. Capacity + conflict engine (dependency-free)

Drop this in as `capacity.ts`. It imports only `addDays` from `dates.ts`.

```ts
import { addDays } from './dates';

type RequestType = 'boarding' | 'house-sit' | 'walk' | 'check-in';

export type DayCapacity = {
  boarding: number; // pets boarding this day
  houseSits: number; // house-sits this day
  blocked: number; // admin blocks this day
  isBoundary: boolean; // is this the start/end day of some non-blocked booking?
};

/** A normalized all-day event. `end_date` is EXCLUSIVE (checkout). */
export type CapacityEvent = {
  start_date: string; // YYYY-MM-DD
  end_date?: string; // YYYY-MM-DD exclusive; defaults to a 1-day span
  type: 'boarding' | 'house-sit' | 'blocked';
  /** Pets covered — only meaningful for boarding (max 2/day). Defaults to 1. */
  petCount?: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const emptyDay = (): DayCapacity => ({ boarding: 0, houseSits: 0, blocked: 0, isBoundary: false });

/**
 * Build a per-day capacity map from normalized events (end date exclusive).
 * This is the expensive-ish step — do it ONCE, then answer many queries against
 * the returned map.
 */
export function buildCapacity(events: CapacityEvent[]): Map<string, DayCapacity> {
  const byDate = new Map<string, DayCapacity>();
  const getOrCreate = (dateStr: string): DayCapacity => {
    let state = byDate.get(dateStr);
    if (!state) {
      state = emptyDay();
      byDate.set(dateStr, state);
    }
    return state;
  };

  for (const event of events) {
    const start = event.start_date;
    const end = event.end_date || event.start_date;
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) continue;

    // Blocked events get no boundary — no bookend sharing.
    if (event.type !== 'blocked') {
      getOrCreate(start).isBoundary = true;
      getOrCreate(end).isBoundary = true;
    }

    const boardingPets = Math.max(1, event.petCount ?? 1);
    for (let d = start; d < end; d = addDays(d, 1)) {
      const capacity = getOrCreate(d);
      if (event.type === 'house-sit') capacity.houseSits += 1;
      else if (event.type === 'boarding')
        capacity.boarding += boardingPets; // pets, not events
      else capacity.blocked += 1;
    }
  }

  return byDate;
}

/** Count-blind "is this day full at all" check (2 boarding / 1 house-sit / any block). */
export function isUnavailableDate(capacity: DayCapacity): boolean {
  return capacity.houseSits >= 1 || capacity.boarding >= 2 || capacity.blocked >= 1;
}

/**
 * Raw, COUNT-AWARE per-day decision, WITHOUT the range-endpoint bookend
 * exemptions. Any block or house-sit is a hard stop. For a boarding request the
 * day is full when existing boarding pets + the request's pets exceed 2; for a
 * house-sit request two boardings already fill the day.
 *
 * Export this so per-day cell displays and per-day availability probes ask the
 * SAME question the range check asks — never re-implement the rule.
 */
export function dayBlocksRequest(
  capacity: DayCapacity,
  requestType: 'boarding' | 'house-sit',
  requestPets = 1,
): boolean {
  const pets = Math.max(1, requestPets);
  if (capacity.blocked >= 1 || capacity.houseSits >= 1) return true;
  return requestType === 'boarding' ? capacity.boarding + pets > 2 : capacity.boarding >= 2;
}

/**
 * Does a boarding/house-sit request over [startDate, endDateExclusive) conflict
 * with existing bookings? House sits may overlap boarding by at most one day.
 * The request's own endpoints may share a boundary day (bookend) or a soft
 * bookend where the existing booking ends.
 */
export function rangeHasConflict(
  startDate: string,
  endDateExclusive: string,
  requestType: 'boarding' | 'house-sit',
  capacityByDate: Map<string, DayCapacity>,
  requestPetCount = 1,
): boolean {
  const requestEnd = addDays(endDateExclusive, -1); // last occupied night
  const requestPets = Math.max(1, requestPetCount);
  let houseSitBoardingOverlapDays = 0;

  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    const capacity = capacityByDate.get(date);
    if (!capacity) continue; // empty day = free

    // House sit may overlap boarding by at most ONE day, else conflict.
    if (requestType === 'house-sit' && capacity.boarding > 0) {
      houseSitBoardingOverlapDays += 1;
      if (houseSitBoardingOverlapDays > 1) return true;
    }

    if (!dayBlocksRequest(capacity, requestType, requestPets)) continue;

    // Hard bookend: an endpoint may sit on an existing booking's boundary day.
    const isRequestEndpoint = date === startDate || date === requestEnd;
    if (isRequestEndpoint && capacity.isBoundary) continue;

    // Soft bookend: an unavailable (non-blocked) endpoint is allowed when the
    // NEXT day has room — the existing booking is ending here. Count-aware, so a
    // multi-pet request isn't waved through a still-occupied next day.
    if (isRequestEndpoint && capacity.blocked === 0) {
      const next = capacityByDate.get(addDays(date, 1));
      if (!next || !dayBlocksRequest(next, requestType, requestPets)) continue;
    }

    return true;
  }

  return false;
}

/** Walks / check-ins only conflict with fully-blocked days. */
export function walkHasConflict(date: string, capacityByDate: Map<string, DayCapacity>): boolean {
  return (capacityByDate.get(date)?.blocked ?? 0) >= 1;
}

export interface Opening {
  startDate: string; // YYYY-MM-DD
  endDate?: string; // exclusive checkout, for boarding/house-sit only
}

/**
 * Scan the prebuilt capacity map for available slots between `from` (inclusive)
 * and `to` (inclusive candidate start dates), returning up to `limit` openings.
 * Reuses rangeHasConflict / walkHasConflict — NO new rules.
 */
export function findOpenings(
  capacity: Map<string, DayCapacity>,
  opts: {
    requestType: RequestType;
    from: string;
    to: string;
    nights?: number;
    limit?: number;
    petCount?: number;
  },
): Opening[] {
  const limit = opts.limit ?? 3;
  const isTimed = opts.requestType === 'walk' || opts.requestType === 'check-in';
  const result: Opening[] = [];

  for (
    let start = opts.from;
    start <= opts.to && result.length < limit;
    start = addDays(start, 1)
  ) {
    if (isTimed) {
      if (!walkHasConflict(start, capacity)) result.push({ startDate: start });
    } else {
      const nights = Math.max(1, opts.nights ?? 1);
      const end = addDays(start, nights);
      if (
        !rangeHasConflict(
          start,
          end,
          opts.requestType as 'boarding' | 'house-sit',
          capacity,
          opts.petCount,
        )
      ) {
        result.push({ startDate: start, endDate: end });
      }
    }
  }
  return result;
}
```

---

## 5. Usage

```ts
import { buildCapacity, rangeHasConflict, walkHasConflict, findOpenings } from './capacity';

// 1. Build the map ONCE from your existing bookings (end dates exclusive).
const capacity = buildCapacity([
  { start_date: '2026-06-07', end_date: '2026-06-12', type: 'boarding', petCount: 1 },
  { start_date: '2026-06-10', end_date: '2026-06-11', type: 'blocked' },
]);

// 2. Validate a new multi-night boarding request (endDate exclusive).
const conflict = rangeHasConflict('2026-06-13', '2026-06-15', 'boarding', capacity, /*pets*/ 2);

// 3. Validate a single-day walk.
const walkBlocked = walkHasConflict('2026-06-20', capacity);

// 4. Suggest the next few openings.
const openings = findOpenings(capacity, {
  requestType: 'boarding',
  from: '2026-06-13',
  to: '2026-07-13',
  nights: 2,
  limit: 3,
});
```

**Client + server share this exact code.** In the origin repo the React calendar
UI and the server-side booking validator both import these functions, so the
grid a user sees can never disagree with the answer the server gives — the rules
live in exactly one place. Keep it that way: build thin adapters around these
primitives, never re-derive the rules.

---

## 6. Port checklist

- [ ] Set `BUSINESS_TZ` to your business's timezone.
- [ ] Rename request/booking types to your domain; keep `blocked` (or an
      equivalent hard-stop) if you need admin holds.
- [ ] Decide your capacity ceilings (here: 2 boarding pets/day, 1 house-sit/day)
      and update `dayBlocksRequest` / `isUnavailableDate`.
- [ ] Keep **`endDate` exclusive** end-to-end, or convert at your API boundary.
- [ ] If your unit of capacity is bookings rather than pets, drop `petCount`
      and simplify the boarding branch to `+= 1` / `>= N`.
- [ ] Port the date helpers you actually use; the engine only needs `addDays`.
- [ ] Write tests for the boundary cases: back-to-back bookings sharing a
      checkout/check-in day, a 2-pet request against a 1-slot-remaining day, and
      a house-sit overlapping boarding by exactly 1 vs 2 days.

```

```
