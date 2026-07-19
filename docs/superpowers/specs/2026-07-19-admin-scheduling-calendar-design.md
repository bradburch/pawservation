# Admin scheduling calendar + Google Calendar status-change sync — design

**Date:** 2026-07-19
**Status:** Approved (user directed; no new endpoints, client-side reshaping)
**Branch:** `custom-services`

## Problem

Sitters run their whole schedule from this dashboard, but nothing in it looks
like a schedule: bookings are two flat lists (pending / everything else) in
the Bookings section, and time off is a third list in its own section. There
is no single view that answers "what does my July look like?".

Google Calendar integration is half of the answer already — connect via
OAuth, an event is created per booking request, and deletion reconciliation
marks bookings cancelled when their event disappears — but the loop has a
known hole, flagged in code at `server/routes/admin.ts` (`ponytail:` comment
on the status route): cancelling or declining a booking in the dashboard
leaves its Google event standing. The 2026-06-28 calendar spec deliberately
deferred "event deletes on status change"; this design closes that gap and
adds the in-dashboard calendar.

## Design

### New "Calendar" section — the landing view

A new sidebar entry (`calendar`, label "Calendar", `IconCalendar`) becomes the
**first** entry in `SECTIONS`, ahead of Bookings — the sidebar order becomes
Calendar, Bookings, Earnings, Business, Pet types, Services & rates, Time
off, Clients, Connected apps, Your website. Calendar is also the **default**
section. Today, in `app/admin/App.tsx`, `sectionFromHash()` falls back to
`'bookings'` whenever the URL has no `#hash` matching a `SECTIONS` key, with
a comment reasoning that a sitter's morning question is "what needs my
reply?", not their own settings — that fallback becomes `'calendar'`, and the
comment's reasoning moves with it: the Calendar section (grid + pending list,
below) now answers that same question, plus "what does my month look like?",
in one view. This is the only change to section-selection logic — explicit
hash deep links (`#clients`, `#bookings`, etc.) still resolve normally, and
the `hashchange` listener that keeps `activeSection` in sync with
back/forward is untouched; only the _no-hash_ fallback moves. The
zero-enabled-services auto-open wizard (`SetupWizard`, gated on `wizardOpen`
in `Dashboard`) is unaffected by any of this: it is already rendered
independently of `activeSection`, as an overlay on top of whichever section
is mounted, so it now overlays the Calendar landing view exactly as it
previously overlaid Bookings — no code path there changes. The panel is a new
`app/admin/sections/CalendarSection.tsx` — its **own** `pb-`-classed
month-grid component built on the shared pure helpers `monthGrid` /
`shiftMonth` (`src/shared/booking/calendar-ui.ts`). The embed `Calendar.tsx`
is visual precedent only: it is coupled to customer availability fetching and
range selection, so it is not reused.

### Data: existing endpoints, reshaped on the client

No new endpoint. Verified against `app/shared-ui/api.ts`: the
`adminApi.bookings.list` payload (`AdminBooking`) already carries everything
a month cell needs — `id`, `customerName`/`customerEmail`, `type`,
`startDate`, `endDate`, `startTime`, `status`. Service _labels_ come from
`settings.services` (the list payload's `type` is the slug); time off comes
from `settings.blocked`. The list endpoint also already runs Google-deletion
reconciliation server-side (`reconcileIfStale`, TTL-limited), so the calendar
inherits freshness for free. Booking volumes for a solo sitter are small, so
the unfiltered list is fine; if that ever changes, add date-window query
params to the existing endpoint — not a new one. Because Calendar is now the
default landing section, this reconciliation runs on the very first bookings
fetch after login/session-restore rather than only once a sitter navigates to
Bookings — the trigger itself is unchanged (it's still the one shared
bookings fetch), it just fires from whichever of the two sections happens to
mount first, which in the common case is now sooner.

**Bookings state lifts to `Dashboard`** (in `app/admin/App.tsx`) via the
existing `useAsync` pattern used for customers: one load function around
`adminApi.bookings.list`, with `bookings` + `reload` passed to both
`BookingsSection` (which drops its private fetch effect but keeps all its
status/payments logic) and `CalendarSection`. One fetch, and a status change
made from either section refreshes both.

A small reshaping helper in the admin app (not `src/shared` — the server
never needs it) builds `Map<date, entries>` for the viewed month:

- Bookings with `endDate` paint every day in `[startDate, endDate)` —
  `endDate` is exclusive in the DB and in Google's all-day semantics, so the
  grid shows exactly the days Google shows. `endDate: null` paints
  `startDate` only. Spans crossing month edges are clipped to the viewed
  month.
- Blocked ranges paint `[startDate, endDate)` the same way (Time off already
  converts inclusive input to exclusive ends at the form boundary).
- `cancelled` and `declined` bookings are excluded entirely.

### Month grid rendering

- **Header:** month + year title with prev / **Today** / next controls
  (`shiftMonth(month, ±1)`; Today resets to the current month). Default view:
  current month.
- **Cells:** day number; time-off renders as a muted full-width band at the
  top of the cell; confirmed bookings as solid accent chips ("Sam · Boarding"
  — customer first name, falling back to email then "Guest", plus service
  label); pending as hollow/dashed chips. Bookings sort untimed-first, then
  by `startTime`.
- **Overflow:** at most 3 entries per cell; beyond that the cell shows
  "+N more", which navigates to the Bookings section.
- **Weekends** get a distinct cell background; **today** gets a highlighted
  ring. "Today" is computed with the shared `getPacificDateStr(new Date(),
settings.timezone ?? DEFAULT_TIMEZONE)` so it matches the tenant's zone,
  not the browser's.
- **Mobile:** the grid stays 7 columns with `minmax(0, 1fr)` tracks — no
  horizontal scroll ever. Below a narrow breakpoint, chips shrink to
  single-line truncated text at a smaller size and cells get a fixed
  min-height so the month stays scannable on a phone.

### "Needs your reply" — the pending list, shared not duplicated

Directly beneath the grid, the Calendar section renders the same
pending-requests block Bookings shows under its own "Needs your reply"
heading: full rows (customer, dates, pet count, cost, status chip) with the
same Confirm/Decline buttons and PaymentsPanel toggle — not a re-derived
summary, not another chip style. Today that block is inlined in
`BookingsSection.tsx` (the `row` / `actionsFor` / `chipClass` / `paidText`
helpers, the `pending` filter/sort, and the "Needs your reply (N)" / "No
requests waiting for a reply" heading); it is extracted into an exported
`PendingRequestsList` component in that same file, taking the shared
`bookings` array (filtering and sorting to pending itself, exactly as today)
plus `session`, `handleError`, and `clearError`. `BookingsSection` renders it
for its own pending block in place of its former inline copy (no behavior
change — same markup, same handlers, just factored out), and
`CalendarSection` renders the identical component beneath its grid. Both
mounted copies (every section stays mounted) run as independent component
instances — each with its own `busyId` / `openId` / local `message` state —
but both read the one shared `bookings` array and call the one shared
`reload`, so confirming or declining from either place updates both.

This reuses the _component_, not the deep-link below. The grid's chip
click-through exists because a chip is a compact stand-in for a row that
lives elsewhere, so clicking it has to navigate to where that row is; the
pending list has no such gap to close — it already **is** the full,
actionable row, in both places it appears — so nothing about it deep-links
or changes section. These are two deliberately different reuse mechanisms
for two different kinds of duplication, and both stand as described.

### Entry click → the existing Bookings row (deep link)

Clicking a booking chip deep-links to its row in the Bookings section rather
than opening an inline popover: **deep-linking reuses the entire existing row
— status buttons, confirm dialog, PaymentsPanel, and the "was the client
told?" save bar — with zero duplication, where a popover would re-implement
all of it.** Mechanics: `Dashboard` holds `focusBookingId`; the chip's click
handler sets it and sets `window.location.hash = 'bookings'` (the existing
hash navigation, so back/forward keep working — and every section stays
mounted, so the list is already loaded). `BookingsSection` takes an optional
`focusId` + `onFocusConsumed`: on receipt it scrolls the row into view and
applies a brief highlight class, then clears. Time-off bands are not
clickable (managed in Time off, unchanged).

### Non-technical-friendly touches

- Legend under the grid explaining the three chip styles in plain words
  (Confirmed / Waiting for your reply / Time off).
- Empty state when the viewed month has no entries: "Nothing booked this
  month yet."
- A one-line Google Calendar status under the grid, read from
  `settings.calendar.status`: connected → "Synced with your Google
  Calendar"; otherwise a plain-language nudge linking to `#apps` ("Connect
  Google Calendar in Connected apps to see these on your phone's
  calendar.").

### Google Calendar status-change sync

Closes the gap the 2026-06-28 spec deferred, in
`POST /:slug/admin/bookings/:id/status` (`server/routes/admin.ts`):

- **Cancel / decline:** after `updateBookingStatus` reports a real change,
  fetch the booking row once, unconditionally, via `getBookingWithCustomer`
  (it already returns `GCalEventId`; today the route fetches it only when
  email is configured — restructure so the one fetch serves both the
  notification email and this hook). If `GCalEventId` is set, schedule a new
  `deleteBookingCalendarEvent(env, tenant, gcalEventId)` helper in
  `server/lib/calendar-sync.ts` via `c.executionCtx.waitUntil(...)`, mirroring
  the create path's never-blocks posture: load the `calendar` connection,
  skip unless `connected`, reuse `getCalendarAccessToken` (existing
  refresh-and-persist plumbing), call the existing `deleteEvent` (which
  already treats 410 Gone as success), and swallow every failure — the
  status change already stands.
- **Confirm:** no event change — events are created at request time, so a
  confirmed booking's event already exists. The SQL guards in
  `updateBookingStatus` (decline only from pending; cancelled is terminal)
  mean a no-op transition returns 404 before any sync runs.
- `GCalEventId` stays on the row after deletion — `listSyncedBookingIds`
  already excludes cancelled bookings, so reconciliation ignores it, and it
  remains a useful historical record. No schema change anywhere in this
  design.
- Remove the `ponytail:` debt comment on the status route — this is that
  debt paid.

## Not built (deliberate)

- Event update on booking edit — bookings aren't editable.
- Two-way availability import from Google (still out of scope, as in the
  2026-06-28 spec).
- Week/day views, drag-to-reschedule, calendar-side booking creation — the
  grid is a viewport onto existing data, not a new editing surface.
- Date-window filtering on the bookings list endpoint (revisit only if
  payloads outgrow a solo sitter's volume).

## Testing

Server-side Vitest for the status-change sync hooks, through the real schema
(`createTestEnv`) with mocked Google `fetch`, same pattern as the existing
booking-flow calendar tests: cancel and decline with a connected calendar +
`GCalEventId` call `deleteEvent` with the right event id; no connection or no
`GCalEventId` makes no Google call; a Google failure (or 410) is swallowed
and the status response is unchanged; confirm makes no Google call.

The calendar grid is client-only over already-tested endpoints and pure
helpers — manual Playwright verification via the `running-pawbook` flow:
login lands on Calendar with the grid and, beneath it, the populated "Needs
your reply" pending list; month prev/today/next; chip styles per status;
multi-day spans and month-edge clipping; "+N more"; entry click landing on
the highlighted Bookings row; confirming or declining from the Calendar's
pending list is reflected in the Bookings section's copy too; legend/empty
state; Google status line in both connection states; and a phone-width
viewport with no horizontal scroll.
