# In-app help and explainers — design

**Date:** 2026-07-19
**Status:** Shipped — copy amended, see below
**Branch:** `custom-services`

> **Amended 2026-07-20:** Five draft copy rows below describe pre-0015 wording that the shipped
> code (`2026-07-19-service-level-attributes-design.md` / migration 0015) deliberately abandoned.
> This is a spec-side correction only — the shipped hints are correct. Stale rows:
>
> - **Nav hint "Business" — "plus your daily limits."** Daily caps moved **per-service** in 0015;
>   Business no longer owns boarding-spots / house-sits / max-stay.
> - **Nav hint "Pet types" — "Clients can only book for types ticked here."** Clients tick
>   nothing; pet types are a sitter-managed registry and per-service acceptance
>   (`AcceptedPetTypes`).
> - **Control "Capacity = blank (daily caps)" — located "Business, beside 'Boarding spots per
>   day'."** Those caps now live per service under Services & rates.
> - **Control "Per-option capacity" — "How many pets this option can take at once."** Per-option
>   capacity counts **bookings/spots**, not pets (a 3-dog booking uses one spot); the shipped
>   hint says so.
> - **The "Getting started" prose** ("your daily limits (boarding spots, house-sits, your longest
>   stay)" under Business, and "Pet types sets which animals you accept") reflects the pre-0015
>   layout — those caps are per-service and pet types are a registry.

## Problem

The dashboard is built for non-technical solo pet sitters, but its concepts
are explained unevenly: some sections carry a one-line `.pb-applies` note,
some controls have an inline `.pb-hint`, and the genuinely non-obvious ideas
— blank capacity means unlimited, weekdays-only windows, recording payments
Pawbook never processes, script vs iframe embed codes, one-way Google
Calendar sync, the owner allowlist's claimed states — are documented in code
comments or nowhere at all. There is also no single friendly place that
answers "how do I actually run my business on this?".

Owner's directives, verbatim: "add docs and friendly help documents for this
site. information hover overs, etc. This can be deployed on its own, but
primarily it is set up on a saas plan." And: "add docs and explainers to the
dashboard as well to best describe how to use each component and what it
does. Make it concise but well informed."

So: two audiences, one primary. Sitters on the hosted plan get in-app hover
explainers and a Help section; the self-deploy/OSS story is one closing Help
topic that hands off to the GitHub README — not a parallel docs effort.

## Options considered

### Explainer mechanism

1. **Native `title` tooltips.** Zero code, but invisible on touch devices
   (most sitters are on phones), unstylable, and not keyboard-accessible.
   Rejected.
2. **`<details>/<summary>` disclosures.** Native and accessible, but
   `<details>` is block-flow content: it cannot sit inside an `<h2>` or an
   inline `.pb-inline` label row without breaking layout, it has no hover
   affordance, and its open state pushes surrounding content around instead
   of overlaying. Rejected for hints (it stays a fine idiom for long inline
   content like the wizard's "Customize").
3. **A tiny toggletip: button + popover (chosen).** A `?` button that shows
   a small overlay bubble on hover/focus and toggles it on click/tap. Works
   with mouse, keyboard, and touch; ~40 lines of component + ~30 lines of
   CSS; no dependency (the pure-core/no-deps posture extends culturally to
   the UI). The native `popover` attribute + CSS anchor positioning would
   shrink it further but anchor positioning isn't universally shipped;
   plain React state and absolute positioning are trivial and testable.

### Where the long-form help lives

A separate docs site (or server-routed help pages) was rejected as YAGNI:
it needs routing, another CSP surface, and a second deploy story, all to
serve six short topics. A static **Help** section inside the dashboard —
plain React content, no server routes, no new endpoints — ships in the
bundle the sitter already has open. If help ever outgrows the dashboard, a
public docs page is the future step (noted in Not built).

## Design

### 1. `<Hint>` — one reusable toggletip component

`app/admin/Hint.tsx` (admin-only; the embed widget is out of scope):

```tsx
<Hint label="Capacity">
  Blank means no limit. Set a number and Pawbook stops offering the day once it&rsquo;s full.
</Hint>
```

- **Markup:** `<span class="pb-hintwrap">` containing a
  `<button type="button" class="pb-hint-btn" aria-label={`About ${label}`}
aria-expanded={open} aria-controls={id}>?</button>` and, when open, a
  `<span role="note" id={id} class="pb-hint-pop">{children}</span>`. Two
  sibling elements, never nested interactives — same rule as the services
  redesign cards.
- **Interaction:** hover or keyboard focus opens a _transient_ preview
  (closes on mouseleave/blur); click or tap toggles a _pinned_ open state
  that survives mouseleave, and closes on a second activation, Escape
  (focus returns to the button), or a click anywhere outside. Tap and
  hover both work because touch taps arrive as click — no pointer-type
  sniffing needed.
- **Style (`admin.css`, pb- idiom):** the button is a 20px circle (24px
  min tap target via padding), `--soft` glyph on `--sage-wash`, sitting
  quietly after heading text or a field label; `:focus-visible` uses the
  existing global gold ring. The popover is a small white card — `--card`
  background, `--line` border, 10px radius, the section-card shadow at
  reduced spread — `max-width: min(260px, calc(100vw - 32px))`, positioned
  absolutely under the button and clamped so it never causes horizontal
  scroll at 360px width. `z-index` above `.pb-sidenav` (15) and below
  `.pb-savebar` (30). No animation beyond an opacity fade, disabled under
  `prefers-reduced-motion`.
- **Copy is children, not config** — plain JSX text, ≤2 sentences (rule 4
  below), so every hint is greppable and reviewable in place.

### 2. Placement inventory and draft copy

One `<Hint>` beside each section's `<h2>` text, plus hints on the specific
controls below. Existing `.pb-applies` and inline `.pb-hint` lines stay —
header hints must not repeat them; they carry the "what is this for and how
does it behave" layer the one-liners don't. The `(blank = no limit)` note
inside `NullableNumberField` stays as-is everywhere; the _concept_ gets a
hint only at the two places a sitter first meets it (Business daily caps,
Services option capacity) rather than on every numeric field.

Section headers — copy drafted here is the deliverable, verbatim:

| Section (sidebar order)                                                                                 | Draft hover copy                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar _(spec'd — 2026-07-19-admin-scheduling-calendar-design.md; this hint ships with that section)_ | Your month at a glance — confirmed bookings, requests waiting on you, and your time off. Tap any booking to open its full details under Bookings.                      |
| Bookings                                                                                                | Every request your clients send lands here — nothing is booked until you confirm it. Confirming or declining emails the client automatically.                          |
| Earnings                                                                                                | Built entirely from the payments you record on bookings. Record every payment and this page keeps itself accurate.                                                     |
| Business                                                                                                | The basics your booking page shows clients — your name, color, and contact details — plus your daily limits. Changes wait until you press Save.                        |
| Pet types                                                                                               | The kinds of pets you accept. Clients can only book for types ticked here.                                                                                             |
| Services & rates _(written against 2026-07-19-services-rates-redesign.md)_                              | Each card is one thing clients can book, with its price and rules at a glance. Tap a card to edit pricing, questions, and limits; use its switch to offer or pause it. |
| Time off                                                                                                | Days you don't want bookings. Blocked days disappear from clients' calendars immediately — no save needed.                                                             |
| Clients                                                                                                 | Only people on this list can book with you. Adding someone emails them an invite.                                                                                      |
| Connected apps                                                                                          | Link Pawbook to tools you already use. With Google Calendar connected, bookings appear on your own calendar automatically.                                             |
| Your website                                                                                            | Your booking page, ready to drop into your own site. Copy the code, paste it into your website builder, and clients book without leaving your site.                    |

If the Services & rates redesign has not merged when this lands, ship the
same copy minus the card-specific second sentence ("Tap a card…" becomes
"Edit each service's pricing, questions, and limits below; tick a service
to offer it.") — the first sentence is layout-independent.

Non-obvious controls:

| Control                       | Where                                                                                   | Draft hover copy                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capacity = blank (daily caps) | Business, beside "Boarding spots per day"                                               | Blank means no limit. Set a number and Pawbook stops offering new bookings once that day is full.                                                                                        |
| Per-option capacity           | Services & rates, option row (editor's "Pricing & options" group post-redesign)         | How many pets this option can take at once — a full slot stops being offered. Blank means no limit.                                                                                      |
| Weekdays only                 | Services & rates, beside the checkbox                                                   | Clients will only see this option on Mondays through Fridays. It appears once the option has a time window.                                                                              |
| Recording payments            | Bookings/Earnings, beside the PaymentsPanel "Record payment" form (`PaymentsPanel.tsx`) | Pawbook doesn't take payments — you collect money however you like (cash, Venmo, Zelle…). Record what you received here so Earnings stays right; deposits and partial payments are fine. |
| Embed snippets                | Your website, above the two `CopyableSnippet`s                                          | Both codes show the same booking page. Try the first; if your website builder refuses it, the second works everywhere.                                                                   |
| Allowlist states              | Owner console, beside the Status column header                                          | "Waiting to join" means they haven't signed up yet and can still be removed. Once they've joined, their business exists and can't be removed here.                                       |

Covered without a `<Hint>`, deliberately:

- **Calendar chips** — the calendar spec already puts a plain-words legend
  under the grid (Confirmed / Waiting for your reply / Time off). A hint
  on top of a legend is duplication; nothing to add.
- **SetupWizard** — the wizard already narrates every step in `.pb-hint`
  copy ("Tap everything you offer — you can fine-tune it all later",
  "Whole dollars…"). A modal that explains itself needs no hover layer.
- **Google Calendar ID field** — its existing `<small class="pb-hint">`
  walkthrough is already the right depth; leave it.
- **Owner console header** — the page already opens with its own
  one-line explanation ("Add a sitter's email — then tell them to go to
  the sign-in page and enter it."); only the Status column needs the hint
  above.

### 3. The Help section

A new sidebar entry, **last** in `SECTIONS`: key `help`, label "Help", a
new `IconHelp` (circled question mark, same 16px stroke style) added to
`app/shared-ui/icons`. Panel is `app/admin/sections/HelpSection.tsx` —
entirely static JSX: no props, no fetches, no server routes.
Six topics rendered as `h3` + paragraphs (no accordion: six short topics
fit one scroll, and open text stays findable with the browser's
find-in-page). Cross-references to other sections are real `#hash` links
(`#clients`, `#apps`) — the existing hash nav handles them.

Draft topic copy, verbatim (each ≤150 words):

**Getting set up.** When you first sign in, Quick setup walks you through
the basics: your business details, the pets you take, what you offer, and
your prices. You can re-run it anytime from Services & rates — it only
adds, never overwrites. Three sections finish the picture: Business holds
your contact details and daily limits (boarding spots, house-sits, your
longest stay), Pet types sets which animals you accept, and Services &
rates is where each service's pricing, questions, and booking limits live.
Nothing changes for clients until you save — a dark bar appears at the
bottom of the screen whenever you have unsaved changes.

**Taking bookings.** Only people on your client list can book, so start in
Clients: add each client's email (or import a spreadsheet) and they get an
invite. A client's request arrives under "Needs your reply" — nothing is
ever booked without you. Confirm and the client gets an email; decline and
they hear that too. Pawbook won't double-book you: once a day is full, or
you've blocked it as time off, clients simply can't pick it.

**Your calendar and Google Calendar.** The Calendar section shows your
month: confirmed bookings, requests waiting on you, and time off. Add days
off under Time off — blocked days vanish from clients' calendars
immediately. If you live in Google Calendar, connect it under Connected
apps: booking requests appear there, and cancelled ones are cleared away.
One thing to know: the sync is one-way. A dentist appointment on your
Google Calendar won't block bookings — enter it as time off if you need
the day held.

**Getting paid.** Pawbook doesn't process payments — no card fees, nobody
holding your money. You collect the way you already do: cash, Venmo,
Zelle, PayPal, check. Each booking shows an estimated cost from your
rates; when a client pays, open the booking's Payments and record it — the
full amount, a deposit, or a partial. Earnings does the rest:
month-by-month revenue, who still owes you, and your top clients, all
built from what you record.

**Your website.** Your booking page can live on your own website —
Squarespace, Wix, or anything else. Open Your website, copy the code, and
paste it where you want bookings to appear; the preview shows exactly what
clients will see. If your site builder refuses the first code, use the
second — same page, works everywhere. No website? Send clients the direct
link to your booking page instead.

**Running your own copy.** Most sitters use Pawbook as a hosted service —
sign in and it just works, with hosting and updates handled for you.
Pawbook is also open source (MIT), so if you're technical (or know someone
who is) you can run your own copy on Cloudflare Workers, with your own
database and domain. The README at github.com/bradburch/pawbook walks
through it.

The GitHub link is a plain external `<a>` with the existing `.pb-panel a`
link styling.

### 4. Public-facing surfaces

- **Landing page (`server/index.ts`):** no change. It was just rewritten
  and already answers the prospective-sitter questions in its FAQ; it is
  also script-free under `LOCKED_CSP`, so any interactive help there is
  off the table by construction. Nothing to add.
- **`docs/index.md`:** one line added under "Try it": `- In-app help: the
dashboard's Help section covers setup, bookings, getting paid, and
embedding.` Nothing else.
- **No separate docs site** — YAGNI now; revisit only if Help outgrows six
  topics (noted below).

### 5. Copy tone rules

House rules for every hint and topic, enforced in review:

1. Plain words, no product jargon: never "tenant", "widget", "sync
   reconciliation", "config" — say "your business", "your booking page",
   "your calendar".
2. No AI-slop patterns — the landing rewrite set the bar. Banned:
   "seamlessly", "effortlessly", "empower", "Let's dive in", stacked
   exclamation points, and rhetorical-question openers.
3. Sentence-case headings everywhere (matches every existing `h2`/`h3`).
4. Hovers: at most 2 sentences. Help topics: at most 150 words.
5. Voice matches the dashboard's existing best copy ("Needs your reply",
   "You're bookable!", "Both days are included"): direct address, present
   tense, states what happens rather than instructs abstractly.

### Interaction with in-flight specs on this branch

Two sibling specs redesign sections this one writes copy for. The copy
above is written against those designs on purpose: Services & rates
against the card grid, Calendar against the month-grid section. Landing
order is flexible — the Calendar header hint ships inside
`CalendarSection.tsx` whenever that section lands, and the Services header
copy has a pre-redesign fallback sentence spelled out above. Nothing here
blocks or is blocked by either spec.

## Not built (deliberate)

- Tooltips/help in the embed widget — its customer-facing copy already
  exists and serves a different audience.
- Video or interactive walkthroughs.
- i18n — all copy is English, inline in JSX, same as the rest of the app.
- A separate public docs site — future step only if in-app Help outgrows
  the dashboard.
- Hint→Help deep links ("learn more") — hints are self-contained by the
  2-sentence rule; add links only if a hint ever genuinely needs a longer
  story.
- Help search — six topics on one page; find-in-page covers it.

## Testing

No server changes at all — `npm run typecheck`, `npm run lint`,
`npm run format`, `npm test` (untouched), `npm run build` must stay green.
`Hint` has no pure logic to unit-test; verification is a manual Playwright
pass via the `running-pawbook` skill:

- Hover a `?` shows the popover; mouseleave hides it; click pins it open;
  outside click closes; Escape closes and returns focus to the button.
- Keyboard: tab reaches every hint button in order, focus shows the gold
  ring, focus opens the preview, `aria-expanded` reflects state.
- 360px viewport: no popover ever causes horizontal scroll; buttons stay
  tappable at ≥24px.
- Help section renders all six topics; `#clients`/`#apps` links switch
  sections; the GitHub link opens.
- Every inventory row above is present with its exact copy (a wording
  diff against this spec is the copy review).
