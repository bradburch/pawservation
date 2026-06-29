# Phase 1 & 2 — Google Calendar OAuth + Invite-only Customers

**Date:** 2026-06-28
**Status:** Approved (design)

## Overview

Two roadmap features, each graduating an existing stub rather than building greenfield:

- **Phase 1 — Google Calendar OAuth.** Turn the `calendar`/`google-calendar` capability from a
  status-flip stub (`'connected-stub'`) into a real **OAuth2 authorization-code flow** plus
  **all-day calendar event creation** when a booking is requested.
- **Phase 2 — Invite-only customers.** Flip the customer model from *open self-identify* to
  **gated invite-only**: only emails a provider has added can receive a login code, and adding a
  customer sends a courtesy invite email (reusing the existing Resend integration).

### Decisions locked in brainstorming

- **Invite model:** Gated (true invite-only). Un-invited emails cannot get a login code.
- **Calendar trigger:** On booking request (every `pending` booking creates a tentative event).
  No provider confirm/cancel flow is built.
- **OAuth creds:** Real Google Cloud OAuth client; flow validated end-to-end against live Google.
- **An "invite" is an allowlist entry + a courtesy email** — there is **no** separate accept-link
  token, because the existing passwordless email-code login already verifies the address.
- **Existing self-created customers are grandfathered** as `active` so the gate never locks out
  anyone who already booked.

### Two driving constraints

1. The OAuth **callback cannot be tenant-authed** — Google redirects with no session — so tenant
   identity travels in a **signed, single-use `state`**, and the redirect URI is **global** (one
   path) so it is registered once in Google Cloud rather than per-slug.
2. The booking row is the **source of truth**; calendar sync is **best-effort** (via
   `executionCtx.waitUntil`) so a Google outage never fails a booking.

## Data model

One new migration, `migrations/0003_calendar_oauth_and_invites.sql`. `sql/schema.sql` is updated
in lockstep so fresh installs get the full current schema (per the README migrations contract).

### `ProviderConnections`

- Extend the `Status` CHECK to `('disconnected', 'connected-stub', 'connected')`.
- Add columns: `AccessToken TEXT`, `RefreshToken TEXT`, `TokenExpiresAt TEXT`, `CalendarId TEXT`.
- `AccessToken`/`RefreshToken` are **encrypted at rest** with AES-GCM. The key is derived from the
  existing `TOKEN_SECRET` via HKDF-SHA256 (info label `"pawbook-gcal-token"`) — no new secret.
- `CalendarId` defaults to `'primary'` (the connected account's primary calendar).

> SQLite/D1 cannot `ALTER ... ADD CONSTRAINT`, so widening the `Status` CHECK in the migration is
> done by the standard table-rebuild dance (create new table with the new CHECK, copy rows, drop
> old, rename). `sql/schema.sql` simply ships the final CHECK.

### `BookingRequests`

- Add `GCalEventId TEXT` (nullable) — the Google event id, so an event can later be deleted.

### `EndUsers` (now the provider-managed customer list)

- Add columns: `Name TEXT`, `InvitedAt TEXT`,
  `Status TEXT NOT NULL DEFAULT 'active' CHECK (Status IN ('invited', 'active'))`.
- Existing rows default to `'active'` (grandfathered). Provider-added rows are `'invited'`; the
  first successful `verify` promotes them to `'active'`.

## Phase 1 — Google Calendar OAuth

### Secrets / config (`wrangler secret put`, plus `env.d.ts` + `.dev.vars`)

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI` — the absolute URL of the global callback, e.g.
  `https://<worker>/oauth/google/callback`. Registered as an authorized redirect URI in Google
  Cloud. Used both when building the consent URL and when exchanging the code.

OAuth parameters: scope `https://www.googleapis.com/auth/calendar.events`, `access_type=offline`,
`prompt=consent` (guarantees a refresh token even on re-consent).

### New module `server/lib/google-calendar.ts`

Isolated and unit-testable against a mocked `fetch`. Pure-ish functions; no Hono/DB coupling.

- `buildAuthUrl(env, state): string` — Google consent URL.
- `exchangeCode(env, code): Promise<TokenSet>` — authorization code → `{ accessToken, refreshToken,
  expiresAt }`.
- `refreshAccessToken(env, refreshToken): Promise<{ accessToken, expiresAt }>`.
- `createEvent(accessToken, calendarId, event): Promise<{ id }>` — all-day event.
- `deleteEvent(accessToken, calendarId, eventId): Promise<void>`.
- `encryptToken(env, plaintext): Promise<string>` / `decryptToken(env, ciphertext): Promise<string>`
  — AES-GCM with the HKDF-derived key; ciphertext is base64 `iv || ct`.

### State signing (`server/lib/token.ts` or a small helper)

- `state = base64url(payload) + "." + hmacSha256(payload, TOKEN_SECRET)` where `payload` is
  `{ tenantId, nonce, exp }`. The `nonce` is also written to KV (`PAWBOOK_CACHE`) with a short TTL
  and **deleted on use** (single-use; defeats replay even within `exp`).

### Routes

- `GET /api/:slug/admin/providers/calendar/oauth/start` (admin-authed) → mint signed `state`,
  store nonce in KV, return `{ url }` (the Google consent URL). The admin UI opens it in a popup.
- `GET /oauth/google/callback?code&state` — **global, no slug, no auth.** Registered in `index.ts`
  outside the `/api/:slug/*` tenant middleware. Steps: verify HMAC → check `exp` → consume nonce
  from KV (reject if missing/used) → `exchangeCode` → encrypt tokens → `setProviderTokens(...)`
  with status `'connected'` → return a minimal self-closing HTML success page. Any failure returns
  a plain error page (never leaks tokens or codes).
- `POST /api/:slug/admin/providers/calendar/disconnect` (admin-authed) → best-effort token revoke
  at `https://oauth2.googleapis.com/revoke`, clear token columns, set status `'disconnected'`.

The existing `POST /:slug/admin/providers/:capability/connect` (stub flip) stays for the remaining
stub capabilities (`crm`/notion, `email`/gmail). `calendar` now uses the OAuth start route instead.

### Event creation on booking

In the existing `POST /:slug/bookings` success path (after the capacity check passes and the row is
confirmed kept):

1. Load the tenant's `calendar` connection. If status !== `'connected'`, skip.
2. Schedule the sync with `c.executionCtx.waitUntil(...)` so the HTTP response is not delayed:
   - If `TokenExpiresAt` is past, `refreshAccessToken` and persist the new access token/expiry.
   - Build an **all-day** event (the booking model has no time-of-day):
     - Range services (boarding) / blocked: `start = StartDate`, `end = EndDate` (exclusive,
       which is exactly Google's all-day `end.date` semantics).
     - Single-day services (daycare/walk/checkin): one all-day day on `StartDate`.
   - Summary e.g. `"{ServiceLabel} — {customer email} ({petCount} pet/s)"`; description includes
     service option + estimated cost.
   - `createEvent`, then persist `GCalEventId` on the booking.
3. **All failures are caught, logged, and swallowed** — the booking already succeeded.

> `waitUntil` means the customer gets their `201` immediately; the calendar write completes in the
> background. If it fails, `GCalEventId` stays null and the booking is unaffected.

## Phase 2 — Invite-only customers

### Gating `identify`

`POST /:slug/identify` looks up the `EndUser` by `(tenantId, email)`. If absent → `403`
`"This provider books by invitation only."`. It **no longer auto-creates** users (the current
`upsertEndUser` call at this seam becomes a lookup). All other behavior (code generation, Resend
send, fail-closed 503) is unchanged. On successful `verify`, an `'invited'` user is promoted to
`'active'` (set `Status` + leave `InvitedAt`).

### Provider customer management (new admin routes in `server/routes/admin.ts`)

- `GET /:slug/admin/customers` → `{ customers: [{ id, email, name, status, invitedAt }] }`.
- `POST /:slug/admin/customers` `{ email, name? }` → validate email; upsert an `EndUser` with
  `Status:'invited'`, `InvitedAt:now`; send invite via Resend (fail-closed: if email is configured
  and the send fails, return `502`; in dev with no provider, still create the row and return ok).
  Idempotent: re-adding an existing email returns the existing row (does not downgrade `active`).
- `DELETE /:slug/admin/customers/:id` → delete the `EndUser` only if they have **no** bookings;
  otherwise `409` `"Customer has bookings; cannot remove."`.

### New email `sendInvite(env, to, tenant, widgetUrl)` in `server/lib/email.ts`

Mirrors `sendLoginCode`: subject `"You're invited to book with {DisplayName}"`, body links to the
widget (`{origin}/embed/{slug}`). Throws if Resend rejects; throws if not configured (callers in
production fail closed, dev path skips sending).

### Admin UI (`app/admin/App.tsx`, `app/shared-ui/api.ts`)

- **Customers panel:** add (email + optional name), list with status badge (`invited`/`active`),
  remove. Wires the three customer routes.
- **Connect Google Calendar:** replace the stub "connect" for the `calendar` capability with a
  button that calls the OAuth start route and opens `url` in a popup; show `connected` /
  `disconnected` state and a disconnect button. Other capabilities keep the existing stub button.

## Repo / DB layer (`server/db/repo.ts`)

New/changed functions (all tenant-scoped, parameterized):

- `getEndUserByEmail(db, tenantId, email)` (replaces auto-create at identify).
- `insertInvitedCustomer(db, tenantId, email, name)`, `listCustomers(db, tenantId)`,
  `deleteCustomer(db, tenantId, id)`, `countBookingsForUser(db, tenantId, endUserId)`,
  `promoteCustomerActive(db, tenantId, endUserId)`.
- `getProviderConnection(db, tenantId, capability)` (with token columns),
  `setProviderTokens(db, tenantId, capability, provider, { access, refresh, expiresAt, calendarId })`,
  `clearProviderConnection(db, tenantId, capability)`.
- `setBookingGCalEventId(db, tenantId, bookingId, eventId)`.

## Security

- **Signed, single-use `state`** (HMAC + KV nonce) defends the OAuth callback against CSRF/replay.
- **Tokens encrypted at rest** (AES-GCM, key from `TOKEN_SECRET` via HKDF).
- **Refresh handled server-side**; access tokens never leave the Worker.
- **Fail-closed email** for invites mirrors the existing `/identify` posture (never leak; 503/502
  rather than silent leakage).
- **Gating returns a generic 403** and does not reveal whether an email exists beyond the invite
  status (same address either way for invited users — code is emailed, never returned).

## Testing

- `server/__tests__/google-calendar.test.ts` — token encrypt/decrypt round-trip; auth-URL shape
  (scope, access_type, prompt, redirect_uri, state); `exchangeCode` & `refreshAccessToken` against
  mocked `fetch`; all-day event payload for range vs single-day.
- `server/__tests__/oauth-callback.test.ts` — valid callback stores encrypted tokens + status
  `connected`; tampered HMAC rejected; replayed/missing nonce rejected; expired `state` rejected.
- `server/__tests__/invites.test.ts` — gated `identify` rejects un-invited (403), accepts invited;
  `verify` promotes `invited`→`active`; grandfathered existing users still work; customer CRUD;
  delete-with-bookings → 409; invite email fail-closed behavior.
- `server/__tests__/migration-0003.test.ts` — new columns/CHECK exist; existing rows backfilled to
  `active`.
- Booking-flow test extended: with a connected calendar (mocked), a booking persists a
  `GCalEventId`; with calendar disconnected, booking still succeeds and `GCalEventId` stays null.

## Out of scope (YAGNI)

- Provider booking confirm/cancel flow and calendar event updates/deletes on status change (only
  create-on-request is built; `deleteEvent` exists for disconnect/future use).
- Two-way calendar sync (reading external events back into availability).
- Notion/Gmail capability graduation (remain stubs).
- Self-serve tenant signup / billing (Phase 3).
