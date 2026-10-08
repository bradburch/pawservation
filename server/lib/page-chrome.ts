import { BRAND_ORIGIN } from './email';

/**
 * Where "Stripe's published rate" points, beside every place a page states it. Stripe's own page,
 * because this product states no processing figure of its own: none is in code, and a number typed
 * here would go stale the day Stripe changed theirs.
 */
export const STRIPE_LINK = '(<a href="https://stripe.com/pricing">see Stripe&rsquo;s pricing</a>)';

/**
 * Where "Meta charges a small fee" points, beside every place a page says it. Meta's own page, for
 * STRIPE_LINK's reason: no per-message figure is typed here, because Meta's rate card changes and a
 * figure in copy would go stale without anyone noticing.
 */
export const META_PRICING_LINK =
  '(<a href="https://business.whatsapp.com/products/platform-pricing">see Meta&rsquo;s pricing</a>)';

/**
 * The shared page footer. Extracted when /about and /contact would have made it a SIXTH hand-kept
 * copy of the same markup — the four that existed had already drifted into two variants that
 * differed only in one link's label and one anchor's href, which is the drift a fifth and sixth
 * copy guarantees rather than risks. Every link here is absolute (`/#pricing`, not `#pricing`) so
 * one version serves every page: from the landing itself an absolute same-page hash still just
 * scrolls.
 */
export function pageFooter(): string {
  return `<footer class="foot">
      <div class="wrap">
        <div class="foot-grid">
          <div class="foot-brand">
            <a class="logo" href="/">
              <img src="/brand/calendar.svg" width="30" height="28" alt="" />
              Pawservation
            </a>
            <p>Booking software for pet sitters and dog walkers, on your website or at a link you send.</p>
          </div>
          <div>
            <h3>Product</h3>
            <ul>
              <li><a href="/demo">Try the demo</a></li>
              <li><a href="/admin">Sitter sign in</a></li>
              <li><a href="/how-it-works">Full tour</a></li>
              <li><a href="/getting-started">Setup guide</a></li>
              <li><a href="/getting-started/whatsapp">WhatsApp guide</a></li>
              <li><a href="/getting-started/card-payments">Card payments guide</a></li>
              <li><a href="/#pricing">Pricing</a></li>
            </ul>
          </div>
          <div>
            <h3>Company</h3>
            <ul>
              <li><a href="/about">About</a></li>
              <li><a href="/contact">Contact</a></li>
            </ul>
          </div>
          <div>
            <h3>Legal</h3>
            <ul>
              <li><a href="/privacy">Privacy</a></li>
              <li><a href="/terms">Terms</a></li>
            </ul>
          </div>
        </div>
        <div class="foot-bottom">
          <p>
            Created by <a href="https://bradburch.github.io/">Brad Burch</a>
          </p>
        </div>
      </div>
    </footer>`;
}

/**
 * The <head> tags every worker-served marketing page shares, so a page's own file carries only
 * what differs: its title and its one-sentence description.
 *
 * `rel="canonical"` is ABSOLUTE and pinned to BRAND_ORIGIN on purpose. This worker answers on
 * several hosts (the pawservation.com custom domain, workers.dev under `workers_dev: true`, and a
 * fresh preview URL per `wrangler versions upload`), and without a canonical a crawler indexes the
 * same page once per host and splits its ranking across the copies. Same reasoning as
 * `callbackUriFor`'s, arriving at the opposite answer: OAuth needs the host the request actually
 * came in on, search needs the one host the page should be found under.
 *
 * Title and description are the two strings a search result is BUILT from, so they carry the words
 * a sitter actually types ("pet sitting software", "dog walking") rather than the in-house framing
 * ("booking for pet-sitting businesses") the body copy used to carry alone. Both are literals here,
 * never interpolated from anything a tenant controls — these pages have no tenant.
 *
 * NOT emitted here: the homepage's JSON-LD, which is spliced into LANDING_HTML alone. It answers
 * "what is this product and who stands behind it", a question only the homepage is the answer to —
 * repeating an identity graph on /privacy would give a crawler four competing candidates for one
 * entity. It is an inert `application/ld+json` DATA block, which is why it survives LOCKED_CSP: the
 * type is not a script type, so it never executes and CSP never evaluates it — the same exemption
 * the embed page's LocalBusiness block already relies on. The marketing pages stay free of
 * EXECUTABLE script, which is what that rule was always protecting; `landing.test.ts` pins the
 * distinction rather than the substring.
 *
 * `og:image` is a PURPOSE-BUILT 1200x630 PNG (`public/img/og-card.png`), not a screenshot. The
 * branch that added these tags first pointed at `widget-hero.webp` — 932x1990, a portrait strip —
 * under `summary_large_image`, which crops to roughly 1.91:1 and would have unfurled every shared
 * link as an unreadable sliver of a calendar. The image and the card type move TOGETHER or not at
 * all, which a test pins: a large-image card with no image, or this image under a `summary` card,
 * are both wrong. PNG rather than WebP because not every unfurler accepts WebP, and the file is
 * never loaded by the page itself — only fetched by an unfurler — so it sits outside the landing
 * page's weight budget. Regenerate it with the recipe in `docs/og-card.md`.
 *
 * It is the card for THESE pages only. `/embed/:slug` carries its own (`embedCardTags`, above)
 * against `public/img/og-booking.png`, because a pet owner handed her sitter's booking link is not
 * a sitter being recruited, and this card's words are addressed to the sitter.
 */
export function pageHead(path: string, title: string, description: string): string {
  return `<title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${BRAND_ORIGIN}${path}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Pawservation" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${BRAND_ORIGIN}${path}" />
    <meta property="og:image" content="${BRAND_ORIGIN}/img/og-card.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Pawservation: pet sitting and dog walking software" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`;
}
