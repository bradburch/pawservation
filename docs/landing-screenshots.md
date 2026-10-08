# Retaking the landing screenshots

The landing page (`/`) shows four screenshots of the real booking widget, and `/how-it-works`
reuses them. They live in `public/img/landing/`:

| File                 | What it shows                                                           | Size (px) | Budget |
| -------------------- | ----------------------------------------------------------------------- | --------- | ------ |
| `widget-hero.webp`   | The whole widget, top down to the calendar legend, with the stay chosen | 932 wide  | 90KB   |
| `step-services.webp` | The service cards (Boarding selected)                                   | 840 wide  | 40KB   |
| `step-calendar.webp` | The month grid, from its header to its last row, with the stay chosen   | 840 wide  | 40KB   |
| `step-request.webp`  | The Request Booking button and the quote beside it                      | 840 wide  | 40KB   |

The budgets, and a 210KB total, are `IMG_BUDGETS_KB` and `TOTAL_BUDGET_KB` in
`server/__tests__/landing.test.ts`, and they fail the build. Every shot is taken at 2x.

## The stay the shots show, and why it has to be inside the booking window

All four show one stay: **Boarding for Bella (signed in as Jess), Saturday 14 to Tuesday 17
November 2026, 3 nights, $150**. The page's copy names the same stay in five places, and
`landing.test.ts` ("the copy around the screenshots names the stay and month they show") pins them:
the hero image's alt, the request card over it, the WhatsApp phone example ("Sat 14th to Tue
17th", "$150 for 3 nights"), the step images' alts, and the dashboard mock (`mockdash-when`, and
its first row "Nov 14 – Nov 17 · 1 pet · $150").

The month must be inside the demo sitter's booking window. Sunny Paws has
`MaxAdvanceMonths = 12` (`sql/seed-demo.sql`), so the widget refuses any day more than 12 months
after the day you shoot: an older recipe used June and July 2028, which the widget no longer lets
anyone pick. The demo seed also dates every booking relative to the day it runs (+0 to +62 days),
so a month one or two ahead of today shows real days off, nearly full days and Jess's own
bookings. Pick **the next month, inside the window, whose 14th is a Saturday**, so the stay is
still Sat 14 to Tue 17. From 2026-10-08 that was November 2026; the next is August 2027.

When the month changes, change the five places above in the same commit (and the dates in this
file), then run `npx vitest run server/__tests__/landing.test.ts`.

## 1. Start the worker without live email

From the repo root, in its own terminal. Port 8790, so a worker already on 8787 is left alone:

```bash
npm install
npm run seed:local     # resets this checkout's local D1 to the demo; re-run on the day you shoot
npm run build
npx wrangler dev --port 8790 --ip 127.0.0.1 \
  --var ENVIRONMENT:development \
  --var RESEND_API_KEY: --var RESEND_FROM_NOREPLY: --var RESEND_FROM_BOOKING: \
  --var TOKEN_SECRET:$(openssl rand -hex 32)
```

Blank Resend vars mean no email can leave the machine, and `ENVIRONMENT:development` shows the
six-digit sign-in code on screen. Stop the worker (Ctrl-C) when you are done.

## 2. Take the shots

Any Playwright install works; it is not a dependency of this repo. In a scratch directory outside
the repo:

```bash
mkdir -p /tmp/landing-shots && cd /tmp/landing-shots
npm init -y >/dev/null && npm i --no-save playwright@1.63.0 && npx playwright install chromium
```

Save this as `capture.mjs` there. The second argument is how many months ahead of today the target
month is (1 for November 2026 when shot in October 2026):

```js
import { chromium } from 'playwright';

const [out = '.', monthsAhead = '1'] = process.argv.slice(2);
const b = await chromium.launch();
// 466 CSS px wide at 2x, light scheme: the widget as a phone-width iframe shows it.
const p = await b.newPage({
  viewport: { width: 466, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});

// Sign in as Jess; the dev worker prints the code on the page.
await p.goto('http://127.0.0.1:8790/embed/sunny-paws');
await p.getByLabel('Your email').fill('jess@example.com');
await p.getByRole('button', { name: 'Email me a code' }).click();
const codeLine = p.getByText(/Your code: \d{6}/);
await codeLine.waitFor();
const code = (await codeLine.innerText()).match(/\d{6}/)[0];
await p.locator('input[placeholder="······"]').fill(code);
await p.getByRole('button', { name: 'Verify' }).click();
await p.waitForTimeout(1500);

// Boarding, Bella (the default pet), the target month, then the 14th and the 17th.
await p.getByRole('button', { name: /^Boarding/ }).click();
for (let i = 0; i < Number(monthsAhead); i++) {
  await p.getByRole('button', { name: /next month/i }).click();
  await p.waitForTimeout(400);
}
await p.locator('button', { hasText: /^14/ }).first().click();
await p.waitForTimeout(400);
await p.locator('button', { hasText: /^17/ }).first().click();
await p.waitForTimeout(1500);

// Answer the two required questions so Request Booking is enabled.
await p.getByLabel(/Are vaccinations up to date/).selectOption({ label: 'Yes' });
await p.getByLabel(/Feeding routine/).fill('Two cups at 7am and 6pm');
await p.waitForTimeout(500);
await p.mouse.move(0, 0);

// Page coordinates (not viewport ones: filling a field scrolls the page).
const box = (loc) =>
  loc.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  });
const first = await box(p.getByRole('button', { name: /^Boarding/ }));
const last = await box(p.getByRole('button', { name: /^Morning walk/ }));
const prev = await box(p.getByRole('button', { name: /previous month/i }));
const legend = await box(p.getByText('Unavailable', { exact: true }));
const day30 = await box(p.locator('button', { hasText: /^30/ }));
const req = await box(p.getByRole('button', { name: 'Request Booking' }));

// The step crops span the content column, edge of the first card to edge of the last.
const x = first.x - 2;
const w = last.x + last.width + 2 - x;
const shot = (name, y0, y1, xx = x, ww = w) =>
  p.screenshot({
    path: `${out}/${name}.png`,
    fullPage: true,
    clip: { x: xx, y: y0, width: ww, height: y1 - y0 },
  });
await shot('widget-hero', 0, legend.y + legend.height + 12, 0, 466);
await shot('step-services', first.y - 2, last.y + last.height + 2);
await shot('step-calendar', prev.y - 4, day30.y + day30.height + 8);
await shot('step-request', req.y - 14, req.y + req.height + 14);
await b.close();
```

```bash
node capture.mjs . 1
```

Open the four PNGs and check them before encoding: the stay is 14 to 17, the quote reads
"3 nights · $150.00", and no shot is cut through a line of text. If the page has a day `30` twice
or a label changes, adjust the locator, not the crop numbers.

## 3. Encode to WebP within budget

`cwebp` (Homebrew `webp`) at quality 80, effort 6. The hero stays at its native 932px; the step
shots are scaled to 840px so the three match:

```bash
D=<repo>/public/img/landing
cwebp -quiet -q 80 -m 6 widget-hero.png -o "$D/widget-hero.webp"
for f in step-services step-calendar step-request; do
  cwebp -quiet -q 80 -m 6 -resize 840 0 "$f.png" -o "$D/$f.webp"
done
ls -l "$D"
```

The November 2026 set came out at 53.4KB, 9.8KB, 22.2KB and 5.1KB (90.6KB together). If a file
is over its budget, lower `-q` in steps of 5 for that file only, and look at it again: text edges
are what goes first.

## 4. Check

```bash
npx vitest run server/__tests__/landing.test.ts server/__tests__/how-it-works.test.ts
```

Then look at `/` and `/how-it-works` in both colour schemes at 375px and 1280px: the hero frame
shows only the top of `widget-hero.webp` (the services and the month header), and the step frames
crop to 224px tall, so the top of each step shot is what a visitor sees.
