# Landing marketing redesign — show sitters the real widget

**Date:** 2026-07-19
**Status:** Proposed
**Branch:** `custom-services`

## Problem

The root landing page (`LANDING_HTML` in `server/index.ts`) is a capability
page written for a reader who already cares how Pawbook is built: the hero
sells "a booking widget," the deploy note pitches self-hosting on Cloudflare
Workers, an entire section is an embed snippet, and the FAQ ends in "deploy
your own copy (MIT)." The owner's directive is that the audience is **pet
sitters deciding whether Pawbook fits their business** — they need to _see_
what their clients would see and what they'd control, and "they are not as
interested in the technical details or OSS."

Today the page contains zero imagery of the actual product. The one visual —
the hand-drawn ledger day-book card — is an illustration of an outcome, not
the widget. A sitter leaves without knowing what the thing looks like.

Constraints that must survive: the page is served under `LOCKED_CSP`
(`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
frame-ancestors 'none'`) + `X-Frame-Options: DENY`, so it stays **script-free
with inline styles only**. Same-origin images are already permitted
(`img-src 'self'`) — imagery needs no CSP change and no new routes.

## Options considered — imagery

1. **Real widget screenshots, captured from the seeded demo and committed to
   `public/img/landing/` (chosen).** Authentic by construction — the page
   shows exactly what a client gets, greyed weekends and all. Cost: shots
   drift as the widget evolves, so the spec documents an exact, deterministic
   regeneration recipe (below) and the PR checklist for widget-visual changes
   should mention it.
2. **Pure-CSS mock of the widget inline.** No drift discipline needed and no
   image bytes, but it duplicates widget markup inside `LANDING_HTML` (a
   second, unshared copy of the calendar/pills/summary DOM) and it _can lie_
   — the mock keeps "working" while the real widget changes underneath it,
   which is worse than a visibly stale screenshot. Rejected.
3. **Stylized SVG illustration of the widget.** Fits the ledger identity but
   is still a drawing of the product on a page whose whole job is "is this
   real and right for me." Rejected for the same can-lie reason.

**Rationale for 1:** the directive is "images and assets that reflect what
the embedded widget will look like." Only real pixels satisfy that. Drift is
managed, not avoided: shots are regenerated from seeded, fixed-date demo data
so two captures a month apart are pixel-comparable.

### Asset pipeline (no new infrastructure)

Vite copies `public/` into `dist/` at build; the `ASSETS` binding serves it
(`wrangler.jsonc` → `assets.directory: ./dist`), and `/img/*` is not in
`run_worker_first`, so images are served directly by the asset layer,
same-origin. Committed files:

> **Amended 2026-07-20 (landing SaaS redesign, PR #36):** the ledger/paper
> treatment described later in this spec was replaced by a clean SaaS layout;
> screenshots now sit in flat framed cards (no tilt, no marginalia, no BOOKED
> stamp). `admin-bookings.webp` was retired — the dashboard illustration is a
> coded HTML/CSS mock (`.mockdash` in `LANDING_HTML`), so only the four
> widget shots below are captured. Total budget is now **≤210KB**
> (`landing.test.ts` is the enforcing test, updated in the same PR).

| File (public/img/landing/) | Content                                              | Budget |
| -------------------------- | ---------------------------------------------------- | ------ |
| `widget-hero.webp`         | Full widget, boarding range selected + quote         | ≤90KB  |
| `step-services.webp`       | Crop: service pill row, one selected                 | ≤40KB  |
| `step-calendar.webp`       | Crop: month grid — struck full days, greyed weekends | ≤40KB  |
| `step-request.webp`        | Crop: summary card + "Send request"                  | ≤40KB  |

WebP throughout (universal in evergreen browsers; the widget has a single
light theme, so one set only). **Total budget ≤210KB**, enforced by test
(below). Intrinsic width 2× the CSS display width (hero displays ~420px →
840px intrinsic) so it stays crisp on retina without ballooning.

### Regeneration recipe (the drift contract)

Documented here and pointed at by an HTML comment above the image block in
`LANDING_HTML`. Deterministic because it navigates to **fixed seeded months
(2028)**, not "today."

```bash
npm run seed:local        # fixed demo data (sql/seed.sql)
npm run build
npx wrangler dev --var ENVIRONMENT:development --var RESEND_API_KEY: --var RESEND_FROM:
```

Then with Playwright (headless Chromium, viewport **480×980, deviceScaleFactor
2**), against `http://localhost:8787/embed/sunny-paws`:

1. **Sign in:** email `jess@example.com` → Send code → read the on-screen dev
   code from `.bp-proto-code strong` → enter → verify. (Dev mode only; the
   code note is gone after sign-in so it never appears in shots.)
2. **`widget-hero.webp`:** pick **Boarding**, page the calendar to **June
   2028** (seeded: 1-of-2 boarding slots taken Jun 20–25 → partial-day rings
   visible), select **Jun 26 → Jun 29**, tick **Bella** and **Mochi**, then
   _Check availability_ so the summary shows the $150 quote. Element
   screenshot of `.bp-widget`.
3. **`step-services.webp`:** element shot of `.bp-service-grid` with Boarding
   selected (from the same session).
4. **`step-calendar.webp`:** switch to **Morning walk** (weekday-only — see
   seed change below), page to **July 2028**: seeded block Jul 3–4 renders
   struck-through, weekends grey. Element shot of `.bp-cal`.
5. **`step-request.webp`:** back on the boarding flow, element shot of
   `.bp-summary` (dates + cost + _Send request_).
6. ~~**`admin-bookings.webp`**~~ — retired 2026-07-20: the landing page's
   dashboard illustration is now a coded CSS mock (`.mockdash` in
   `LANDING_HTML`), not a screenshot. Nothing to capture.
7. **Optimize:** `cwebp -q 80` (or equivalent), verify each file against its
   budget row above.

**One seed change (in scope):** mark Sunny Paws' custom `morning-walk` option
weekday-only — `WeekdaysOnly=1` on `opt_sp_mw30` in `sql/seed.sql` (column
exists in `TenantServiceOptions`; seed is `INSERT OR REPLACE`, so re-seeding
applies it). "Morning walk, weekdays" is plausible sitter behavior, it makes
the greyed-weekend capability _visible_ in both the demo and the calendar
shot, and it exercises a rule the page claims.

## Design — page structure

The ledger/paper/serif/mono identity carries over; this is a recomposition,
not a rebrand. The evolved signature: **real screenshots treated as physical
objects on the ledger paper** — slight rotation, paper border, penciled
`.marginalia` captions — so authentic UI lives inside the existing world. The
red paw **BOOKED stamp** survives, overlaid (CSS, `aria-hidden`) on the
corner of the step-3 request crop: the one flourish, spent where the page's
promise lands ("you confirm it").

```
┌──────────────────────────────────────────────┐
│ [widget-hero photo, rotated −0.7°, stamp-less]│  hero: the real thing
│         Pawbook                              │
│  "Your own booking page, on your own site."  │
│  [Try the demo →]   Sitter sign in →         │
│  invite note (mailto CTA)                    │
├─ What your clients see ──────────────────────┤
│  1 pick a service   2 pick the dates   3 send│  numbered: it IS a sequence
│  [pills crop]       [calendar crop]  [request│
│                      "weekends greyed" crop+stamp]
├─ What you control ───────────────────────────┤
│  [admin-bookings photo] │ dl lines (rates,   │
│                         │ caps, clients,     │
│                         │ payments, calendar)│
├─ How it installs ────────────────────────────┤
│  one line of escaped HTML, small slip        │
├─ Common questions (5) ───────────────────────┤
├─ Want in? invite-only band, mailto CTA ──────┤
└─ footer: one OSS line ───────────────────────┘
```

1. **Hero.** The drawn ledger day-book card **retires**; `widget-hero.webp`
   takes its slot with the same taped-object treatment and a marginalia
   caption ("what your clients see"). Headline shifts from product-naming to
   sitter benefit — lede: _"Your own booking page, on your own website."_;
   sub keeps the it-lives-on-your-site + you-confirm promise in client
   language. Actions: **Try the demo →** primary (unchanged), **Sitter sign
   in →** quiet link. The self-host link leaves the hero (footer only). The
   deploy note becomes an invite note: _"Pawbook is invite-only right now —
   [ask for an invite](mailto:...) or sign in if you have an account."_
2. **What your clients see** — a numbered 3-step strip (numbering is honest
   here: booking is a sequence): **1 They pick a service** (`step-services`),
   **2 They pick the dates** (`step-calendar` — caption calls out struck-out
   full days and greyed weekends: "days you can't take aren't offered"),
   **3 They send the request — you confirm it** (`step-request` + BOOKED
   stamp). Each step: h3, one sentence, one crop.
3. **What you control** — the current "What it does" `book-group` ledger
   lines survive, condensed and de-jargoned (drop "timezone", keep caps/time
   off/rates/clients/payments/earnings/Google Calendar), paired with
   `admin-bookings.webp` in the photo treatment. This is the dashboard-value
   strip: nothing books itself; you set the prices; money is tracked.
4. **How it installs** — the embed section **shrinks and moves down**: the
   `.slip` keeps the HTML-escaped snippet (`&lt;script&gt;…` — the served
   body still contains no `<script`) but the framing becomes reassurance
   ("adding it is one line — paste it into Squarespace, Wix, or any page"),
   not instruction. The iframe-fallback fine print stays one line.
5. **Common questions** — five sitter-relevant items survive verbatim-ish:
   Squarespace/Wix, card payments (no — you collect), double-booking (no —
   with the one-way calendar caveat), clients-only, second-dog pricing. The
   pet-types sentence **absorbs animal-types Task 6 / finding F5**: "Dogs and
   cats only." → _"You choose which animal types you accept."_ The "How do I
   get an account?" item leaves the FAQ (replaced by the invite band); its
   OSS half moves to the footer.
6. **Invite band** — short section: invite-only today, **Ask for an invite**
   (`mailto:` with a subject line) + sign-in link. No signup flow is built or
   implied.
7. **Footer** — exactly **one** OSS line for the technical reader's exit:
   _"Pawbook is open source (MIT) — source & technical docs on GitHub"_,
   linking the repo and the project page (`docs/index.md` / its published
   URL). The "Runs on Cloudflare Workers" chip is deleted.

### Disposition of every current section

| Current                              | Disposition                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Ledger day-book card (hero)          | Retired; replaced by `widget-hero.webp`, same physical treatment + marginalia    |
| Brand / lede / sub                   | Rewritten sitter-benefit-first (copy above)                                      |
| CTA row (demo / sign in / self-host) | Demo + sign-in stay; self-host link → footer                                     |
| Deploy note                          | Rewritten as invite note with mailto CTA                                         |
| "What it does" cap-lead              | Its lives-on-your-site claim folds into hero sub + installs note                 |
| "What it does" book-groups           | Condensed into "What you control" beside the admin shot                          |
| Embed slip section                   | Shrunk to "How it installs" note, snippet still escaped                          |
| FAQ (6 items)                        | 5 kept/tightened; pet-types copy per animal-types F5; account item → invite band |
| Footer (5 chips)                     | One OSS sentence, GitHub + project-page links                                    |

### Keep (non-negotiable)

Script-free body under `LOCKED_CSP` (`<img>` same-origin only — no external
assets, no `data:`-bloat inlining), inline `<style>` only, `X-Frame-Options:
DENY`, `:focus-visible` outlines, `prefers-reduced-motion` guard, single `h1`
→ `h2` sections → `h3` items. **Alt text is informative, not decorative**:
e.g. hero _"The Pawbook booking widget: a June calendar with a three-night
boarding stay selected and a $150 quote"_; calendar crop _"Month grid where
full days are struck through and weekends are greyed out for a weekday-only
service"_. Marginalia and the stamp stay `aria-hidden`.

## Sequencing

Lands **after** animal-types Task 6 (the FAQ copy fix is part of that spec's
scope). This page absorbs the corrected sentence; if ordering flips, writing
the new copy here satisfies F5 early and Task 6's landing-page item becomes a
no-op — either order is safe, double-editing is not needed.

## Out of scope

- Hosted-signup flow changes (the mailto CTA is the whole "pricing" story).
- New server routes or CSP changes (assets pipeline already serves `/img/*`).
- Analytics of any kind.
- Widget or dashboard visual changes (screenshots capture what exists).
- Dark-mode imagery (the widget ships one light theme).

## Testing

- **`server/__tests__/landing.test.ts`** — existing assertions all survive
  (`href="/admin"`, "Pawbook", no `<script`, XFO DENY: none pin copy that
  moves). Add: `href="/demo"` present; snippet still escaped (`&lt;script`);
  a `mailto:` invite link exists; every `<img` has a non-empty `alt` and a
  `/img/landing/` src; and a Node `fs` check that each referenced file exists
  in `public/img/landing/` under its per-file budget with total ≤300KB — the
  weight budget as a failing test, not a convention.
- **Visual pass** (Playwright, manual): 360, 768, and 1280px widths — no
  horizontal scroll, photo treatment doesn't crop meaning on mobile, heading
  order verified in the a11y tree, contrast spot-checks on paper palette.
- **Capture fidelity:** shots regenerated via the recipe above from a fresh
  `seed:local`, confirming the recipe itself before it's trusted as the drift
  contract.
