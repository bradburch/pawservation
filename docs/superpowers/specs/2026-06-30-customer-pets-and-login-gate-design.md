# Customer pets & widget login gate — design

**Date:** 2026-06-30
**Status:** Approved (design)

## Problem

Two changes to the embed booking flow:

1. **"Pet" should mean the customer's actual animals**, not a species picker. Today the widget's
   "Pet" dropdown lists the _species the sitter accepts_ (`TenantPetTypes`: dog/cat). Customers should
   instead choose from their own named animals ("Bella", "Otis").
2. **Login is required to book.** Today a visitor can fill the Book form and is only prompted to
   identify at the final "Confirm & request". Booking should require authentication up front.

These are linked: a customer's pets belong to their account, so the booking form can only show pets
after login.

## Decisions (locked with the user)

- **Pets are sitter-managed.** The sitter adds each customer's animals in the admin dashboard. The
  customer picks from a fixed list; they cannot self-add.
- **Multi-select at booking.** The customer checks which of their pets a booking is for.
  `PetCount` = number selected. The manual "Pets" number field is **removed**.
- **Whole-widget login gate.** A logged-out visitor sees only the sign-in step (email → code) — no
  tabs, no service list, no prices — until authenticated.

## Data model (schema.sql + `migrations/0004_*` in lockstep)

Two new tables. Both are tenant-scoped and follow the repo isolation rule (`WHERE TenantId = ?`).

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

- `BookingRequests.PetCount` stays and continues to hold the pet count, so the shared **capacity**
  logic (`src/shared/booking/capacity.ts`) is untouched.
- `BookingRequests.PetType` stays as a representative species (the first selected pet's species) for
  the existing accepted-species validation and calendar-summary back-compat.
- `BookingRequestPets` is the source of truth for _which_ named pets a booking is for.

**FK caveat (CLAUDE.md):** `node:sqlite` enforces FKs in tests; production D1 has them off. SQL must
be correct under both — insert `EndUserPets`/`BookingRequestPets` rows only after their parents exist.

## Server

**`server/db/repo.ts` (only module touching `PAWBOOK_DB`), all `tenantId`-first:**

- `listEndUserPets(db, tenantId, endUserId)` → pet rows.
- `addEndUserPet(db, tenantId, endUserId, name, petType)` → inserts, returns the row.
- `removeEndUserPet(db, tenantId, petId)` → scoped delete.
- Booking create: after inserting the `BookingRequests` row, insert one `BookingRequestPets` row per
  selected pet; set `PetCount` = count and `PetType` = first pet's species.
- `listBookings` for a user: join `BookingRequestPets` → `EndUserPets` to return pet names per booking.

**Admin routes (`server/routes/admin.ts`):**

- Extend the customers list response so each customer includes its `pets: {id, name, petType}[]`.
- `POST /api/:slug/admin/customers/:id/pets` — body `{name, petType}`; `petType` must be an enabled
  tenant pet type.
- `DELETE /api/:slug/admin/customers/:id/pets/:petId`.

**Widget routes (`server/routes/bookings.ts` / public):**

- `GET /api/:slug/me/pets` — authenticated by the end-user token → that customer's own pets.
- Booking create accepts `petIds: string[]` **instead of** `petType` + `petCount`. Validation:
  - every `petId` belongs to the authenticated end-user **and** this tenant (else 400/403);
  - every pet's species is an enabled tenant pet type;
  - `petIds` is non-empty; count is checked against capacity as today.

## UI

**Admin dashboard (`app/admin/App.tsx`)** — in "Customers (invite-only)", each customer row gains a
pets sub-list: existing pets with a Remove ghost button, plus an add row (name text + species
`<select>` limited to the tenant's enabled pet types). Reuses existing `.pb-*` ledger styles.

**Embed widget (`app/embed/App.tsx`):**

- `App` gates on the end-user token: **no token → render `Identify` only** (no `<nav>` tabs, no
  config-driven prices). After login, render the Book / My bookings tabs.
- **BookTab**: replace the species "Pet" dropdown **and** the "Pets" number input with a checkbox
  group of the customer's pets (fetched from `/me/pets` on mount — login is now guaranteed). Empty
  state: "No pets on file yet — ask your sitter to add them." Submit sends `petIds`.
- Remove the now-dead mid-form `needIdentify`/identify-at-submit path.
- **MineTab**: show pet names per booking (e.g. "Bella, Otis").

## Known ripple effects (accepted)

- The **admin embed preview** (this branch) and the **`/demo`** page now show the widget's sign-in
  screen, since a sitter/visitor isn't a logged-in customer. Honest preview of the gated widget.
- Seed data (`sql/seed.sql`) gains a few `EndUserPets` rows for the demo customers so the demo flow
  still has pets to pick after signing in.

## Testing

- Repo: pets CRUD + tenant scoping; booking create writes `BookingRequestPets` and correct
  `PetCount`/`PetType`; `listBookings` returns names.
- Routes: admin add/remove pet (species must be enabled); `me/pets` returns only the caller's pets;
  booking create with `petIds` — ownership, cross-tenant rejection, disabled-species rejection,
  capacity.
- All under the existing in-memory-SQLite harness (`createTestEnv`), FK-safe.

## Verification gate (CLAUDE.md)

`npm run typecheck && npm run lint && npm run format && npm test && npm run build` — all five.
