import { htmlEscape, SUPPORT_EMAIL } from './email';
import { META_PRICING_LINK, pageFooter, pageHead, STRIPE_LINK } from './page-chrome';
import { PAGE_STYLE } from './page-style';
import { PRICE_LINE, TRIAL_LINE } from './plan-pricing';

/**
 * The sitter's setup guides: /getting-started (the hub, which is also the booking-link guide),
 * /getting-started/whatsapp and /getting-started/card-payments. Written to her, in the order she
 * meets each step, as numbered one-sentence steps. Linked from the landing page, the tour, the
 * shared footer and the product llms.txt; listed in the sitemap and run_worker_first. Same
 * constraints as every marketing page: LOCKED_CSP, script-free, PAGE_STYLE only, and the /contact
 * skeleton (a bare .nav-right, .legal prose, one h2 per .feature) so they add no CSS of their own.
 *
 * Every label in quotes is the label the dashboard prints (app/admin/**), and the Pro steps use the
 * labels the paid surfaces print. Two rules shape the Pro guides: this repo may not name a path on
 * the paid origin, so a guide says which part of her dashboard to open and never a URL; and the
 * copy describes the flow as it ships, without a hedge. setup-guides.test.ts pins the labels a
 * sitter will look for and the bans; the paid surfaces' labels live in another worker, so those are
 * checked by hand before a merge.
 *
 * Quoted labels are trimmed to their dash-free part where the UI string carries an em dash, because
 * seo.test.ts's em-dash budget covers these pages; the one exception it allows is the calendar name.
 */

interface GuideHead {
  path: string;
  title: string;
  description: string;
  chip: string;
  h1: string;
  sub: string;
}

/** The shell all three pages share: head, bare nav, hero, then the caller's sections, footer. */
function guidePage(head: GuideHead, sections: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(head.path, head.title, head.description)}
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <img src="/brand/calendar.svg" width="30" height="28" alt="" />
          Pawservation
        </a>
        <div class="nav-right">
          <a class="signin" href="/admin">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/signup">Sign up</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap">
          <p class="chip">${head.chip}</p>
          <h1>${head.h1}</h1>
          <p class="sub">${head.sub}</p>
        </div>
      </section>
${sections}
    </main>

    ${pageFooter()}
  </body>
</html>
`;
}

const SUPPORT_LINK = `<a href="mailto:${htmlEscape(SUPPORT_EMAIL)}?subject=Pawservation%20support">${htmlEscape(SUPPORT_EMAIL)}</a>`;

export const GETTING_STARTED_HTML = guidePage(
  {
    path: '/getting-started',
    title: 'Setup guides | Pawservation pet sitting &amp; dog walking software',
    description:
      'Step-by-step setup guides for pet sitters and dog walkers on Pawservation: your booking link, booking by WhatsApp, and card payments.',
    chip: 'Setup guides',
    h1: 'Get set up, one step at a time',
    sub: 'Start with your booking link. It takes about 15 minutes, and clients can book as soon as it&rsquo;s done. Add WhatsApp and card payments on Pro whenever you&rsquo;re ready.',
  },
  `
      <section class="section">
        <div class="wrap">
          <div class="features features-3">
            <a class="feature guide-card" href="#sign-up">
              <h2>Your booking link</h2>
              <p>About 15 minutes. Solo and Pro.</p>
            </a>
            <a class="feature guide-card" href="/getting-started/whatsapp">
              <h2>Booking by WhatsApp</h2>
              <p>About 30 minutes, then a wait for Meta&rsquo;s review. Pro.</p>
            </a>
            <a class="feature guide-card" href="/getting-started/card-payments">
              <h2>Card payments</h2>
              <p>About 15 minutes, then Stripe&rsquo;s checks. Pro.</p>
            </a>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h2>In this guide</h2>
            <ol>
              <li><a href="#sign-up">Sign up and sign in</a></li>
              <li><a href="#business">Quick setup and your business details</a></li>
              <li><a href="#services">Services and prices</a></li>
              <li><a href="#availability">Time off</a></li>
              <li><a href="#cancellations">Your cancellation policy</a></li>
              <li><a href="#calendar">Google Calendar (optional)</a></li>
              <li><a href="#clients">Add your clients</a></li>
              <li><a href="#booking-page">Share your booking link</a></li>
              <li><a href="#plan">Choose your plan</a></li>
              <li><a href="#your-clients">What your clients see</a></li>
              <li><a href="#questions">Questions and fixes</a></li>
            </ol>
          </div>

          <div class="feature" id="sign-up">
            <h2>1. Sign up and sign in</h2>
            <ol>
              <li>Enter your email on the <a href="/signup">sign-up page</a>, and open the link we email you within 30 minutes.</li>
              <li>On &ldquo;Set up your business&rdquo;, type your business name the way clients should see it, because it also becomes part of your booking link.</li>
              <li>Choose a password and press &ldquo;Finish setup&rdquo;. You land in your dashboard, signed in.</li>
            </ol>
            <p>Next time, sign in at <a href="/admin">the sign-in page</a>. &ldquo;Forgot password?&rdquo; there emails you a reset link. No sign-up email? Check your spam folder, or ask for a new link after a few minutes.</p>
          </div>

          <div class="feature" id="business">
            <h2>2. Quick setup and your business details</h2>
            <p>The first time you sign in, &ldquo;Quick setup&rdquo; opens by itself with four steps: &ldquo;About Your Business&rdquo;, &ldquo;What Services Do You Offer?&rdquo;, &ldquo;Set Your Prices&rdquo; and &ldquo;Connect Your Calendar&rdquo;. Each has &ldquo;Skip for now&rdquo;, and everything can be changed later.</p>
            <ol>
              <li>Open <strong>Settings &rarr; Business</strong> to change your business name, brand color, contact email and phone, and time zone.</li>
              <li>Press &ldquo;Save changes&rdquo;.</li>
            </ol>
          </div>

          <div class="feature" id="services">
            <h2>3. Services and prices</h2>
            <ol>
              <li>In &ldquo;Quick setup&rdquo;, tap the presets that describe you and type a price for each.</li>
              <li>To add one later, open <strong>Settings &rarr; Services &amp; Rates</strong> and press &ldquo;+ Add a service&rdquo;. You can offer up to six.</li>
              <li>Open a service to set its notice, limits, holiday rate, the questions clients answer, and which pets it takes.</li>
            </ol>
            <p><strong>More than one pet.</strong> Under &ldquo;Multi-pet pricing&rdquo; a new service starts at your rate times the number of pets. Add a price for a combination, such as two dogs for $60, or choose &ldquo;only the combinations I price below&rdquo; so only the combinations you&rsquo;ve priced can be booked together. A price you haven&rsquo;t set is never guessed.</p>
          </div>

          <div class="feature" id="availability">
            <h2>4. Time off</h2>
            <ol>
              <li>Open <strong>Settings &rarr; Time off</strong>.</li>
              <li>Pick your first and last day off, and press &ldquo;Block these days&rdquo;. For one day, pick the same date twice.</li>
            </ol>
            <p>Those days close on every service at once. Bookings you&rsquo;ve already confirmed stay as they are. How far ahead clients can book is in <strong>Settings &rarr; Business</strong>.</p>
          </div>

          <div class="feature" id="cancellations">
            <h2>5. Your cancellation policy</h2>
            <ol>
              <li>Open a service and scroll to &ldquo;Cancellation policy&rdquo;.</li>
              <li>Press &ldquo;Add tier&rdquo; and fill in how many days before the start, and what percent of the cost.</li>
            </ol>
            <p>Leave it empty and there&rsquo;s no cancellation fee. When a client cancels, the fee comes from your policy and you get an email saying what&rsquo;s owed.</p>
          </div>

          <div class="feature" id="calendar">
            <h2>6. Google Calendar (optional)</h2>
            <ol>
              <li>Open <strong>Settings &rarr; Connected apps</strong> and press &ldquo;Connect Google Calendar&rdquo;.</li>
              <li>Press &ldquo;Create a pet calendar&rdquo; so bookings get a calendar of their own, named &ldquo;Pawservation &mdash; Pet bookings&rdquo;.</li>
            </ol>
            <p>Anything on the connected calendar blocks those dates for new requests, which is why the pet calendar matters. Skip this and everything else works the same.</p>
          </div>

          <div class="feature" id="clients">
            <h2>7. Add your clients</h2>
            <p>Only clients you add can book.</p>
            <ol>
              <li>Open <strong>Clients</strong>, fill in the client&rsquo;s email, name and phone, and their first pet&rsquo;s name and type.</li>
              <li>Press &ldquo;Add account&rdquo;. Nothing is sent yet.</li>
              <li>When you&rsquo;re ready, open their row and press &ldquo;Send welcome email&rdquo;.</li>
            </ol>
            <p>Have a list? Use the CSV import on the same page: &ldquo;Download example CSV&rdquo; shows the columns.</p>
          </div>

          <div class="feature" id="booking-page">
            <h2>8. Share your booking link</h2>
            <ol>
              <li>Open <strong>Settings &rarr; Your website</strong>.</li>
              <li>No website? Press &ldquo;Copy the link&rdquo; and text or email it to clients.</li>
              <li>Have a website? Press &ldquo;Copy the code&rdquo; and paste it into a code block. On Wix, use the second code with &ldquo;Embed a site&rdquo;.</li>
            </ol>
            <p>The page is safe in public, because only clients you&rsquo;ve added can book. A new visitor sees a welcome under your name, a sign-in box, and a note asking them to get in touch with you so you can add them. Anyone with the address can read your services and rates.</p>
          </div>

          <div class="feature" id="plan">
            <h2>9. Choose your plan</h2>
            <p>${PRICE_LINE} ${TRIAL_LINE}</p>
            <ol>
              <li>Open <strong>Settings &rarr; Business</strong> and scroll to &ldquo;Your plan&rdquo;.</li>
              <li>Press &ldquo;Subscribe&rdquo; beside Solo, Pro or Pro, yearly. Stripe asks for your card on its own page.</li>
            </ol>
            <p>Once you have a plan, &ldquo;Manage plan&rdquo; is where you change your card or cancel, and &ldquo;Sync with Stripe&rdquo; puts things right if your plan ever looks wrong.</p>
            <p>On Pro, set up <a href="/getting-started/whatsapp">booking by WhatsApp</a> and <a href="/getting-started/card-payments">card payments</a> with their own guides.</p>
          </div>

          <div class="feature" id="your-clients">
            <h2>10. What your clients see</h2>
            <ul>
              <li>They open your booking link, enter the email you have for them, and type the six-digit code we email them.</li>
              <li>They pick a service, dates or a visit time, and their pets, see the price, and press &ldquo;Request Booking&rdquo;.</li>
              <li>Under &ldquo;My bookings&rdquo; each request shows &ldquo;Awaiting confirmation&rdquo; until you press Confirm or Decline, and they&rsquo;re emailed your answer. They can change or cancel their own bookings there.</li>
            </ul>
          </div>

          <div class="feature" id="questions">
            <h2>11. Questions and fixes</h2>
            <p><strong>A client can&rsquo;t book.</strong> Check they&rsquo;re in Clients with the email they&rsquo;re typing.</p>
            <p><strong>A client sees no price for their pets.</strong> That service only takes combinations you&rsquo;ve priced. Add a rate under &ldquo;Multi-pet pricing&rdquo;, or switch it to your rate times the number of pets.</p>
            <p><strong>A day shows as unavailable.</strong> Look for time off, a full day, an event on your Google Calendar, or a service that needs more notice.</p>
            <p><strong>My dashboard is read-only.</strong> Your plan has lapsed. Choose one under &ldquo;Your plan&rdquo;; your bookings, clients and pets are untouched.</p>
            <p><strong>Anything else.</strong> Email ${SUPPORT_LINK} and say which business you run. A person reads it.</p>
            <p>Want the bigger picture? Read the <a href="/how-it-works">full tour</a>, or try the <a href="/demo">demo</a>: two made-up sitters&rsquo; booking pages, with nothing to sign up for and nothing you can break.</p>
          </div>
        </div>
      </section>`,
);

export const WHATSAPP_GUIDE_HTML = guidePage(
  {
    path: '/getting-started/whatsapp',
    title: 'Booking by WhatsApp: setup guide | Pawservation',
    description:
      'How to let clients book you on WhatsApp with Pawservation Pro: which phone number to use, what Meta asks for, what it costs, and each step.',
    chip: 'Setup guide &middot; Pro',
    h1: 'Let clients book you on WhatsApp',
    sub: 'Clients message your business number, a friendly assistant answers with your dates and prices, and every new request comes to your own WhatsApp to Confirm or Decline.',
  },
  `
      <section class="section">
        <div class="wrap legal">
          <div class="feature" id="at-a-glance">
            <h2>At a glance</h2>
            <p><strong>Time:</strong> about 30 minutes, then a wait while Meta reviews your messages, usually within a day.</p>
            <p><strong>Plan:</strong> Pro. If you&rsquo;re in your trial, choose Pro under <strong>Settings &rarr; Business</strong>, &ldquo;Your plan&rdquo;. It switches on right away, and you&rsquo;re first charged when the trial ends.</p>
            <p><strong>You&rsquo;ll need:</strong></p>
            <ul>
              <li>a phone number for your business (see &ldquo;Which number?&rdquo; below);</li>
              <li>WhatsApp on your own phone, on a different US number, for your booking alerts;</li>
              <li>a Facebook login;</li>
              <li>a debit or credit card for Meta, which bills you for some messages;</li>
              <li>a computer, with your dashboard open.</li>
            </ul>
          </div>

          <div class="feature" id="which-number">
            <h2>Which number?</h2>
            <div class="features features-2">
              <div class="feature">
                <h3>A new number just for bookings (recommended).</h3>
                <p>This works for everyone. Get a second line or an eSIM from your phone company, or a low-cost prepaid plan. The number only has to receive one text or phone call during setup. After that it lives with WhatsApp&rsquo;s business service rather than in an app on your phone: the assistant answers there, and your alerts come to your own WhatsApp. Keep the line paid up so the number stays yours. Internet-only numbers, such as Google Voice, are often refused, so use a mobile line.</p>
              </div>
              <div class="feature">
                <h3>The number your clients already message.</h3>
                <p>If you already run your pet business on the WhatsApp Business app, you can try to keep that number: choose &ldquo;Keep the number my clients already text&rdquo;. You keep chatting with clients in the app as before, and the assistant answers there too. Update the app first, and open it at least every two weeks afterwards or WhatsApp disconnects it. If Meta&rsquo;s window says your number can&rsquo;t be connected this way, choose &ldquo;Use a new number&rdquo; instead.</p>
              </div>
            </div>
            <p>Either way, your personal WhatsApp stays as it is and becomes the number your alerts go to.</p>
          </div>

          <div class="feature" id="connect">
            <h2>Part 1: Connect your number</h2>
            <p>About 15 minutes.</p>
            <ol>
              <li>In your dashboard, open <strong>Settings &rarr; Services &amp; Rates</strong> and scroll to the bottom, to the section headed &ldquo;WhatsApp&rdquo;.</li>
              <li>Press &ldquo;Connect WhatsApp&rdquo;. A new window opens.</li>
              <li>Choose &ldquo;Use a new number&rdquo; or &ldquo;Keep the number my clients already text&rdquo;.</li>
              <li>Sign in with Facebook when Meta asks. If you don&rsquo;t have a business account with Meta yet, the window makes one for you.</li>
              <li>Type your business name as clients know it, then your business number.</li>
              <li>Type the code Meta sends to that number. If no text arrives, choose a phone call instead.</li>
              <li>If Meta asks you to choose a six-digit PIN, write it down somewhere safe. You&rsquo;ll need it if you ever move the number.</li>
              <li>When the window says &ldquo;Connected&rdquo;, close it and go back to your dashboard.</li>
            </ol>
            <p><strong>What you&rsquo;ll see:</strong> a Facebook sign-in, then a few of Meta&rsquo;s own screens with your business name and number. Back in your dashboard, the WhatsApp section says Meta is reviewing your messages.</p>
          </div>

          <div class="feature" id="while-you-wait">
            <h2>Part 2: While Meta reviews</h2>
            <p>About 10 minutes.</p>
            <ol>
              <li>If the WhatsApp section asks for a payment method, add a card in Meta&rsquo;s WhatsApp Manager, under its billing settings.</li>
              <li>Open <strong>Settings &rarr; Business &rarr; Access tokens</strong> in a second tab, type &ldquo;WhatsApp&rdquo; as the name, and press &ldquo;Create token&rdquo;.</li>
              <li>Press &ldquo;Copy&rdquo;. The token is shown only once.</li>
              <li>Back in the WhatsApp section, paste it into &ldquo;Access token for booking by message&rdquo; and press &ldquo;Save token&rdquo;.</li>
            </ol>
            <p>Why a token? It lets booking by WhatsApp check your calendar and record requests when you&rsquo;re not signed in. Make a separate token for card payments, so turning one off never stops the other.</p>
          </div>

          <div class="feature" id="switch-on">
            <h2>Part 3: Switch it on</h2>
            <p>About 5 minutes, after Meta approves.</p>
            <ol>
              <li>Type your own WhatsApp number in &ldquo;Admin number&rdquo; and press &ldquo;Send code&rdquo;.</li>
              <li>Type the six-digit code WhatsApp sends you and press &ldquo;Prove&rdquo;.</li>
              <li>Press &ldquo;Switch booking by message on&rdquo;, read the sentence it shows, and press &ldquo;Accept and switch on&rdquo;.</li>
            </ol>
          </div>

          <div class="feature" id="done">
            <h2>Done, and sharing it</h2>
            <p><strong>You&rsquo;re done when</strong> the WhatsApp section says &ldquo;Ready&rdquo;. To try it out:</p>
            <ol>
              <li>Add a friend as a client in <strong>Clients</strong>, with their mobile number.</li>
              <li>The first time they message your business number, they&rsquo;re emailed a code to reply with.</li>
              <li>After that, have them ask &ldquo;Are you free next Saturday?&rdquo; and watch the answer arrive.</li>
            </ol>
            <p><strong>Share it.</strong> The section shows your WhatsApp link and a QR code. Add a short greeting, put the link in your Instagram bio or on your website, and print the QR code for flyers.</p>
          </div>

          <div class="feature" id="costs">
            <h2>What it costs</h2>
            <p>Replies to your clients&rsquo; messages are free. Meta charges a small fee for some messages your number sends first, such as your booking alerts, and bills your card directly ${META_PRICING_LINK}. Pawservation adds nothing on top of Pro.</p>
          </div>

          <div class="feature" id="problems">
            <h2>If something goes wrong</h2>
            <p><strong>Meta says the number is already on WhatsApp.</strong> If it&rsquo;s on the WhatsApp Business app, choose &ldquo;Keep the number my clients already text&rdquo;. Otherwise use a different number.</p>
            <p><strong>The code never arrives.</strong> Choose the phone-call option. Landlines and some numbers only get the call.</p>
            <p><strong>Meta won&rsquo;t accept the number.</strong> It&rsquo;s probably an internet-only number. Use a mobile line.</p>
            <p><strong>Alerts aren&rsquo;t arriving.</strong> Check the WhatsApp section: alerts start after Meta approves your messages and you&rsquo;ve proven your admin number.</p>
            <p><strong>It says the access token stopped working.</strong> Create a new token named &ldquo;WhatsApp&rdquo; and paste it in again.</p>
            <p><strong>Still stuck?</strong> Email ${SUPPORT_LINK} with your business name. A person reads it.</p>
            <p><strong>Turning it off.</strong> &ldquo;Switch booking by message off&rdquo; stops it straight away, and clients who message are pointed to your booking page. &ldquo;Disconnect WhatsApp&rdquo; removes Pawservation&rsquo;s access to your number. Your booking page keeps working either way. The assistant has a daily allowance, and when it runs out clients are pointed to your booking page, which always works.</p>
            <p>Next: <a href="/getting-started/card-payments">take card payments</a>.</p>
          </div>
        </div>
      </section>`,
);

export const CARD_GUIDE_HTML = guidePage(
  {
    path: '/getting-started/card-payments',
    title: 'Card payments: setup guide | Pawservation',
    description:
      'How to take deposits and card payments with Pawservation Pro through your own Stripe account: what Stripe asks for, what it costs, when money arrives, and each step.',
    chip: 'Setup guide &middot; Pro',
    h1: 'Take card payments with Stripe',
    sub: 'Clients pay deposits by card, and those who choose can have what they owe charged after each stay. Stripe pays you directly, into your own bank account.',
  },
  `
      <section class="section">
        <div class="wrap legal">
          <div class="feature" id="at-a-glance">
            <h2>At a glance</h2>
            <p><strong>Time:</strong> about 15 minutes, then a few minutes while Stripe checks your details.</p>
            <p><strong>Plan:</strong> Pro (choose it under &ldquo;Your plan&rdquo;, as in the <a href="/getting-started/whatsapp">WhatsApp guide</a>).</p>
            <p><strong>You&rsquo;ll need:</strong></p>
            <ul>
              <li>your legal name, date of birth and home address;</li>
              <li>the last four digits of your Social Security number (Stripe may ask for all nine);</li>
              <li>your bank&rsquo;s routing and account numbers;</li>
              <li>your booking link, which Stripe can use as your website.</li>
            </ul>
            <p><strong>No company needed.</strong> If you work for yourself, choose individual or sole proprietor. You don&rsquo;t need an EIN.</p>
            <p><strong>What it costs:</strong> Stripe&rsquo;s standard rate on each card payment, a percentage plus a few cents ${STRIPE_LINK}. Stripe charges no monthly fee for this, and Pawservation takes no cut.</p>
            <p><strong>When money arrives:</strong> Stripe pays you directly. Your first payout usually takes one to two weeks after your first payment; after that, money usually reaches your bank about two business days after each payment.</p>
          </div>

          <div class="feature" id="connect">
            <h2>Part 1: Connect Stripe</h2>
            <ol>
              <li>In your dashboard, open <strong>Settings &rarr; Services &amp; Rates</strong> and scroll to the bottom, then find &ldquo;Card payments&rdquo; and choose &ldquo;Open card payments&rdquo;. It opens in a new tab.</li>
              <li>Press &ldquo;Connect Stripe&rdquo;. Stripe&rsquo;s own page opens.</li>
              <li>Fill in your details. For your website, paste your booking link from <strong>Settings &rarr; Your website</strong> (&ldquo;Copy the link&rdquo;).</li>
              <li>Add the bank account you want paid into.</li>
              <li>When Stripe sends you back, wait a few minutes if it says it&rsquo;s still checking. If it says &ldquo;Continue setup&rdquo;, press it and give Stripe what it asks for.</li>
            </ol>
          </div>

          <div class="feature" id="token">
            <h2>Part 2: Add an access token</h2>
            <ol>
              <li>In your dashboard tab, open <strong>Settings &rarr; Business &rarr; Access tokens</strong>, type &ldquo;Card payments&rdquo; as the name, and press &ldquo;Create token&rdquo;.</li>
              <li>Press &ldquo;Copy&rdquo;. The token is shown only once.</li>
              <li>Back in the card payments tab, paste it and press &ldquo;Save token&rdquo;.</li>
            </ol>
            <p>This lets card payments record a deposit when you&rsquo;re not signed in. Use a different token from the one for WhatsApp, so turning one off never stops the other.</p>
          </div>

          <div class="feature" id="deposits">
            <h2>Part 3: Choose a deposit (optional)</h2>
            <ol>
              <li>Choose &ldquo;No deposit&rdquo;, &ldquo;A fixed amount&rdquo; or &ldquo;A percentage of the estimate&rdquo;.</li>
              <li>Press &ldquo;Set deposit rule&rdquo;, read the sentence it shows, and press &ldquo;Confirm deposit rule&rdquo;.</li>
            </ol>
            <p>Clients then see a &ldquo;Pay deposit&rdquo; button under &ldquo;My bookings&rdquo; on confirmed stays that haven&rsquo;t ended, which opens Stripe&rsquo;s own payment page.</p>
          </div>

          <div class="feature" id="after-stays">
            <h2>Part 4: Charge saved cards after stays (optional)</h2>
            <p>This only ever happens to a client who asked for it. A client who has paid a deposit by card can ask, on WhatsApp or through their own assistant, to have that card charged after each stay, and taps &ldquo;Allow charges after stays&rdquo;. When you press &ldquo;Charge saved cards after stays&rdquo; and confirm, each of those clients is charged what their booking still owes, as your balance shows it, the morning after the stay ends. Clients who don&rsquo;t opt in pay you the way they do now. If a card is declined, it is not tried again: the amount stays owed and you collect it as usual.</p>
          </div>

          <div class="feature" id="done">
            <h2>Done</h2>
            <p><strong>You&rsquo;re done when</strong> card payments says it&rsquo;s on and names the Stripe account your money goes to.</p>
          </div>

          <div class="feature" id="problems">
            <h2>If something goes wrong</h2>
            <p><strong>Stripe asks for your full Social Security number.</strong> That&rsquo;s normal when the last four digits can&rsquo;t be matched. It&rsquo;s Stripe asking, on Stripe&rsquo;s own page.</p>
            <p><strong>Stripe is still checking after a day.</strong> Press &ldquo;Continue setup&rdquo; to see what Stripe needs.</p>
            <p><strong>Payouts are paused.</strong> Check your bank details in Stripe.</p>
            <p><strong>It says the access token stopped working.</strong> Create a new token named &ldquo;Card payments&rdquo; and save it again.</p>
            <p><strong>Still stuck?</strong> Email ${SUPPORT_LINK} with your business name. A person reads it.</p>
            <p><strong>Two kinds of Stripe page.</strong> Paying for your own Pawservation plan also happens on a Stripe page, but it&rsquo;s separate: your clients&rsquo; payments go to your own Stripe account, and your plan is paid to Pawservation.</p>
            <p><strong>Turning it off.</strong> &ldquo;Disconnect Stripe&rdquo; removes saved cards, closes open payment links and stops any scheduled charges. Payments already made stay in your Stripe account.</p>
            <p>Next: <a href="/getting-started/whatsapp">let clients book on WhatsApp</a>.</p>
          </div>
        </div>
      </section>`,
);
