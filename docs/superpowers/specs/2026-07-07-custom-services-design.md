# Custom services (agnostic Service abstraction) — design

**Date:** 2026-07-07
**Status:** Approved (user directed implementation; template-driven variant chosen)
**Branch:** `custom-services`

## Problem

The service set is a closed, cross-tenant enum: `SERVICE_CATALOG` in
`server/lib/services.ts` hardcodes five services, schema `CHECK`s repeat the
list in three tables, and per-type behavior (shape, rate unit, duration,
capacity semantics) lives in code keyed by that enum. A sitter cannot offer
"Morning walk" and "Afternoon walk" as distinct bookable services.

The 2026-07-04 time-windowed-services spec worked around this by putting
windows on `TenantServiceOptions`, explicitly rejecting per-slot service types
_because_ `ServiceType` was a closed enum. This design removes that
limitation: services become per-tenant data rows, and the five built-ins
become **templates**. (The window/capacity option columns from that spec can
still layer on top later; nothing here conflicts with it.)

## Design

### Data model

`TenantServices` becomes the authoritative, agnostic Service store. Each row
carries its own behavior — every service has the same structure:

```sql
TenantServices (
  TenantId, ServiceType,          -- ServiceType is now a per-tenant SLUG (e.g. 'morning-walk'); CHECK dropped
  Enabled,
  Label TEXT NOT NULL,            -- display name, sitter-chosen
  Icon TEXT NOT NULL,             -- widget icon key: bed|home|sun|paw|clipboard
  Shape TEXT CHECK ('range','single'),
  RateUnit TEXT CHECK ('night','day','visit'),
  HasDuration INTEGER,            -- options priced per duration?
  CapacityKind TEXT CHECK ('boarding','housesit','none'),  -- which capacity POOL the service draws from
  SortOrder INTEGER,
  Questions, MinNights, MaxNights, MinPetCount, MaxPetCount  -- unchanged
)
```

`ServiceType` `CHECK`s are dropped from `TenantServices`,
`TenantServiceOptions`, and `BookingRequests` (SQLite table rebuilds).
`'blocked'` stays a reserved `BookingRequests.ServiceType` value and a
reserved slug.

**CapacityKind names the capacity pool, not the service.** The shared
capacity engine (`src/shared/booking/capacity.ts`) is untouched: `'boarding'`
= pet-counted against `Tenants.MaxBoardingPets`, `'housesit'` = day-counted
against `MaxHouseSitsPerDay` (incl. the ≤1-day overlap rule), `'none'` =
unlimited (blocked days only). A custom "Luxury boarding" shares the boarding
pet pool — capacity models the sitter's real-world resources, which don't
multiply when a service is cloned.

### Templates

`SERVICE_CATALOG` becomes `SERVICE_TEMPLATES` — seed data + the "Add service"
picker. Creating a service = pick a template + type a name; the template
permanently fixes Shape/RateUnit/HasDuration/CapacityKind/Icon (behavior is
not sitter-editable — no arbitrary combos, no new validation surface). Slug =
slugify(label); collisions and `'blocked'` rejected; `UNIQUE (TenantId,
ServiceType)` is the backstop.

### Migration `0006_custom_services.sql`

1. Rebuild `TenantServices` with the new columns, backfilling behavior from
   the template values for the five known slugs.
2. `INSERT OR IGNORE` the five built-in rows (Enabled=0) for every tenant, so
   rows — not code — are the service list from now on.
3. Rebuild `TenantServiceOptions` and `BookingRequests` without the
   `ServiceType` CHECKs (indexes recreated).

### Server

- `ServiceType` the TypeScript type becomes `string`; `isServiceType` guards
  are replaced by tenant-row lookups (which the routes already did for
  enablement anyway).
- `estimateCost` / `checkAvailability` / `monthAvailability` take the
  `TenantService` row and read `Shape`/`CapacityKind` from it.
- `listCapacityRows` joins `TenantServices` to select rows whose service
  draws from a capacity pool (previously a hardcoded
  `IN ('boarding','housesitting','blocked')`), returning `CapacityKind`.
- Calendar sync: `SyncInput` gains `serviceLabel` (from the row); the GCal
  `category` extended property stays the slug, and month-availability maps
  slug → CapacityKind via the tenant's rows (unknown/legacy slugs fall back
  exactly as before).
- Admin routes: `GET/PUT /admin/settings` work off rows;
  new `POST /admin/services` `{template, label}` (created disabled, priced +
  enabled via the normal PUT) and `DELETE /admin/services/:type` (custom
  services only, refused while any booking rows reference the slug).

### Clients

- Widget: already renders `config.services` generically; icons switch from a
  slug-keyed map to the row's `icon` field (paw fallback).
- Admin `ServicesSection`: renders the row list; adds an "Add service"
  form (template picker + name) and a delete button on custom services.
  Built-ins are disabled, never deleted.

## Not built (deliberate)

- Editing a service's behavior/template after creation, or renaming — delete
  and recreate.
- Fixed clock windows / per-slot capacity — that's the 2026-07-04 spec,
  unimplemented here; custom services make its "morning walk" example
  expressible today via separate services with duration options.
- Per-service capacity pools — custom services share the tenant-level pools.

## Testing

Existing suite must pass with built-in slugs unchanged. New coverage: create
service (slug derivation, collision, reserved slug), delete guards (custom
only, no bookings), booking a custom boarding-pool service counts against
`MaxBoardingPets`.
