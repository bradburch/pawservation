# Regenerating the social card

`public/img/og-card.png` is the 1200×630 image every page declares as `og:image`. It is a
purpose-built card, **not a screenshot of the app** — the landing screenshots are portrait and a
`summary_large_image` card crops to roughly 1.91:1, which is what made an earlier attempt unfurl as
an unreadable sliver of a calendar.

It is never loaded by the site itself, only fetched by an unfurler (Slack, iMessage, X, LinkedIn,
Facebook), so it sits outside the landing page's per-image weight budget.

## Recipe

1. Save the card markup below as `public/_og-card.html` (in `public/`, so `/brand/*` and
   `/fonts/*` resolve).
2. `python3 -m http.server 8899 -d public`
3. Screenshot `http://localhost:8899/_og-card.html` at exactly **1200×630**, no device scaling, as
   PNG. Any headless browser will do.
4. Move the result to `public/img/og-card.png`, then `rm public/_og-card.html`.

Do **not** run the output through `sips` to "optimise" it — re-encoding a screenshot PNG inflated it
from 230 KB to 338 KB.

## Why the markup looks the way it does

- The wordmark is set live in Boogaloo rather than using `brand/pawservation-logo.png`: that PNG's
  wordmark is dark green, built for light backgrounds, and disappears entirely on this one.
- The paw is a watermark at 5% opacity. Anything stronger reads as random blobs at thumbnail size,
  which is the size that actually matters.
- If the headline changes, keep it under ~14 characters per line at 80px. A third line collides
  with the chips.

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @font-face {
        font-family: 'Boogaloo';
        src: url('/fonts/boogaloo.woff2') format('woff2');
        font-weight: 400;
      }
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      body {
        width: 1200px;
        height: 630px;
        overflow: hidden;
        font-family:
          ui-sans-serif,
          system-ui,
          -apple-system,
          'Segoe UI',
          Roboto,
          Helvetica,
          Arial,
          sans-serif;
        background: #142919;
        color: #fff;
      }
      .card {
        position: relative;
        width: 1200px;
        height: 630px;
        padding: 64px 80px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        background:
          radial-gradient(1000px 600px at 92% -18%, rgba(46, 100, 64, 0.55), transparent 60%),
          linear-gradient(152deg, #1d3826 0%, #142919 60%, #102115 100%);
      }
      .watermark {
        position: absolute;
        right: 56px;
        bottom: -40px;
        width: 400px;
        opacity: 0.05;
        filter: brightness(0) invert(1);
        transform: rotate(-12deg);
      }
      .brand {
        position: relative;
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .brand img {
        height: 58px;
        width: auto;
      }
      .brand span {
        font-family: 'Boogaloo', cursive;
        font-size: 52px;
        line-height: 1;
        color: #fff;
        letter-spacing: 0.5px;
        padding-top: 6px;
      }
      h1 {
        position: relative;
        font-size: 80px;
        line-height: 1.02;
        letter-spacing: -2.4px;
        font-weight: 800;
        max-width: 14ch;
      }
      h1 .amp {
        color: #8fd4a4;
      }
      .sub {
        position: relative;
        margin-top: 24px;
        font-size: 32px;
        line-height: 1.32;
        color: #c9d7cb;
        max-width: 30ch;
        font-weight: 400;
      }
      .foot {
        position: relative;
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .chip {
        font-size: 22px;
        font-weight: 600;
        color: #dce7de;
        border: 1.5px solid rgba(220, 231, 222, 0.3);
        border-radius: 999px;
        padding: 11px 22px;
      }
      .chip-free {
        background: #8fd4a4;
        border-color: #8fd4a4;
        color: #12291b;
      }
      .host {
        margin-left: auto;
        font-size: 26px;
        font-weight: 700;
        color: #8fd4a4;
        letter-spacing: 0.3px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <img class="watermark" src="/brand/paw.svg" alt="" />
      <div class="brand"><img src="/brand/calendar.svg" alt="" /><span>Pawservation</span></div>
      <div>
        <h1>Pet sitting <span class="amp">&amp;</span> dog walking software</h1>
        <p class="sub">
          Your booking page, on your own website &mdash; your services, your rates, your rules.
        </p>
      </div>
      <div class="foot">
        <span class="chip chip-free">Free for one sitter</span>
        <span class="chip">Boarding &middot; Walks &middot; Daycare &middot; Check-ins</span>
        <span class="host">pawservation.com</span>
      </div>
    </div>
  </body>
</html>
```
