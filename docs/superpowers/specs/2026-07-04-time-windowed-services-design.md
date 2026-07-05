# Time-windowed group services — design

**Date:** 2026-07-04
**Status:** Approved (pending spec review)
**Branch target:** off `main`

## Problem

`walk`/`checkin` options (`TenantServiceOptions`, `sql/schema.sql:44-54`) are
priced by `DurationMinutes` only — there is no way for a sitter to define a
service that only runs during a fixed clock window (e.g. a "Morning Walk"
group from 11:00–14:00, or an "Afternoon Walk" from 15:00–18:00). Booking
creation hardcodes `startTime: null` (`server/routes/bookings.ts:183`), so
every calendar event is all-day even though `google-calendar.ts:151-185`
already builds a proper timed event when `startTime` is populated. Walk/checkin
availability (`walkHasConflict`) is "unlimited unless the day is blocked" —
there is no concept of a per-slot capacity ceiling, so nothing stops unlimited
customers from booking into the same group session, and nothing stops a
customer from booking a window-bound service at an arbitrary time.

## Goals

1. A sitter can define a service option with a fixed clock window
   (`StartTime`–`EndTime`) and an optional capacity ceiling — e.g. "Morning
   Walk, 11:00–14:00, up to 4 dogs."
2. A customer booking a windowed option books into the window itself (no
   separate time picker); the widget shows the window as part of the option
   label and blocks the option once its capacity is reached for that date.
3. The resulting `BookingRequests.StartTime` is populated and flows through to
   a real timed Google Calendar event (not all-day), reusing the
   already-dormant support in `buildEventResource`.
4. Existing duration-only options (no window set) are completely unaffected —
   `StartTime`/`EndTime`/`Capacity` all default to `NULL`, matching the
   `null = unlimited` convention already used throughout this schema
   (`Tenants.MaxBoardingPets`, `TenantServices.MaxNights`, etc.).

## Non-goals

- A same-day booking cutoff (e.g. rejecting a booking into an 11:00–14:00
  window at 1:30pm today) — `validateSingleDate` only checks the date, not
  time-of-day. Speculative until a sitter hits it; not built now.
- Merging multiple customers' bookings into one shared Google Calendar event.
  Each booking keeps its own event, as today; a full group session with 3
  customers just produces 3 overlapping timed events at the same window.
- Surfacing remaining slot capacity ("2 of 4 spots left") to customers — the
  widget only ever shows available/unavailable. Raw counts are sitter-facing
  information only (not built into any UI in this pass).
- A generic "time slot" concept decoupled from pricing options (considered and
  rejected below).

## Alternatives considered

**New standalone `TenantServiceSlots` table**, decoupled from
`TenantServiceOptions`, so a window could in principle apply across multiple
price points. Rejected: nothing today requires a window to vary independently
of its price/duration, and it would add a second admin UI section, a new
repo/API surface, and joins in the booking and availability paths for a
distinction nobody asked for.

**New `ServiceType` enum values per named slot** (`morning_walk`,
`afternoon_walk`, ...). Rejected: `ServiceType` is a closed, shared-catalog
enum baked into schema `CHECK`s, `SERVICE_CATALOG`, and widget rendering.
Sitters need arbitrary custom names per tenant, which a shared, cross-tenant
enum column can't express.

**Chosen: extend `TenantServiceOptions` directly.** A slot is just an option
row with a window and a capacity — reusing the existing options list, the
existing `optionKey` booking flow, the existing `estimateCost` pricing path,
and the existing nullable-is-unlimited convention. Smallest diff, zero
migration risk for existing data (new columns default `NULL`).

## Design

### 1. Schema

New migration `migrations/0006_service_slots.sql` (+ `sql/schema.sql` updated
in lockstep):

```sql
ALTER TABLE TenantServiceOptions ADD COLUMN StartTime TEXT; -- 'HH:MM'; NULL = no fixed window
ALTER TABLE TenantServiceOptions ADD COLUMN EndTime TEXT;   -- 'HH:MM'; NULL = no fixed window
ALTER TABLE TenantServiceOptions ADD COLUMN Capacity INTEGER; -- max concurrent bookings/date; NULL = unlimited
```

`BookingRequests.StartTime` already exists (`sql/schema.sql:98`) and needs no
migration — it just starts getting populated instead of hardcoded `null`.

### 2. Service catalog / types (`server/lib/services.ts`, `server/types.ts`)

`TenantServiceOption` (`server/types.ts`) gains `StartTime: string | null`,
`EndTime: string | null`, `Capacity: number | null`. No changes to
`SERVICE_CATALOG` itself — windowing is an option-level property, not a
service-level one, so `walk`/`checkin` (the only `hasDuration: true` types)
simply gain optional fields on their existing option rows.

### 3. Repo layer (`server/db/repo.ts`)

- `listServiceOptions` SELECT expands to include the three new columns.
- New function, sibling to `listCapacityRows` (`repo.ts:147-166`), which today
  explicitly excludes `walk`/`checkin` (`ServiceType IN ('boarding',
  'housesitting', 'blocked')`):

  ```ts
  countSlotBookings(
    db: D1Database,
    tenantId: string,
    serviceType: ServiceType,
    optionKey: string,
    date: string,
    excludeId?: string,
  ): Promise<number>
  // SELECT COUNT(*) FROM BookingRequests
  // WHERE TenantId=? AND ServiceType=? AND OptionKey=? AND StartDate=?
  //   AND Status IN ('pending','confirmed') AND (excludeId IS NULL OR Id != ?)
  ```

  Same status filter already used by `listCapacityRows` (pending+confirmed
  count toward capacity; cancelled doesn't).
- `insertBookingRequest` (or its caller) sets `StartTime` from the resolved
  option when present.

### 4. Capacity check (`server/lib/availability.ts`)

`checkSingle` (`availability.ts:110-130`) gains one branch after the existing
`walkHasConflict` blocked-day check: if `option.Capacity !== null`, call
`countSlotBookings` and reject with `"That session is full."` when the count
is `>= option.Capacity`. No changes to the shared day-map engine in
`src/shared/booking/capacity.ts` — slot capacity is per-option/per-date, a
different dimension than the cross-service day capacity boarding/house-sit
use, so it's a separate, simpler counter rather than a new `DayCapacity`
field.

`monthAvailability` (`availability.ts:169-267`) gets the same counting for the
grid: a windowed option's day is `unavailable` once `Capacity` is hit,
`partial` if `count > 0` and under capacity — same three-state shape boarding
already returns. Per the non-goals above, `used`/`max` stay `null` in this
response (the widget never displays raw counts); the counting only drives the
`status` field.

### 5. Booking submission (`server/routes/bookings.ts`)

- Where the sync payload is built (`bookings.ts:177-189`), replace the
  hardcoded `startTime: null` with `option.StartTime` when set.
- `checkAvailability` (already called at `bookings.ts:161`) automatically
  picks up the new capacity branch in `checkSingle` — no new call site needed.
- The existing optimistic insert → check → rollback-on-conflict pattern
  (`bookings.ts:146-173`) already generalizes to any `serviceType`, so a
  slot-capacity race (two customers taking the last spot simultaneously) gets
  the same safety boarding capacity races get today. No new concurrency
  handling required.

### 6. Calendar sync (`server/lib/calendar-sync.ts`, `server/lib/google-calendar.ts`)

No changes needed — `buildEventResource` (`google-calendar.ts:151-185`)
already branches into a timed `dateTime` event when `startTime` is present.
This path has simply never been exercised because nothing upstream set
`startTime` until now. Each booking still produces its own event (see
Non-goals) — multiple customers in one Morning Walk slot just show up as
separate overlapping timed events on the sitter's calendar, each carrying its
own customer/pet/answers.

### 7. Admin route (`server/routes/admin.ts`)

- `OptionBody` type gains `startTime?: string | null`, `endTime?: string |
  null`, `capacity?: number | null`.
- Validation, added to the existing per-option loop (`admin.ts:275-284`):
  - `startTime`/`endTime` must both be present or both absent — reject one
    without the other.
  - Both must match `HH:MM`, and `endTime > startTime` (plain string
    comparison — `HH:MM` sorts lexically, no date parsing needed).
  - `capacity`: reuse the existing `isNullableLimit` helper against
    `DEFENSIVE_MAX_PET_COUNT` (already a generic "sane positive int" ceiling
    per its own comment) — same shape as every other nullable numeric limit
    in this route.
- `GET /:slug/admin/settings` options mapping (`admin.ts:191-198`) adds the
  three fields — pure pass-through.
- On save, the option write includes the three fields alongside
  `label`/`durationMinutes`/`rate`.

### 8. Public config (`server/routes/public.ts`)

`GET /:slug/config` options mapping (`public.ts:39-46`) adds `startTime`,
`endTime`, `capacity` to each option entry, so the widget has everything it
needs to render and gate without a second request.

### 9. Admin UI (`app/admin/sections/ServicesSection.tsx`)

Each duration option row (`ServicesSection.tsx:170-222`) gains:

- A label text input, editable for **every** option (not just windowed ones)
  — default value still auto-derives from duration when untouched, but
  sitters can freely rename any option (e.g. "60 min" → "Morning Walk").
- Two native `<input type="time">` fields for `startTime`/`endTime` — no
  picker library, no dependency.
- A nullable capacity number input, reusing the existing `NullableNumberField`
  component already used for min/max nights/pets.

Blank window/capacity fields = today's exact behavior (unrestricted,
unlimited). No UI change at all for sitters who never touch these fields.

### 10. Widget (`app/embed/`)

- `app/shared-ui/api.ts` config type gains `startTime`/`endTime`/`capacity`
  per option.
- Option picker: a windowed option renders its window in the label (e.g.
  "Morning Walk · 11:00 AM–2:00 PM · $25") instead of duration. The customer
  picks the option, not a separate time — the window **is** the appointment.
- Availability month grid consumes the existing `available`/`partial`/
  `unavailable` status per day exactly as it does for boarding today; no new
  widget-side capacity logic.

## Error handling

- Malformed window (`one-sided start/end`, bad `HH:MM` format, `end <= start`)
  or invalid `capacity` → 400 from the admin route, same style as existing
  `SettingsBody` validation.
- Booking into a full slot → 409 `"Sorry — those dates just filled up."`
  path already returns this generic message for any capacity conflict; the
  slot-full case reuses it (matches existing boarding/house-sit conflict
  messaging, no new customer-facing string needed beyond the internal
  `"That session is full."` reason used for logging/availability responses).
- Deleting/renaming an option that has existing pending bookings is
  pre-existing behavior for all options, unaffected by this change.

## Testing

Following this repo's convention — shared/pure logic tests under
`server/__tests__/`:

- `server/__tests__/availability.test.ts` additions: `checkSingle` rejects
  once `countSlotBookings` reaches `Capacity`, accepts up to and not including
  it, and cancelled bookings don't count toward the total.
- `server/__tests__/admin.test.ts` additions: PUT rejects one-sided
  start/end, end-before-start, non-positive capacity; valid windows round-trip
  through GET.
- `server/__tests__/booking-flow.test.ts` additions: two bookings into a
  capacity-2 slot succeed; a third gets 409; the synced calendar event payload
  for a windowed booking carries the option's `StartTime` (timed event, not
  all-day).

## Files touched

- `migrations/0006_service_slots.sql` (new) + `sql/schema.sql`.
- `server/types.ts` — `TenantServiceOption` gains three fields.
- `server/db/repo.ts` — `listServiceOptions` column expansion; new
  `countSlotBookings`; `insertBookingRequest`/caller sets `StartTime`.
- `server/lib/availability.ts` — `checkSingle` capacity branch;
  `monthAvailability` slot-aware status for windowed options.
- `server/routes/bookings.ts` — `startTime: option.StartTime` in the sync
  payload (`bookings.ts:183`).
- `server/routes/admin.ts` — `OptionBody` type, validation, `GET`/`PUT`
  `/:slug/admin/settings` options mapping.
- `server/routes/public.ts` — `GET /:slug/config` options mapping.
- `app/admin/sections/ServicesSection.tsx` — label input for all options,
  time window + capacity fields per option.
- `app/shared-ui/api.ts` — config type additions.
- `app/embed/App.tsx` — windowed option label rendering.
- Tests: additions to `availability.test.ts`, `admin.test.ts`,
  `booking-flow.test.ts` (no new test files).

## Open questions

None outstanding. Decisions locked: windows live on `TenantServiceOptions`
(not a separate table or enum); no same-day time cutoff; no merged
group calendar events; customers never see raw capacity counts.
