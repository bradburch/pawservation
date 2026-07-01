# Customer pets, login gate & "bradpaws" widget redesign — design

**Date:** 2026-06-30
**Status:** Approved (design)

## Problem

Three linked changes to the embed booking experience:

1. **"Pet" means the customer's own animals** (sitter-managed), not a species picker.
2. **Login is required** before the widget shows anything.
3. **The widget is redesigned to the "bradpaws" look** the user provided: a personalized greeting,
   service-type **cards** chosen first, and a rich **availability calendar** (not native date
   inputs), on a single page with a soft rounded/sage/navy aesthetic.

Scope of the restyle: **embed widget only.** The admin dashboard and landing page keep the existing
"Keeper's Ledger" identity.

## Decisions (locked with the user)

- Pets are **sitter-managed** (added per customer in the admin dashboard).
- Booking uses **multi-select pets**; `PetCount` = number selected; the manual count field is gone.
- **Whole-widget login gate**: logged-out visitors see only the sign-in step.
- **Bradpaws layout** (single page): greeting → 2-col **service cards** (emoji + label; selected card
  gets the tenant accent border) → **month calendar** for the selected service → a details panel
  (pets + options + cost + Confirm) that appears once date(s) are chosen.
- **Rich calendar states**, reflecting the currently-selected service:
  - **Available** — open.
  - **Partial** (e.g. "Boarding (1/2)") — some capacity used for the selected service that day.
  - **My sits** — the signed-in customer has a booking that day.
  - **Unavailable** — sitter-blocked or fully booked.
  - **Selected** — the date(s) currently chosen.
- **Restyle scope: embed widget only.**

## Data model (schema.sql + `migrations/0004_*` in lockstep)

```sql
CREATE TABLE IF NOT EXISTS EndUserPets (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Name TEXT NOT NULL,
  PetType TEXT NOT NULL CHECK (PetType IN ('dog', 'cat')),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_EndUserPets_Tenant_User ON EndUserPets (TenantId, EndUserId);

CREATE TABLE IF NOT EXISTS BookingRequestPets (
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  PetId TEXT NOT NULL REFERENCES EndUserPets(Id),
  PRIMARY KEY (BookingRequestId, PetId)
);
```

`BookingRequests.PetCount` stays (= pet count, so shared capacity is untouched); `PetType` = first
selected pet's species (validation/calendar back-compat). **FK caveat:** tests enforce FKs, prod D1
doesn't — insert children after parents.

## Server

**Repo (`server/db/repo.ts`, only DB module, `tenantId`-first):**

- `listEndUserPets`, `addEndUserPet`, `removeEndUserPet`.
- `getEndUserById` already exists → used for the greeting name.
- `addBookingPets(db, bookingId, petIds)`, `listBookingPetsForUser(db, tenantId, endUserId)`.
- A month-window capacity read: reuse `listCapacityRows`-style query to fetch all boarding/house-sit
  /blocked events overlapping `[monthStart, monthEnd)`, plus the caller's own bookings for "mine".

**Routes:**

- **Admin** (`routes/admin.ts`): customers list now includes `pets`; `POST`/`DELETE`
  `/api/:slug/admin/customers/:id/pets` (species must be an enabled tenant type).
- **Widget** (`routes/bookings.ts`, `endUserAuth`):
  - `GET /api/:slug/me` → `{ name, pets }` (name for the greeting; pets for the picker).
  - `GET /api/:slug/availability/month?type=<serviceType>&month=YYYY-MM` → per-date state for the
    selected service. For each in-month date returns
    `{ date, status: 'available'|'partial'|'unavailable', used, max, mine }`:
    - Build the tenant's `DayCapacity` map (shared `buildCapacity`) over the month window.
    - **boarding**: `used = day.boarding`, `max = maxBoardingPets`; `unavailable` if blocked or
      `used >= max`, `partial` if `0 < used < max`, else `available`.
    - **housesitting**: same against `maxHouseSitsPerDay`.
    - **walk/daycare/checkin**: `available` unless blocked (`unavailable`); `used/max = null`.
    - `mine` = the caller has a booking overlapping that date. Response also carries `today` so the
      client greys past dates.
  - Booking create accepts `petIds: string[]` (not `petType`/`petCount`); validates ownership +
    accepted species; sets `PetCount = petIds.length`, `PetType = pets[0]`, writes join rows.
  - `GET /api/:slug/bookings/mine` items gain `pets: string[]` (names).

## Widget UI (`app/embed/`) — the bradpaws redesign

**Auth gate:** `App` reads the end-user token; no token → render only the sign-in step (`Identify`).
After login, render the redesigned booking view; "My bookings" reachable via a quiet link/tab.

**Booking view (single page, revealed top-to-bottom):**

1. **Greeting** — "How can I help, {firstName}?" in a rounded display font (`ui-rounded` stack;
   embed CSP blocks external fonts).
2. **Service cards** — 2-col grid of the sitter's enabled services, each an emoji + label
   (boarding 🛏️, housesitting 🏠, daycare ☀️, walk 🐕‍🦺, checkin 🐱). Selecting one sets the tenant
   accent border. First enabled service selected by default.
3. **Calendar** — "Booking Availability" with an ⓘ tooltip and helper text. Month grid: `‹ Month YYYY ›`
   nav, SUN–SAT headers, each date a status dot per the legend (available / partial N/M / my sits /
   unavailable / selected). Refetches `/availability/month` when service or month changes.
   - **Single-day services** (walk/daycare/checkin): tap one available/partial date → Selected.
   - **Range services** (boarding/housesitting): tap check-in then checkout (exclusive) → range
     highlighted; the range must contain no unavailable date.
   - Past + unavailable dates are not tappable.
4. **Details panel** (appears once date(s) chosen):
   - **Pets** — checkboxes of the customer's pets (multi-select). Empty → "No pets on file yet —
     ask your sitter to add them."
   - **Duration** — for walk/checkin with multiple options, a select.
   - **Estimated cost** (from `/availability`) + **Confirm & request**.
5. On confirm → `createBooking({ type, optionKey, startDate, endDate?, petIds })`; success message;
   calendar refetches so the new booking shows as **My sits**.

**Visual system (embed only):** rounded display font for headings; navy ink (`--bp-ink`), soft
**sage** neutral for the calendar chip/headers, white surface; the **tenant accent** (`--bp-accent`)
drives selected-card border, Selected date, and the Confirm button. New CSS lives in `widget.css`;
the calendar is its own component/file.

## Known ripple effects (accepted)

- The admin **embed preview** and **`/demo`** page now show the widget's sign-in screen (sitter/
  visitor isn't a logged-in customer).
- `sql/seed.sql` gains demo `EndUserPets` so the flow has pets after signing in.
- The widget's old species dropdown + "Pets" number field + native date inputs are removed.

## Testing

- Repo: pets CRUD + scoping; booking writes `BookingRequestPets` + correct `PetCount`/`PetType`;
  `listBookingPetsForUser`.
- Routes: admin add/remove pet (species gate); `me` returns name + only caller's pets; booking by
  `petIds` (ownership, cross-tenant, disabled species, capacity); **month availability** — a blocked
  day is `unavailable`, a 1-of-2 boarding day is `partial` with `used/max`, an unlimited service day
  is `available`, the caller's own booking day is `mine`.
- Calendar state derivation is covered by the endpoint tests (server owns the truth); the widget
  renders what the endpoint returns.
- All under the in-memory-SQLite harness (`createTestEnv`), FK-safe.

## Verification gate (CLAUDE.md)

`npm run typecheck && npm run lint && npm run format && npm test && npm run build` — all five.

---

## REVISION (2026-07-01): availability is calendar-sourced

This supersedes the DB-derived month-availability described earlier. The widget calendar reads
**only the sitter's Google Calendar** — never the DB — to determine availability. This removes the
DB-vs-calendar double-counting problem entirely.

**Pet-sitting calendar ID (new admin option):** the sitter can set which Google Calendar to use
(blank = `primary`). Today the id is hardcoded to `primary` at connect time (`routes/oauth.ts`);
make it settable and store it on `ProviderConnections.CalendarId`. Both booking-sync and
availability reads use it.

**Event metadata (new):** when Pawbook creates a booking event (`buildEventResource` /
`createEvent`), attach `extendedProperties.private`: `pawbook: "true"`, `category` (the service
type), `petCount`, `customerEmail`, `bookingId`. So the availability process can categorize our own
events precisely.

**Categorize every event on the calendar for the month:**

- Our `pawbook` metadata present → a **booking** of `category`, covering its date span, for `customerEmail`.
- Else summary (trimmed, case-insensitive) is **"Unavailable"** → a **block**.
- Else → **ignored** (not a block, not a booking).

**Per-day status for the selected service (purely from those events):**

- **Unavailable** = a block event covers that day, OR capacity full.
- **Partial** = `0 < used < max`, where `used` = Σ `petCount` of that day's booking events whose
  category is the capacity dimension of the selected service (boarding events for `boarding`;
  house-sit events for `housesitting`), and `max` = tenant `MaxBoardingPets` / `MaxHouseSitsPerDay`.
- **My sits** = a booking event covering that day whose `customerEmail` = the signed-in customer.
- **Available** otherwise. Walk/daycare/checkin have no capacity cap → available unless a block covers the day.
- **Not connected / no calendar** → all dates available (no events to read).

**Reading the calendar:** add `listCalendarEvents(accessToken, calendarId, timeMinISO, timeMaxISO)`
to `google-calendar.ts` (events.list, `singleEvents=true`). Reuse the existing token
decrypt+refresh path from `calendar-sync.ts` to obtain a valid access token.

**Out of scope for this iteration:** the booking-time server capacity check (`checkAvailability`)
stays DB-based; only the widget's availability DISPLAY is calendar-sourced. (Aligning the write path
to the calendar is a later change.)
