---
name: marketing-pages
description: Doctrine for pawservation's worker-served marketing/SEO pages (/, /how-it-works, /about, /contact, /privacy, /terms, /request-invite) — canonical URLs, robots/llms.txt, JSON-LD, CSP script-free rule, og-cards. Use when touching these pages or their SEO/agent-discoverability surface.
---

# Marketing pages, SEO and agent-discoverability

Six worker-rendered marketing pages (`/`, `/how-it-works`, `/about`, `/contact`, `/privacy`,
`/terms`) plus the two `/request-invite` pages. All are rendered by `server/index.ts` (invite-request
by `server/routes/invite-request.ts`), served under `LOCKED_CSP` + `X-Frame-Options: DENY`, and
pinned by `server/__tests__/seo.test.ts` and `landing.test.ts`.

## The rules that bite from outside this file

These stay in the root `CLAUDE.md` because they catch you when you are doing something else:

- **`LOCKED_CSP` means script-free**: no executable `<script>` in the served body, inline styles only
  (shared `PAGE_STYLE` const). The displayed embed snippet is HTML-escaped as `&lt;script&gt;`.
  `application/ld+json` is the one exemption — it is not a script type, never executes, and CSP never
  evaluates it. The rule is therefore pinned as **no EXECUTABLE script**, not as the substring
  `<script`; `landing.test.ts` asserts the page's every script tag IS the data block.
- **Every worker-served page path must be listed explicitly in `wrangler.jsonc`'s
  `run_worker_first`** — globs don't match bare paths, and an unlisted path silently bypasses the
  worker and every header it sets.
- **`rel="canonical"` is pinned to `BRAND_ORIGIN`, never the request origin.**
- **No fabricated headcount, funding, founding date or street address anywhere.** Nothing unbuilt
  may be described as available either, with one standing exception the owner made on 2026-09-04:
  the Pro tier is presented as sold. No page may offer a checkout, a card form or a trial mechanic,
  because this repo contains no billing code.

## `pageHead` and the canonical

All six pages build their head through `pageHead(path, title, description)` in `server/index.ts`,
which emits an **absolute** `rel="canonical"` pinned to `BRAND_ORIGIN` (`server/lib/email.ts`,
exported for this — **one host constant, never two**) alongside the description and Open Graph tags.

Absolute-and-pinned because the worker answers on several hosts (the custom domain, `workers.dev`, a
fresh preview URL per `wrangler versions upload`). Without it a crawler indexes each page once per
host and splits its ranking across the copies. This is **the same multi-host fact `callbackUriFor`
faces, answered the other way round**: OAuth needs the host the request arrived on; search needs the
one host the page should be found under.

Title, description and hero/footer copy carry the phrases a sitter actually searches ("pet sitting
software", "dog walking") rather than the in-house framing alone.

## The sitemap is pinned twice over

`seo.test.ts` pins every `<loc>` in `public/sitemap.xml`:

1. to a route that really answers **200** — a sitemap entry for a path the worker does not serve
   teaches a crawler that the site 404s; and
2. to an entry in `wrangler.jsonc`'s **`run_worker_first`**, derived from the sitemap rather than
   restated, so a new public page cannot be added to one and forgotten in the other.

`"/"` itself was missing from that list and worked only because no asset happened to be emitted at
that name: a build that ever produced `dist/index.html` would have shadowed the landing page
silently, costing it CSP, `X-Frame-Options` and the `Accept: text/markdown` negotiation with no error
anywhere.

## `robots.txt` disallows NOTHING, deliberately

Every exclusion on this site is a **noindex the crawler must FETCH the resource to read**:

- `<meta name="robots" content="noindex">` for `admin.html` / `setup.html` and
  `/request-invite/thanks` (and the invite POST's 400 re-render — thin transactional pages a searcher
  can only dead-end on);
- an `X-Robots-Tag: noindex` response header (set in the header middleware for `/api/`) for JSON,
  which carries no meta tag.

A `Disallow` stops the fetch and so **defeats the tag it looks like it reinforces**.

Disallowing `/api/` costs more than that, and is the one rule here with a second reason:
`/embed/:slug` is a CLIENT-RENDERED widget whose `App.tsx` draws `Loading…` until
`GET /api/:slug/config` resolves — blocking that fetch would index every tenant's booking page as
that one word.

## Agent-readable surfaces answer a different question

`GET /llms.txt` (`buildProductLlmsTxt`, the root sibling of the per-tenant `/embed/:slug/llms.txt`)
describes the PRODUCT, with `## When to use this` / `## When NOT to use this` sections naming what
this is **not** — not a marketplace, not a payment processor, not a team scheduler — because a wrong
recommendation costs an agent's reader more than a missed one. Nothing unbuilt may be described as
available there, the rule `/how-it-works` is held to.

`GET /` serves that same document as `text/markdown` when the request asks for it
(acceptmarkdown.com), with **`Vary: Accept` on BOTH branches**. Set on only the markdown one, a cache
holding the HTML first keeps serving HTML to every agent asking for markdown, because the stored
response never said `Accept` mattered.

The markdown is llms.txt and **never a hand-maintained markdown twin** of the landing page: a second
copy of every claim is the drift this codebase exists to prevent, and a stale machine-readable copy
is trusted more than the HTML it contradicts.

`app.notFound` answers a markdown 404 pointing at `/llms.txt` and `/sitemap.xml` — **never echoing
the requested path**, which would let a crafted URL author markdown structure inside a document an
agent is about to act on — while `/api/` keeps the JSON `{ error }` shape every other error on that
prefix uses.

## JSON-LD: one graph, on the homepage alone

`buildProductJsonLdScript` emits `SoftwareApplication` + `Organization` in one `@graph`, **on the
homepage only** — repeating it on `/privacy` would hand a crawler four competing candidates for one
entity.

- Its `offers` is an **ARRAY carrying both tiers**, priced per month in USD. A graph publishing one
  price while the page prints two is a machine-readable claim nothing reads the surrounding copy
  for.
- The `Organization` graph's `PostalAddress` is a **locality only** — city/region/country restate the
  jurisdiction `/terms` already declares publicly, while a `streetAddress` would be invented.
  Inventing a `PostalAddress` to satisfy a validator is the fabrication structured data exists to
  prevent.
- `icon-512.png` is that graph's `logo` and is referenced nowhere else.

`/embed/:slug` carries its own `LocalBusiness` block (`server/lib/llms.ts`) for the same
render-free-read reason.

## Prices live in one constant

`server/lib/plan-pricing.ts` holds `soloMonthly` (15), `proMonthly` (29), `proAnnual` (290) and
`trialDays` (30). Solo is $15 per sitter per month with a 30-day free trial; Pro is $29 per sitter
per month, or $290 per year. Every figure on the landing page (hero chip, pricing heading, both
cards), on `/how-it-works`, on `/about`, in the product `llms.txt` Status section and in the
homepage `SoftwareApplication` offers is interpolated from it. Never hardcode one at a call site:
five surfaces state these numbers, and any two of them disagreeing is a pricing lie. The sixth
surface cannot interpolate anything: `public/img/og-card.png` bakes the price into the image, so a
change to `soloMonthly` means regenerating that card by the recipe in `docs/og-card.md`.

The invite form is the only call to action either card carries. There is no billing code in this
repo, so the copy says a trial exists and says nothing about how it is entered or ended, and it
claims nothing about whether a card is required.

## `/about` and `/contact` are the trust-anchor pages

They are what an agent reads to decide a business is real, so **every claim on them is behavior this
codebase enforces or a status the landing page already states** — nothing about headcount, funding,
or founding date, since none of it is knowable from this repo and a fabricated detail on the
legitimacy page is worse than an absent one.

That rule governs claims **about the software**. `/about` also carries claims **about its owner** —
his prior career as a software engineer, his own pet-sitting business at bradpaws.com, a photo of
him — and those are a different kind of claim by nature, not an exception carved out of the rule
above: they are first-hand facts he supplied about himself, not something derived from what this
codebase does, so "is this behavior the codebase enforces" is the wrong question to ask of them. They
are the page's credibility rather than a violation of it — the photo and the link to a real, running
business are load-bearing *because* a reader can check them, which is exactly what a stock photo and
an unlinked claim could not offer. That said, the fabrication ban still applies to this material, and
bites hardest here precisely because it reads as personal and is therefore the easiest place to
"round up": no invented founding year, client count, headcount, employer or education, no invented
street address. The test is unchanged from the rule above — whether the owner stated it, not whether
it sounds plausible — it just now has a second kind of claim to apply to.

The founder story leading `/about` is also why the page's voice splits from the rest of the site:
`/about` speaks in the first person ("I built this…") while the landing page and `/how-it-works` keep
the second-person product voice ("your clients", "you confirm it"). That split was a deliberate,
explicit choice by the owner on 2026-09-09, not an inconsistency to "harmonise" in a later pass —
leave it. `public/img/brad.jpg` is a content image inside the page body, not a link-preview asset: it
is unrelated to the two og-cards this skill tabulates below and is not produced by the og-card
recipe in `docs/og-card.md`.

The published contact address is **`SUPPORT_EMAIL` in `server/lib/email.ts`**, declared beside
`BRAND_ORIGIN` because it is the same class of thing: a public constant several modules state (the
`/contact` page, the homepage `Organization` graph, the invite-request thanks page's fallback) and
must not state differently. It is a **role address, not a person's** — printed on a public page and
in machine-readable structured data, so it must survive whoever answers it. Deliberately distinct
from `OWNER_EMAILS`, the owner-console AUTH allowlist; the two were briefly conflated and they answer
different questions: who may sign in, versus where the public writes. The thanks page still prefers
`OWNER_EMAILS[0]` when set, so a fork is never handed an address it does not own.

`pageFooter()` is the shared footer, extracted when `/about` and `/contact` would have made it a
sixth hand-kept copy — the four that existed had already drifted into two variants differing in one
link's label and one anchor's href.

## The em-dash budget

`seo.test.ts`'s em-dash budget matches the **raw U+2014 character and both numeric entity forms**
alongside `&mdash;`, and runs over the invite-request pages as well as the six `pageHead` ones.
Matching the named entity alone was blind to 36 raw dashes — 24 of them served verbatim out of
`PAGE_STYLE`'s own CSS comments, and two inside a `<title>` a visitor reads in her browser tab.

## Link-preview cards

Two purpose-built 1200x630 PNGs, **split by AUDIENCE, and that split is the point**:

| File                        | Declared by                              | Reader                                    |
| --------------------------- | ---------------------------------------- | ----------------------------------------- |
| `public/img/og-card.png`    | `pageHead` (all six pages) + `demo.html` | a prospective **sitter**, being recruited |
| `public/img/og-booking.png` | `embedCardTags` on `/embed/:slug`        | a **pet owner** texted her sitter's link  |

The most-shared link this product has is a sitter texting a client her own booking page, and that
reader is booking her dog in, not choosing software. **The image and the card type move together or
not at all**, pinned by a test that reads the PNGs' own header bytes.

`embedCardTags` (on `/embed/:slug`): `og:title` is `Book with <DisplayName>` through the same
`htmlEscape` the title uses, since a tenant-controlled string is landing in an attribute value;
`og:description` is a **LITERAL generic over every tenant**, because naming boarding to a dog
walker's clients would advertise a service she does not sell; `og:url` is pinned to `BRAND_ORIGIN`
for the canonical's reason, so a link forwarded from the `workers.dev` copy unfurls as the same
object as one from the custom domain. The same splice that injects the JSON-LD retitles the built
page from the generic `Book with us` to the tenant's own name (`htmlEscape`d, replacer-function form,
anchored on the exact built title so a Vite change degrades to the generic one rather than corrupting
the head). The `rel="canonical"` there is pinned to `BRAND_ORIGIN` while **the JSON-LD beside it
deliberately keeps the REQUEST origin** — they answer different questions (which copy to index vs. a
live address an agent will call, the same reason `llms.txt` publishes request-origin endpoints).

**Regeneration recipes for both cards and for the icon set, plus the icon geometry and the
mark-vs-lockup argument, live in `docs/og-card.md`.**
