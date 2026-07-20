# Sitter onboarding wizard v2 — business profile step + optional customization

**Date:** 2026-07-18
**Status:** Approved (user directed; frontend-only, zero server changes)
**Branch:** `custom-services`
**Extends:** `2026-07-18-onboarding-wizard-design.md` (v1 — lifecycle, presets, apply
mechanics, and additive semantics all carry over unchanged unless stated here)

> **Amended 2026-07-20:** Later work (`2026-07-19-service-level-attributes-design.md` /
> migration 0015 and the shipped `SetupWizard.tsx`) diverged from this spec:
>
> - **The "Accepted pet types" toggle row is gone.** The profile step renders no Dogs/Cats
>   toggles; `WizardProfileStep.tsx` shows a pointer line to the Pets and Services sections.
> - **Tenant capacity limits no longer "stay in Your business."** `MaxConcurrentPets` /
>   `MaxPerDay` / `MaxNights` moved **per-service** (migration 0015); they are not edited in
>   the profile step or the Business section.
> - **The `petTypes` wire shape is obsolete:** settings GET returns `{ petType, label }[]`
>   (no `enabled`), and there is no enabled-slug PUT array.
> - **The "Customize" disclosure is additionally gated on `rateUnit === 'visit'`** — it renders
>   only for per-visit presets, never for boarding/house-sit presets (`SetupWizard.tsx`).

## Problem

The shipped v1 wizard (`app/admin/SetupWizard.tsx`) gets a fresh tenant bookable,
but leaves the business identity untouched: the display name stays whatever the
SQL provisioning set, and contact info, timezone, accepted pet types, and brand
color must be hunted down afterwards across the "Your business" and "Pets you
care for" sections. Separately, the price step applies preset windows/capacities
as-is — a sitter whose real schedule differs must finish the wizard and then
re-edit everything in Services & rates.

Still **first-login only**: hosted signup / tenant self-provisioning remains
explicitly out of scope (reaffirmed); tenants are SQL-provisioned.

## Design

### Lifecycle: unchanged

Auto-opens on zero enabled services, launchable anytime via "Quick setup",
always skippable, re-runs are additive only — exactly as v1.

### Steps grow 3 → 4

#### Step 1 (new) — "About your business"

One screen of tenant-profile fields, every one already accepted by
`PUT /api/:slug/admin/settings` (`server/routes/admin.ts`) — **zero server
changes**:

| Field              | Control                                                        | Prefill                                                       |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------- |
| Display name       | text input                                                     | current `settings.displayName`                                |
| Contact email      | email input                                                    | current value (nullable)                                      |
| Contact phone      | tel input, optional                                            | current value (nullable)                                      |
| Timezone           | dropdown, `Intl.supportedValuesOf('timeZone')` + fallback list | current tenant value, else "Use `DEFAULT_TIMEZONE` (default)" |
| Accepted pet types | Dogs / Cats toggles                                            | current `settings.petTypes` enabled flags                     |
| Brand accent color | color swatch (`<input type="color">`)                          | current `settings.accentColor`                                |

Controls reuse the exact field idioms of `sections/BusinessSection.tsx`
(name/color/contact/timezone) and `sections/PetsSection.tsx` (pet toggles).

Writes use the same PATCH semantics the dashboard save uses: one
`PUT /settings` body containing **only the fields the sitter changed** (note the
wire shape: settings GET returns `petTypes` as `{ petType, enabled }[]`, but the
PUT body takes an array of enabled pet-type slugs). If nothing changed — the
common case on a re-run, where the step simply shows current values — no PUT is
sent. The write happens on advancing to step 2, so a server validation error
(the messages are already plain-language: "Display name required.", "Accent
color must be #rrggbb.", "Unknown timezone.") lands while the sitter is still on
the step.

#### Step 2 — "What do you offer?"

Unchanged v1 preset cards over `SERVICE_PRESETS` (`app/admin/presets.ts`).

#### Step 3 — "Set your prices" + opt-in customization

The fast path is untouched: one whole-dollar price input per selected preset.
New: each selected preset row gains a **collapsed-by-default "Customize"
disclosure**. Expanding it edits the preset's option payload(s) before apply:

- time window (`startTime` / `endTime` time inputs),
- `capacity` (nullable number field),
- `weekdaysOnly` checkbox,

using the same field idioms as the Services & rates option rows
(`sections/ServicesSection.tsx`). Edits mutate only the in-memory preset payload
being applied **this run** — never an existing service's options. Presets whose
matched service is already priced keep the v1 "Keeps its current pricing"
treatment and get no disclosure. Non-technical sitters who never open the
disclosure get exactly the v1 experience.

#### Step 4 — Done

Unchanged v1 finish screen (internal step state widens `1 | 2 | 3` →
`1 | 2 | 3 | 4`).

### Architecture

No new endpoints, no schema changes, no new dependencies. The v1 sequential
apply loop is reused verbatim; customized option payloads are substituted for
`preset.options` before the rate is stamped on and sent through the existing
per-service `PUT /settings` PATCH.

## Error handling

Same model as v1: sequential apply, in-place retry, already-applied work stays
applied, re-runs are additive-safe. New profile step: a failed `PUT` keeps the
sitter on step 1 with the plain-language error; already-saved profile fields are
harmless to resend.

## Not built (deliberate)

- Hosted signup / self-provisioning — reaffirmed out of scope.
- Editing existing services' options anywhere in the wizard.
- Customize beyond windows/capacity/weekdays: option labels, durations, and
  adding/removing options stay in Services & rates.
- Branding beyond the accent color (no logo upload).
- Tenant capacity limits (boarding spots, house-sits/day, max stay) in the
  profile step — they stay in "Your business", preserving nullable = unlimited.

## Testing

Server behavior (`PUT /settings` field validation, service apply) is already
covered by the existing Vitest suite; nothing server-side changes. The wizard
remains UI-only — verification is a manual Playwright walk (fresh tenant first
login, a re-run showing current profile values, and one customized preset),
per repo convention (Vitest is server-only).
