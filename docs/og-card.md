# Regenerating the brand images

Three separate things live here, and they are separate because they have different audiences:

| File                        | Declared by                                                                                   | Audience                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `public/img/og-card.png`    | `pageHead` (`/`, `/how-it-works`, `/about`, `/contact`, `/privacy`, `/terms`) and `demo.html` | A prospective **sitter**, being recruited.                                              |
| `public/img/og-booking.png` | `embedCardTags` (`/embed/:slug`)                                                              | A **pet owner** who has been texted her own sitter's booking link.                      |
| The icon set                | `<link rel="icon">` / `apple-touch-icon` (three of the five files; see below)                 | Whoever is looking at a browser tab, a home screen, or an iMessage bubble with no card. |

Both cards are 1200x630 and both are declared under `summary_large_image`. The image and the card
type move together or not at all: a large-image card with no image unfurls as an empty box, and a
portrait image under one crops to roughly 1.91:1, which is what made an earlier attempt (a 932x1990
landing screenshot) unfurl as an unreadable sliver of a calendar. `server/__tests__/seo.test.ts`
reads both files' PNG header bytes and fails if the declared dimensions and the actual ones differ.

Neither card is ever loaded by the site itself, only fetched by an unfurler (Slack, iMessage, X,
LinkedIn, Facebook), so they sit outside the landing page's per-image weight budget.

## Why there are two cards

`og-card.png` sells the product: "Pet sitting & dog walking software", "Free for one sitter". Those
are the right words for a link to `pawservation.com` and the wrong words on the one link this
product gets shared most: a sitter texting a client her own booking page. That reader is not
choosing software. She is booking her dog in. So `/embed/:slug` gets `og-booking.png`, which is the
brand lockup, one owner-facing line, and nothing else, with the per-tenant text carried by the tags
instead (`og:title` is "Book with <her business>").

## Shared recipe for both cards

1. Save the card markup as `public/_og-card.html` (or `public/_og-booking.html`) — in `public/`, so
   `/brand/*` and `/fonts/*` resolve.
2. `python3 -m http.server 8899 -d public`
3. Screenshot `http://localhost:8899/_og-card.html` at exactly **1200x630**, no device scaling, as
   PNG. Any headless browser will do; on this machine:

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
     --window-size=1200,630 --virtual-time-budget=4000 \
     --screenshot=/tmp/card.png http://localhost:8899/_og-card.html
   ```

4. Move the result into `public/img/`, then delete the temp HTML file and stop the server.

Do **not** run the output through `sips` to "optimise" it — re-encoding a screenshot PNG inflated it
from 230 KB to 338 KB.

## Why the markup looks the way it does

- The wordmark is set live in Boogaloo rather than using `brand/pawservation-logo.png`: that PNG's
  wordmark is dark green, built for light backgrounds, and disappears entirely on these ones.
- The paw is a watermark at 5% opacity. Anything stronger reads as random blobs at thumbnail size,
  which is the size that actually matters.
- On the recruitment card, if the headline changes, keep it under ~14 characters per line at 80px.
  A third line collides with the chips.
- On the booking card there is deliberately no headline, no chips and no host line. Everything
  per-tenant is in the tags, and anything else would either be recruitment copy aimed at the wrong
  reader or a claim about services a given sitter may not offer.

### `public/img/og-card.png` — the recruitment card

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

### `public/img/og-booking.png` — the booking-page card

Same background treatment and same paw watermark as above, so the two read as one brand; the
lockup is centred and much larger, because it is the only thing on the card.

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
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 40px;
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
        gap: 28px;
      }
      .brand img {
        height: 132px;
        width: auto;
      }
      .brand span {
        font-family: 'Boogaloo', cursive;
        font-size: 116px;
        line-height: 1;
        color: #fff;
        letter-spacing: 1px;
        padding-top: 14px;
      }
      .line {
        position: relative;
        font-size: 38px;
        line-height: 1.3;
        font-weight: 500;
        color: #c9d7cb;
        letter-spacing: 0.2px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <img class="watermark" src="/brand/paw.svg" alt="" />
      <div class="brand"><img src="/brand/calendar.svg" alt="" /><span>Pawservation</span></div>
      <p class="line">Your sitter&rsquo;s booking page</p>
    </div>
  </body>
</html>
```

## The icon set

`public/favicon.svg`, `public/favicon.ico` (16/32/48/64), `public/apple-touch-icon.png` (180),
`public/icon-192.png` and `public/icon-512.png` are all the **same square**: the paw mark from
`public/brand/paw.svg`, alone, on a rounded-square plate.

Only three of the five are referenced by anything that serves a page. `favicon.ico`, `favicon.svg`
and `apple-touch-icon.png` are the `<link rel>` set emitted by `pageHead` (`server/index.ts`) and
by both invite-request pages (`server/routes/invite-request.ts`). `icon-512.png` is referenced once,
as the `Organization` graph's `logo` in `server/lib/llms.ts`. **`icon-192.png` is referenced
nowhere**: there is no web app manifest in this repo, which is the only thing that would ask for
it. It is regenerated by the recipe below for completeness of the set rather than because a page
wants it, so nothing breaks if it is dropped and nothing gains if it is kept.

### Why the mark and not the lockup

These were the calendar mark alone, then the full lockup, and are now the paw.

The lockup was chosen because these files are what a messaging app shows when a link has no card at
all, and a bare glyph names nothing. The cost was written down as accepted at the time — "a 3.1:1
lockup letterboxed into a square leaves the wordmark small, and at 16x16 it is a blur" — and the
sizes are what settled it. A square icon renders at roughly 16-60px almost everywhere it renders:
a browser tab is 16, a Safari favicon 16-32, a bookmark row ~20, an iMessage fallback bubble ~40.
At 40px the lockup's wordmark was a grey smudge and at 16px a blur, so five sixths of the plate's
width was being spent on a word nobody could read, and the mark that carried the recognition was
squeezed into the remaining sixth.

So the split is by size, and it is the point of the current arrangement:

| Surface                                     | Carries              | Because                                 |
| ------------------------------------------- | -------------------- | --------------------------------------- |
| The icon set (16-180px)                     | the paw mark         | a word is illegible at these sizes      |
| `og-card.png` / `og-booking.png` (1200x630) | the lockup           | there is room to read it                |
| The nav logo on every page                  | `brand/calendar.svg` | it sits beside live "Pawservation" text |

The cards keep the lockup, and nothing about them changed.

### How it is sized and placed

The plate is unchanged from the lockup icons: the same rounded square, `rx="96"` at 512, cream
`#F4EDDC` with an 8px dark-green `#1E4736` border, transparent corners. Cream rather than the
brand's dark green because the paw's own fill is terracotta `#C2703E` and wants a light ground; the
border is what keeps the silhouette from dissolving into the light backgrounds these icons actually
sit on (a Safari tab, an iMessage bubble). All three colours are read out of the brand SVGs by the
script rather than typed into it.

The paw is a single simple mark rather than a lockup, so it is sized far more generously than the
lockup was: its **content bounding box is two thirds of the plate width** (341 of 512 px, and 289px
tall — the mark is wider than it is tall). The bbox is measured, not assumed: render `paw.svg` at
2000px wide and take the alpha bounding box. For this file it comes out exactly equal to the
viewBox — the art is tight-cropped with no slack, unlike `pawservation-logo.svg`, whose viewBox had
visible margin and would have left the lockup off-centre if trusted.

Horizontally the mark is centred on that bbox. **Vertically it is centred on the ink centroid**, not
on the bbox: the paw is bottom-heavy (one large pad, four smaller toes with air between them), so
its centre of mass sits 1.59 user units — about 1% of its height — below the geometric centre.
Aligning the centroid with the plate's centre line lifts the mark about 3px at 512. It is a small
number and a visible one: measured-centred, the paw sits perceptibly low in the plate.

### Regenerating them

`rsvg-convert` (`brew install librsvg`) renders the SVG; nothing else is needed. There is no
ImageMagick on this machine, so the `.ico` is packed by hand — an ICO is a 6-byte header, one
16-byte directory entry per size, and the PNG payloads concatenated, which every current browser
accepts.

```python
# scratch script; run from the repo root
import re, struct, subprocess

SRC, LOGO = 'public/brand/paw.svg', 'public/brand/pawservation-logo.svg'
# The paw's content bbox in its own user units, measured by rendering paw.svg at 2000px wide and
# taking the alpha bounding box: it comes out EXACTLY the viewBox (0 0 175.71 148.68), i.e. the art
# is tight-cropped with no slack — unlike the lockup, whose viewBox had margin around it.
BX0, BY0, BX1, BY1 = 0.0, 0.0, 175.71, 148.68
# Ink centroid of the same render, in user units. The paw is bottom-heavy (the big pad), so its
# centre of mass sits 1.59 units BELOW the bbox centre; putting the centroid on the plate's centre
# line lifts the mark ~3px at 512 and is what makes it look centred rather than measure centred.
CX, CY = 87.28, 75.96
SIZE, RADIUS, STROKE, WIDTH_FRACTION = 512, 96, 8, 2 / 3

paw_src = open(SRC).read()
# Palette sampled from the brand files, never typed: the paw's own fill, and the cream/green of the
# calendar body in the lockup.
paw_fill = re.search(r'<svg[^>]*\bfill="(#[0-9A-Fa-f]{6})"', paw_src).group(1)
plate_fill, border = re.search(
    r'<rect[^>]*\bfill="(#[0-9A-Fa-f]{6})"\s+stroke="(#[0-9A-Fa-f]{6})"', open(LOGO).read()
).groups()

body = paw_src[paw_src.index('>', paw_src.index('<svg')) + 1 : paw_src.rindex('</svg>')]
scale = SIZE * WIDTH_FRACTION / (BX1 - BX0)
tx = SIZE / 2 - ((BX0 + BX1) / 2) * scale   # horizontally centred on the bbox
ty = SIZE / 2 - CY * scale                  # vertically centred on the ink centroid
h = STROKE / 2
plate = (f'<rect x="0" y="0" width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{plate_fill}"/>'
         f'<rect x="{h}" y="{h}" width="{SIZE-STROKE}" height="{SIZE-STROKE}" rx="{RADIUS-h}" '
         f'fill="none" stroke="{border}" stroke-width="{STROKE}"/>')
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" role="img" '
       f'aria-label="Pawservation">\n  {plate}\n'
       f'  <g transform="translate({tx:.4f} {ty:.4f}) scale({scale:.6f})" fill="{paw_fill}">'
       f'{body}</g>\n</svg>\n')
open('public/favicon.svg', 'w').write(svg)

for size, out in [(180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size),
                    'public/favicon.svg', '-o', f'public/{out}'], check=True)

sizes = [16, 32, 48, 64]
pngs = []
for s in sizes:
    subprocess.run(['rsvg-convert', '-w', str(s), '-h', str(s),
                    'public/favicon.svg', '-o', f'/tmp/ico-{s}.png'], check=True)
    pngs.append(open(f'/tmp/ico-{s}.png', 'rb').read())
off = 6 + 16 * len(sizes)
out = struct.pack('<HHH', 0, 1, len(sizes))
for s, p in zip(sizes, pngs):
    out += struct.pack('<BBBBHHII', s, s, 0, 0, 1, 32, len(p), off)
    off += len(p)
open('public/favicon.ico', 'wb').write(out + b''.join(pngs))
```

Verify by opening every generated file and looking at it. `file public/favicon.ico` should report
four icons; `sips -g pixelWidth -g pixelHeight` should report the size each filename claims. A file
that exists is not a file that is correct.

**And look at the small sizes, because they are the reason this changed.** Downscale
`public/icon-512.png` to 40px and to 16px, blow each back up with nearest-neighbour, and look at
those. At 40px the four toes and the pad must read as separate shapes; at 16px the paw must still
read as a paw rather than as three blobs. If it does not, the mark is too small in the plate — fix
the sizing, do not ship it.

Nothing else needs touching: `embed.html`, `admin.html`, `setup.html`, `demo.html`, the
worker-rendered pages and `server/lib/llms.ts` all reference these by path, and the paths and
dimensions do not change.
