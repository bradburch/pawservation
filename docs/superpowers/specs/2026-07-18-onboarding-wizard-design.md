# Sitter onboarding wizard + service presets — design

**Date:** 2026-07-18
**Status:** Approved — amended, see below
**Branch:** `custom-services`

> **Amended 2026-07-20:** The shipped wizard (`SetupWizard.tsx`) and its v2 extension
> (`2026-07-18-onboarding-wizard-v2-design.md`) went past this spec:
>
> - **The wizard is 4 steps, not 3.** A business-profile step was prepended (v2), so the flow is
>   Profile → "What do you offer?" → "Set your prices" → Done.
> - **"Editing capacity/windows inside the wizard" WAS built** (the "Not built" list below is
>   wrong): the price step's per-preset "Customize" disclosure edits `startTime` / `endTime` /
>   `capacity` / `weekdaysOnly` before apply, for per-visit presets.
> - **The retired "up to 8 dogs" preset copy** quoted below now reads "up to 8 bookings" — the
>   unit is bookings/spots, not pets (`app/admin/presets.ts`).

## Problem

The admin app has exactly two states: login → full dashboard. There is no
first-run experience — a freshly provisioned tenant (still done manually via
SQL; hosted signup is explicitly out of scope) lands on an empty dashboard and
must assemble services, options, and prices by hand across the Services &
rates section before anything is bookable.

The custom-services model already supports everything a first run needs:
per-tenant `TenantServices` rows cloned from `SERVICE_TEMPLATES`
(boarding/housesitting/daycare/walk/checkin), and `TenantServiceOptions` with
`StartTime`/`EndTime` windows and per-slot `Capacity`. The `docs/specs/*.md`
stubs define three walk offerings (max dogs, time windows, weekdays-only) plus
an empty `boarding.md`; this design turns them into one-tap presets.

## Design

### Wizard lifecycle

The wizard is re-runnable, never mandatory:

- **Auto-opens** on login when the tenant has zero enabled services.
- **Launchable anytime** via a "Quick setup" button in the Services & rates
  section.
- **Skippable** ("Skip for now") — it never traps the user; the dashboard is
  always reachable.

Re-runs are **additive only**. Already-enabled services render as already on;
the wizard never disables a service and never overwrites an existing
service's options or prices. A service that already exists and is enabled is
skipped; a disabled existing row gets enabled + priced only if the sitter
selects it.

### Weekday-only support (the one data-model change)

The walk presets are weekdays-only, which the option model cannot express.
Added:

- New int-bool column `WeekdaysOnly NOT NULL DEFAULT 0` on
  `TenantServiceOptions` — migration `0012` (next free number after `0011`) **and** the
  matching `sql/schema.sql` update, per project rule.
- **Server enforcement** at booking validation: reject Sat/Sun dates for
  weekday-only options, via a pure helper in `src/shared` (day-of-week
  derived from a `YYYY-MM-DD` string is timezone-free, so it stays in the
  zero-dependency core).
- **Widget mirror:** the embed widget greys out weekends for weekday-only
  options, matching the usual server-enforces / client-mirrors split.

### Presets (7)

Presets are a pure data constant `SERVICE_PRESETS` living in the admin app
(`app/admin/`), each referencing a template id plus prefilled option payloads:

| Preset                                | Template     | Options                                                                 | Weekdays-only |
| ------------------------------------- | ------------ | ----------------------------------------------------------------------- | ------------- |
| Pack Walks (`pack-walks`)             | walk         | 10:00–14:00, capacity 8                                                 | yes           |
| Multi Pack Walks (`multi-pack-walks`) | walk         | 10:00–14:00 and 14:00–17:00, capacity 8 each; one price applied to both | yes           |
| Solo Walker (`solo-walker`)           | walk         | 10:00–16:00, capacity 4                                                 | yes           |
| Boarding                              | boarding     | template defaults                                                       | no            |
| House-sitting                         | housesitting | template defaults                                                       | no            |
| Day care                              | daycare      | template defaults                                                       | no            |
| Check-ins                             | checkin      | template defaults                                                       | no            |

The last four simply enable the existing built-in template rows.
`boarding.md` was an empty stub, so the boarding preset is just the template +
a price.

### Architecture: frontend wizard over existing endpoints only

No new server endpoints. The wizard applies each selected preset with the
calls the Services & rates section already uses:

- `POST /api/:slug/admin/services` to create the walk-type clones (slugs
  `pack-walks`, `multi-pack-walks`, `solo-walker`).
- `PUT /api/:slug/admin/settings` to write options + prices + enable.
- If a built-in template row is missing for a tenant (fresh tenant with no
  seeded rows), the wizard creates it via `POST` first, then enables via
  `PUT`.

### UX — 3 steps, phone-friendly, for non-technical sitters

1. **"What do you offer?"** — big tappable multi-select cards using the
   existing service icons, one-line summary per preset (e.g. "Group walks ·
   weekdays 10–2 · up to 8 dogs"). No typing.
2. **"Set your prices"** — one whole-dollar price input per selected preset,
   with the preset summary shown; rate unit comes from the template (walks
   per visit, boarding per night). Nothing else is editable here.
3. **Done** — "You're bookable — fine-tune anytime in Services & rates", plus
   a pointer to the embed snippet section.

### Error handling

Selections apply sequentially. On a failed request the wizard shows a
plain-language error and leaves the user in place to retry;
already-applied services stay applied. Re-running is safe because of the
additive semantics plus the slug collision checks in `POST /services`.

## Not built (deliberate)

- Hosted signup / tenant self-provisioning — tenants stay SQL-provisioned.
- Per-day schedules beyond the weekday flag.
- Editing capacity/windows inside the wizard — Services & rates already does
  that.

## Testing

Server-side Vitest (the only test harness): weekday-only booking rejection —
unit tests on the shared helper plus a booking-route test through the real
schema. `WeekdaysOnly` must land in `sql/schema.sql` so `createTestEnv` sees
it. The wizard itself is UI-only over existing tested endpoints; manual
verification via the `running-pawbook` skill flow.
