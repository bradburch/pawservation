# Sitter booking dashboard: confirm/reject + calendar reconciliation — design

**Date:** 2026-07-10
**Status:** Approved (pending spec review)
**Branch target:** off `custom-services`

## Problem

There is no admin UI for a sitter to see incoming booking requests or act on
them. `insertBookingRequest` (`server/db/repo.ts:241`) creates every booking
as `Status='pending'` or `'confirmed'` and that's the end of the road — no
route lists bookings for a tenant, no route changes a booking's status, and
`app/admin/App.tsx`'s `SECTIONS` array has no bookings entry. Every booking is
also pushed to Google Calendar on creation (`syncBookingToCalendar`,
`server/routes/bookings.ts:185`), but nothing ever reads back — if a sitter or
customer edits/deletes the event directly in Google Calendar, Pawbook's DB
never finds out, so the dashboard would show stale state.

This exact feature (confirm/decline list + status route) already exists on
`main` — merged via #15 and #17, function-for-function what this spec ports —
but `main` and `custom-services` have diverged: `custom-services` replaced the
static `SERVICE_CATALOG` with per-tenant `TenantServices` rows. Investigation
below found the divergence doesn't actually touch the booking code path
(neither the route nor the UI component reference `SERVICE_CATALOG`), so this
is a near-verbatim port, not a rewrite.

## Goals

1. A sitter can see all booking requests for their tenant, grouped into
   "needs your reply" (pending) and everything else, and confirm or decline a
   pending request, or cancel a confirmed one.
2. Every dashboard load reconciles against Google Calendar: if a synced
   booking's calendar event was deleted directly in Calendar, the booking is
   automatically marked cancelled before the list is returned.
3. Reconciliation is cheap — a short-TTL KV cache means back-to-back page
   loads don't each trigger a Calendar API call.
4. The customer is notified by email on any status change, best-effort,
   matching the existing "never let email failure affect the booking"
   philosophy already used elsewhere in this codebase.

## Non-goals

- Deleting or updating the Google Calendar event when a sitter cancels or
  declines from the dashboard. `main` shipped with this same gap (see its
  `// ponytail:` comment on the status route) — carried forward unchanged
  here; revisit if sitters complain about stale calendar entries.
- Reconciling in the other direction in more detail than "event exists /
  doesn't exist" — e.g. detecting a _time change_ on the calendar event and
  reflecting it back onto `BookingRequests.StartDate`/`StartTime`. Out of
  scope; a missing event is the only signal this pass acts on.
- A manual "sync now" button. The cache TTL (Goal 3) is short enough that a
  sitter reloading the page is sufficient; add a button later only if the TTL
  proves too coarse in practice.
- Blocked-day rows (`ServiceType='blocked'`) — excluded from every query and
  route in this feature, same as `main`.

## Alternatives considered

**Cloudflare Cron Trigger for reconciliation**, decoupled from dashboard
loads, reconciling all tenants on a fixed schedule. Rejected for now: adds a
new infrastructure primitive (`wrangler.jsonc` cron config, a new entry
point) for a prototype with a handful of tenants, and still leaves a lag
window up to the schedule interval. The on-demand + KV-cache approach
(Goal 3) gets "reasonably fresh, never hammers the API" without new
infrastructure, reusing a pattern (`tenant-resolve.ts`) already proven in
this codebase. Revisit if tenant count grows enough that per-load
reconciliation cost matters.

**Flag-only reconciliation** (show a mismatch warning, never auto-write) was
considered and rejected per your answer during brainstorming — auto-cancelling
keeps the list trustworthy without an extra manual step, and cancelling is
already the correct terminal state for "the calendar event is gone."

## Design

### 1. Schema

New migration `migrations/0007_booking_lifecycle.sql` (+ `sql/schema.sql`
updated in lockstep), verbatim from `main`:

```sql
ALTER TABLE BookingRequests ADD COLUMN Declined INTEGER NOT NULL DEFAULT 0;
```

`Status` stays `CHECK (Status IN ('pending', 'confirmed', 'cancelled'))` —
unchanged. A sitter's decline is stored as `Status='cancelled'` +
`Declined=1` rather than widening the `CHECK`, because SQLite `CHECK`
constraints can't be altered without a full table rebuild
(`ALTER TABLE ... ADD COLUMN` is cheap; changing a `CHECK` is not). This is
`main`'s already-reviewed approach — reused rather than re-litigated.

`BOOKING_COLS` (`server/db/repo.ts:28`) gains `Declined`. A new
`BOOKING_COLS_QUALIFIED` constant (`` `BookingRequests.${c}` `` for each
column in `BOOKING_COLS`) is needed for the two new JOIN queries below —
today's plain `BOOKING_COLS` string is unqualified, and both `BookingRequests`
and `EndUsers` have an `Id` column, which is ambiguous once joined.

### 2. Repo layer (`server/db/repo.ts`)

Three functions, ported from `main` with `BOOKING_COLS_QUALIFIED` swapped in
for `main`'s equivalent constant name:

- `listBookingsForTenant(db, tenantId)` — all non-blocked bookings for a
  tenant, `LEFT JOIN EndUsers` for `Email`/`Name`, ordered newest-first.
- `updateBookingStatus(db, tenantId, id, status)` — the sitter-driven
  transition. Guard is entirely in the SQL `WHERE` clause (atomic with the
  write): `'declined'` only matches `Status='pending'` rows and sets
  `Status='cancelled', Declined=1`; `'confirmed'`/`'cancelled'` match any
  non-cancelled, non-blocked row. Returns whether a row actually changed.
- `getBookingWithCustomer(db, tenantId, id)` — one booking joined with
  customer contact info, for the notification email.

### 3. Admin routes (`server/routes/admin.ts`)

Ported verbatim from `main`, added alongside the existing customer/pet
routes (same file, same `adminAuth`/`tenantMiddleware` stack every other
admin route already uses):

- `GET /:slug/admin/bookings` — calls the KV-cached reconciliation (Section 5)
  first, then `listBookingsForTenant`, mapping `Declined ? 'declined' :
Status` into the response `status` field (main's derived-status pattern).
- `POST /:slug/admin/bookings/:id/status` — validates `status` is one of
  `confirmed`/`declined`/`cancelled`, calls `updateBookingStatus`, 404s if no
  row changed. On success, best-effort emails the customer via
  `sendBookingStatusEmail` (Section 4) if `isEmailConfigured(c.env)` and the
  booking has a customer email; returns `{ status, notified }` so the
  dashboard can honestly tell the sitter whether the client was told.

### 4. Email (`server/lib/email.ts`)

New `sendBookingStatusEmail(env, to, displayName, statusWord, whenText)`,
ported verbatim from `main` — same `resendPost` call shape as the existing
`sendLoginCode`/`sendInvite`, throws if email isn't configured (caller
catches and reports `notified: false`, same pattern already used for every
other best-effort email in this codebase).

### 5. Calendar reconciliation (`server/lib/calendar-sync.ts`)

New function:

```ts
export async function reconcileBookingsWithCalendar(env: Env, tenant: Tenant): Promise<void>;
```

- No-ops immediately if there's no connected calendar provider
  (`getProviderConnection(..., 'calendar')` missing or `Status !==
'connected'`) — matches the existing guard at the top of
  `syncBookingToCalendar`.
- Lists events via the already-existing `listCalendarEvents` (already reads
  back `extendedProperties.private.bookingId`, since `buildEventResource`
  writes it on every synced event) over a fixed window: today − 1 day
  through +180 days. A fixed window is simplest and matches this prototype's
  scale; if bookings routinely land further out, switch to querying
  `MIN`/`MAX(StartDate)` from open bookings instead.
- Builds a `Set` of the `bookingId`s present in that event list.
- Queries `BookingRequests` for this tenant where `GCalEventId IS NOT NULL`
  and `Status != 'cancelled'`; for any row whose `Id` is missing from the
  Calendar set, calls `updateBookingStatus(..., 'cancelled')` (plain cancel,
  not decline — the sitter didn't decline it, the calendar event just isn't
  there anymore).
- Wrapped in `try/catch` at the call site (Section 6) — a Calendar API
  failure (revoked token, rate limit, network) must never block the
  dashboard from returning current DB state, matching the "Google failure
  must never affect a booking" comment already on `syncBookingToCalendar`.

### 6. KV cache (new function in `calendar-sync.ts`, alongside reconciliation)

Mirrors `tenant-resolve.ts`'s read-through pattern exactly:

```ts
const CALENDAR_SYNC_TTL_SECONDS = 120;
const calendarSyncKey = (tenantId: string) => `calendar-sync:${tenantId}:last`;

export async function reconcileIfStale(env: Env, tenant: Tenant): Promise<void> {
  const key = calendarSyncKey(tenant.Id);
  if (await env.PAWBOOK_CACHE.get(key)) return; // reconciled recently, skip
  try {
    await reconcileBookingsWithCalendar(env, tenant);
  } catch {
    /* best-effort; next load tries again once the (unwritten) cache key expires */
  }
  await env.PAWBOOK_CACHE.put(key, '1', { expirationTtl: CALENDAR_SYNC_TTL_SECONDS });
}
```

The cache key is written _after_ the attempt (success or failure) so a
transient failure doesn't cause every subsequent load in the TTL window to
retry — it backs off for the full TTL either way, same as any other
best-effort background reconciliation. `GET /:slug/admin/bookings`
(Section 3) calls `reconcileIfStale` before `listBookingsForTenant`.

### 7. Frontend

- `app/admin/sections/BookingsSection.tsx` — new file, ported verbatim from
  `main`'s (confirmed via direct diff that it has no `SERVICE_CATALOG`
  dependency: `b.type` renders the raw `ServiceType` slug, no label lookup).
  Pending rows get Confirm/Decline buttons; confirmed rows get Cancel
  (with a native `confirm()` guard, matching `main`); a save-bar-style
  message reports whether the customer was emailed.
- `app/shared-ui/api.ts` — add `AdminBooking` type and an `adminApi.bookings`
  namespace (`list`, `setStatus`), ported verbatim from `main`.
- `app/admin/App.tsx` — add `'bookings'` to the `SectionKey` union and
  `SECTIONS` array (`app/admin/App.tsx:119-121`), rendered the same
  registry-driven way every other section already is.

## Error handling

- Calendar reconciliation failures are swallowed (Section 5/6) — dashboard
  always falls back to current DB state.
- Invalid status-transition attempts (e.g. declining an already-confirmed
  booking) are simply no-ops at the DB layer (`updateBookingStatus` returns
  `false`) and surface as a 404 from the route, matching the existing
  "row didn't change → not found" idiom used elsewhere in this file (e.g.
  `removeEndUserPet`).
- Email failures never block the status change — `notified: false` is
  reported, matching `main`'s exact behavior.

## Testing

- `server/__tests__/admin-bookings.test.ts` (new, mirrors the existing
  per-concern test file convention): `updateBookingStatus` transition guards
  (pending→confirmed/declined, confirmed→cancelled, cancelled is terminal,
  blocked rows never match), `GET`/`POST` route behavior including the
  `notified` flag.
- `server/__tests__/calendar-sync.test.ts` (extend existing, or new file if
  none exists yet): `reconcileBookingsWithCalendar` cancels a booking whose
  event is missing from `listCalendarEvents`, leaves one whose event is
  present untouched, no-ops with no connected calendar provider.
- Cache behavior: a mock KV covering the skip-on-fresh-key /
  reconcile-on-miss branches of `reconcileIfStale`.
