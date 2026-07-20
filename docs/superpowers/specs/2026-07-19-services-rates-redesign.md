# Services & rates redesign — summary cards with edit-on-demand

**Date:** 2026-07-19
**Status:** Shipped
**Branch:** `custom-services`

> **Amended 2026-07-20:** This redesign shipped (Status was "Proposed"). Its claim under
> **Expanded editor** that "no field is removed or renamed" no longer holds:
> `2026-07-19-service-level-attributes-design.md` (migration 0015) added an **Accepted-pets**
> group and **per-service capacity caps** (`MaxConcurrentPets` / `MaxPerDay`) to the editor,
> and `serviceSummary` grew a **sixth facts fragment** (the accepted-pets fact,
> `src/shared/util/service-summary.ts`). Treat the field inventory below as of-its-time.

## Problem

The Services & rates section renders every service fully expanded: checkbox,
options editor (label/duration/price/window/capacity/weekdays), questions
editor, and booking limits — stacked vertically for up to 7+ services
(`app/admin/sections/ServicesSection.tsx`). A sitter cannot answer "what do I
offer and at what price?" without scrolling a wall of forms, and on a phone the
section is effectively unreadable. Meanwhile the setup wizard
(`app/admin/SetupWizard.tsx`) teaches every new sitter a much better idiom on
day one: a grid of tappable service cards (icon, name, one-line summary).
Landing in Services & rates afterwards is a visual cliff.

This is a **re-presentation only**: every existing capability stays —
enable/disable, add from template, delete custom services, options with
windows/capacity/weekdays-only, the questions editor with reordering, and
booking limits. Save semantics (the single settings PUT behind the sticky save
bar in `App.tsx`) are untouched.

## Options considered

1. **Card grid + in-grid expansion (chosen).** Summary cards in the wizard's
   visual language; tapping a card expands its full editor as a full-width
   region within the grid flow, one open at a time. Collapses to a natural
   accordion at one column on phones.
2. **Card grid + slide-over / bottom sheet.** More "app-like", but a modal
   layer fights the global fixed save bar: on a phone a full-screen sheet
   either hides the save bar or needs its own save affordance, splitting the
   one-PUT dirty model into two competing surfaces. Rejected.
3. **Settings-style list rows with disclosure.** Simplest to build, but throws
   away the card language sitters just learned in the wizard, and a row list
   is barely better than today at showing prices/facts at a glance. Rejected.

**Rationale for 1:** it is the only option that delivers glance-ability _and_
onboarding continuity _and_ leaves the save-bar model structurally alone — the
expanded editor is ordinary in-page content editing the same staged `settings`
draft, so nothing about dirtiness, saving, or the `#services` deep link
changes.

## Design

### Summary grid

The section body becomes a responsive grid of service cards (all services,
enabled and disabled), followed by an Add tile. Same grid recipe as the
wizard: `repeat(auto-fill, minmax(220px, 1fr))`, single column on narrow
phones. No horizontal scroll anywhere; long labels truncate with the existing
`.pb-truncate` idiom.

```
┌ Services & rates ──────────────────────────────────────────┐
│ [Quick setup]  One-tap presets — additive, never overwrites│
│                                                            │
│ ┌─────────────────┐ ┌─────────────────┐ ┌────────────────┐ │
│ │ 🐾 Pack Walks  ◉│ │ 🏠 Boarding    ◉│ │ 🌙 House-     ○│ │
│ │ $25/visit       │ │ $55/night       │ │    sitting     │ │
│ │ Weekdays 10–2 · │ │ Min 2 nights ·  │ │ Not offered —  │ │
│ │ up to 8         │ │ 3 questions     │ │ turn on to     │ │
│ │                 │ │                 │ │ take bookings  │ │
│ └─────────────────┘ └─────────────────┘ └────────────────┘ │
│ ┌─────────────────┐ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐                    │
│ │ ☀️ Day care    ◉│    +  Add a                            │
│ │ from $20/visit  │ │    service      │                    │
│ │ 2 visit lengths │                                        │
│ └─────────────────┘ └ ─ ─ ─ ─ ─ ─ ─ ─ ┘                    │
└────────────────────────────────────────────────────────────┘
```

Expanded state — the editor spans all columns directly after the tapped
card's grid position; later cards reflow below it (at one column this is
exactly an accordion):

```
│ ┌─────────────────┐ ┌═════════════════┐ ┌────────────────┐ │
│ │ 🐾 Pack Walks  ◉│ │ 🏠 Boarding    ◉│ │ 🌙 House-sit  ○│ │
│ └─────────────────┘ └═════════▲═══════┘ └────────────────┘ │
│ ┌═ Boarding ════════════════════════════════════════════┐  │
│ │ Pricing & options                                     │  │
│ │  [Standard] $[55]/night                    [Remove]   │  │
│ │  Window (optional) [--:--][--:--] Capacity [ ]        │  │
│ │  [Add an option]                                      │  │
│ │ Questions                                             │  │
│ │  [Vaccinated?]  [Yes/No ▾] [x] Required  ↑ ↓ [Remove] │  │
│ │  [Add question]                                       │  │
│ │ Booking limits                                        │  │
│ │  Min nights [2]  Max nights [ ]  Min pets [ ] Max [ ] │  │
│ │                               [Delete service] [Done] │  │
│ └═══════════════════════════════════════════════════════┘  │
│ ┌─────────────────┐ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐                    │
```

### Card anatomy

Each card is a `div.pb-svc-card` containing two **sibling** interactive
elements (never nested, for valid HTML and clean a11y):

- **Enable switch** (top-right `◉`/`○`): the existing enabled checkbox
  restyled as a switch (`role`/semantics stay `input[type=checkbox]`,
  `accent-color: var(--ink)`), with an `aria-label` of
  "Offer {service label}". Toggling edits the draft — save bar appears as
  today. No expansion needed to turn a service on or off.
- **Expand button** (`button.pb-svc-open`, the rest of the card): icon, name,
  price line, facts line. `aria-expanded` + `aria-controls` pointing at the
  editor region. Tapping toggles expansion.

Card content lines:

1. **Icon + label** — `SERVICE_ICONS[icon]`, display face, `.pb-truncate`.
   Custom services additionally get a small `.pb-chip` "Custom".
2. **Price line** (ink, semibold): `$55/night` for one option; `from
$20/visit` when options have differing rates; `$20/visit · 2 options` when
   equal; `No pricing yet` (soft) when the service has zero options.
3. **Facts line** (`.pb-hint`), at most two fragments joined by " · ", chosen
   by fixed priority so summaries are deterministic:
   1. window + weekdays (`Weekdays 10–2` / `Daily 9–5`, from the first
      windowed option, times rendered compact in the tenant's clock),
   2. capacity (`up to 8`),
   3. option count when >1 and not already shown in the price line
      (`3 visit lengths`),
   4. night limits (`Min 2 nights`, `2–14 nights`),
   5. question count (`3 questions`).

**Visual language = wizard cards.** Extract the wizard tile base into a shared
class (`.pb-tile-btn`: white card, `--line` border, 10px radius, left-aligned
column) that both `.pb-wizard-cardbtn` and `.pb-svc-card` compose, so the two
cannot drift. Enabled cards use the wizard's "on" treatment (`--sage` border +
`--sage-wash`); this is the continuity moment — the dashboard looks like the
wizard the sitter graduated from.

### States

- **Enabled:** sage border/wash, full price + facts lines.
- **Disabled:** default border, content at reduced opacity, facts line
  replaced by "Not offered — turn on to take bookings". Still expandable —
  a sitter can prepare pricing before flipping the switch.
- **Expanded:** card keeps an "open" affordance (sage border + a caret/notch
  pointing at the editor); one card open at a time — expanding another
  collapses the first. **Collapsing never loses edits**: all field state
  lives in the staged `settings` draft, exactly as today; the save bar is the
  single source of truth for unsaved changes.
- **Empty (zero services):** the grid shows only the Add tile plus a
  card-sized invitation: "No services yet — run Quick setup or add one below."
  (The wizard already auto-opens for the all-disabled case; unchanged.)

### Expanded editor (`div.pb-svc-editor`)

The existing editors, regrouped under the existing `h3` voice — no field is
removed or renamed:

1. **Pricing & options** — the current flat label+`$/unit` row for
   non-duration services, or the current option rows (label, minutes, rate,
   window, capacity, weekdays-only checkbox-while-windowed) + "Add an option"
   for per-visit services. Unchanged logic, including the auto-label-sync on
   duration edits.
2. **Questions** — the current `QuestionRow` list verbatim (types,
   required, min/max, choices, pattern, ↑/↓ reorder, Remove, Add question).
3. **Booking limits** — min/max nights (range-shape services only), min/max
   pets, via `NullableNumberField` (nullable = unlimited semantics preserved).

Footer row: **Delete service** (custom services only — moved here from the
card so a destructive action needs two deliberate taps; ghost-danger styling,
`window.confirm` guard since it fires an immediate DELETE) and **Done**
(ghost), which collapses the editor and returns focus to the card's expand
button.

Grid mechanics: the editor element is rendered as the card's next sibling
with `grid-column: 1 / -1`, so auto-placement puts it on the row after the
card and reflows later cards below — the standard expanding-grid-card
pattern. Height animates only outside `prefers-reduced-motion`.

### Add service

A dashed "add" tile (`button.pb-svc-add`, same tile base, dashed `--line`
border, `+ Add a service`) sits last in the grid. Tapping expands — through
the same full-width mechanism — the existing `AddServiceForm` (template
select + name input + Add). Semantics unchanged: add and delete remain
immediate POST/DELETE + refresh, outside the save-bar draft, as today. The
"Quick setup" button and its hint keep their current spot under the section
heading.

### What does not change

- **Save model:** field edits mutate the staged draft via `setSettings`; one
  PUT from the save bar. No per-card save, no new endpoints.
- **Deep links:** the section key stays `services`, so `#services` (calendar
  spec's deep-link target, wizard step-4 "fine-tune" pointer) works as-is.
  Expansion state is component-local and unaddressed by the hash.
- **Data shapes:** `ServiceForm` and the PUT payload are untouched.

### Component structure

```
ServicesSection            — owns expanded: string | null ('__add' for the tile)
├─ ServiceCard             — switch + expand button + summary derivation
├─ ServiceEditor           — options / questions / limits (extracted from
│                            today's inline JSX; QuestionRow reused verbatim)
└─ AddServiceTile          — dashed tile + existing AddServiceForm
```

Summary derivation is a pure helper (`serviceSummary(s): { price, facts }`)
so it is unit-testable without DOM.

### Accessibility

- Expand buttons: `aria-expanded`, `aria-controls`; editor: `role="region"`,
  `aria-labelledby` the card title. Focus stays on the trigger on expand;
  the editor's Done button returns focus to the trigger on collapse.
- Enable switch and expand button are siblings — both reachable in tab
  order, both with visible `:focus-visible` rings (existing global rule).
- Disabled-state cards remain fully keyboard-operable (reduced opacity only,
  no `disabled` attributes).
- Facts are plain text inside the button, so the accessible name of each
  card reads name + price + facts — the at-a-glance summary is also the
  screen-reader summary.

## Not built (deliberate)

- Per-card dirty indicators (needs the `savedSnapshot` diff plumbed down;
  the save bar already answers "do I have unsaved changes?").
- Hash-addressed expansion (`#services/pack-walks`) — nothing links to a
  specific service today.
- Drag-to-reorder services — server has no ordering field.

## Testing

UI-only over existing tested endpoints. Vitest (the only harness) covers the
pure `serviceSummary` helper if it lands beside other pure code; otherwise
manual verification via the `running-pawbook` skill: seed tenant → grid
renders all services with correct price/facts lines → expand/edit/save round-
trips through the save bar → add tile and custom-service delete still hit
POST/DELETE → phone-width pass (single column, no horizontal scroll) →
keyboard pass (tab order, `aria-expanded`, focus return on Done).
