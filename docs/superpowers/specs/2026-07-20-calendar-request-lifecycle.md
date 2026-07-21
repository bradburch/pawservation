# Google Calendar request lifecycle

Status: implemented — 2026-07-20

## Problem

Bookings sync to Google Calendar only at request-creation time (`syncBookingToCalendar`, called
from `routes/bookings.ts`), with a delete-on-decline/cancel hook in `routes/admin.ts`. Persona
testing (`server/__tests__/persona-*.test.ts`) surfaced three gaps:

1. **Pending and confirmed events are indistinguishable.** A request and a confirmed booking look
   identical on the calendar; confirming in the dashboard changes nothing on Google.
2. **No backfill / catch-up.** A booking taken _before_ the sitter connects Calendar is never
   synced. Connecting later does nothing; confirming such a booking did nothing either.
3. **A request-time Google outage loses the event silently.** The best-effort create is swallowed,
   the booking has no `GCalEventId`, and nothing ever recreates the event.

Events also showed a pet **count** and the customer **email** in the title, with almost no metadata
in the description.

## Design

### A. Event content (`server/lib/google-calendar.ts`)

`buildEventResource` gains `petNames: string[]` and `status: 'pending' | 'confirmed'`.

- **summary**: `${status === 'pending' ? '[REQUEST] ' : ''}${label} — ${petsText}`, where
  `petsText` is `petNames.join(', ')` when non-empty, else `${petCount} pet(s)`.
- **description** (one per line, empty values omitted): `Service:`, `Pets:`, `Customer:`,
  `Estimated cost: $n`, and — pending only — `Requested via Pawservation — confirm or decline in
your dashboard.`
- **extendedProperties.private**: all existing keys kept (`bookingId` drives reconcile) plus
  `status`.
- New `updateEvent(accessToken, calendarId, eventId, resource)` — PATCH to the event, error
  handling mirroring `createEvent`.

### B. Sync layer (`server/lib/calendar-sync.ts`)

- `SyncInput` gains `petNames` + `status`; a shared `resourceForBooking` builds the resource for
  every path.
- `updateBookingCalendarEvent(env, tenant, gcalEventId, b)` — same connection gating, PATCHes.
- `backfillCalendarEvents(env, tenant)` — for every future (`StartDate >= today` in tenant tz),
  non-cancelled, non-`blocked` booking with `GCalEventId IS NULL`, create its event with the right
  status prefix and real pet names. Sequential, per-booking best-effort, capped at 200.

### C. Data access (`server/db/repo.ts`, tenant-scoped)

- `listPetNamesForBooking(tenantId, bookingId)` — join `BookingRequestPets → EndUserPets`.
- `getBookingSyncData(tenantId, bookingId)` and `listUnsyncedFutureBookings(tenantId, today,
limit)` — booking rows joined with service label + option duration (the `SyncInput` fields).

### D. Call sites

- `routes/bookings.ts`: pass `petNames` (from the already-loaded pets) + `status: 'pending'`.
- `routes/admin.ts` status route, on **confirm**: if the booking has a `GCalEventId`, `waitUntil`
  `updateBookingCalendarEvent` (retitle to confirmed); if it has none, `waitUntil`
  `syncBookingToCalendar` as a catch-up create (`status: 'confirmed'`). Decline/cancel keep the
  existing delete. Best-effort never affects the response (waitUntil in prod, awaited in tests).
- `routes/oauth.ts`: after tokens are stored, `waitUntil backfillCalendarEvents`.

## Test plan

- Unit: `buildEventResource` summary/description/extendedProperties for pending vs confirmed and the
  name-vs-count fallback; `updateEvent` PATCH shape + error; `updateBookingCalendarEvent` and
  `backfillCalendarEvents` (two future unsynced pending+confirmed → two creates with correct
  prefixes; cancelled/past/synced untouched; one failure doesn't stop the rest).
- Persona (real routes): Marisol — request creates a `[REQUEST]` event; confirm PATCHes off the
  prefix; an outage'd request is caught up on confirm; a PATCH failure never breaks confirm. Dana —
  confirming a booking made before she connected creates the event via catch-up. Isolation persona
  stays green (token/calendar-id selection unchanged).
