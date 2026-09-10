/**
 * Shared stylesheet for the LOCKED_CSP marketing pages (`/`, `/how-it-works`, and the
 * invite-request funnel at `/request-invite*`) — split out of server/index.ts so the new
 * routes/invite-request.ts page-renderers can reuse it without an import cycle (index.ts
 * mounts those routes, so the routes module cannot import back from index.ts).
 */
export const PAGE_STYLE = /* css */ `
      /* Brand face for the nav wordmark only: a 1.3KB self-hosted subset ("Pawservation"
         glyphs), so it can never slow the page or leak a request off-origin. */
      @font-face {
        font-family: 'Boogaloo';
        src: url('/fonts/boogaloo.woff2') format('woff2');
        font-weight: 400;
        font-display: swap;
      }
      :root {
        color-scheme: light;
        /* Palette derived from the widget's own tokens (app/embed/widget.css) so the
           screenshots and the page read as one product. */
        --bg: #fcfcfa;
        --panel: #f1f5ee;
        --ink: #18271d;
        --body-c: #415044;
        --soft: #5a6a5e;
        --line: #e3e7e0;
        --green: #2e6440;
        --deep: #1d3826;
        --deepest: #142919;
        --card: #ffffff;
        --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif;
        --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
          "Liberation Mono", monospace;
      }
      * { box-sizing: border-box; }
      html {
        -webkit-text-size-adjust: 100%;
        scroll-behavior: smooth;
      }
      body {
        margin: 0;
        font-family: var(--sans);
        color: var(--body-c);
        background: var(--bg);
        line-height: 1.6;
        font-size: 16px;
      }
      h1, h2, h3 { color: var(--ink); margin: 0; }
      .wrap {
        width: 100%;
        max-width: 1120px;
        margin: 0 auto;
        padding: 0 24px;
      }

      /* ── Header ─────────────────────────────────────────────────── */
      .nav {
        position: sticky;
        top: 0;
        z-index: 10;
        background: rgba(252, 252, 250, 0.88);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border-bottom: 1px solid var(--line);
      }
      .nav-inner {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        row-gap: 10px;
        gap: 28px;
        min-height: 64px;
        padding-top: 8px;
        padding-bottom: 8px;
      }
      .logo {
        display: flex;
        align-items: center;
        gap: 9px;
        text-decoration: none;
        color: var(--ink);
        font-family: 'Boogaloo', var(--sans, sans-serif);
        font-weight: 400;
        font-size: 1.3rem;
        letter-spacing: 0.02em;
      }
      .logo svg { display: block; color: var(--green); }
      .nav-links {
        display: none;
        gap: 24px;
        margin-left: 8px;
      }
      .nav-links a {
        color: var(--body-c);
        text-decoration: none;
        font-size: 0.9rem;
        font-weight: 500;
      }
      .nav-links a:hover { color: var(--ink); }
      .nav-right {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 18px;
      }
      .signin {
        color: var(--body-c);
        text-decoration: none;
        font-size: 0.9rem;
        font-weight: 500;
        white-space: nowrap;
      }
      .signin:hover { color: var(--ink); }
      @media (min-width: 780px) {
        .nav-links { display: flex; }
      }
      /* The landing header carries "Full tour" twice in the markup and shows exactly one of
         them: the .nav-links copy above 780px, this one below it, where that row is hidden. */
      .nav-tour { display: inline; }
      @media (min-width: 780px) { .nav-tour { display: none; } }
      /* What this breakpoint guarantees: below 780px the header holds exactly three items, the
         wordmark, "Full tour" and the invite button. The two plain links leave at the same width
         as the .nav-links row rather than at some narrower width of their own, because a fourth
         item in this row is what scrolled the whole page sideways at 431px to 474px. Nothing is
         lost at those widths: sign-in is in the hero note and the footer, and the demo is the
         hero's own second button and the second link on both mid-page invitations. */
      @media (max-width: 779px) { .nav-right .signin:not(.nav-tour) { display: none; } }
      /* Sign in comes back later than the other plain link, at the width where the whole row
         genuinely fits: with the .nav-links row back from 780px, eight items already fill the
         header, and letting sign-in return before there was room for it made the row wrap again
         further up, so the header went from one line to two and back as the window widened. It is
         the one item here a visitor can reach from somewhere else on the same screen: the hero
         note links it, and so does the footer. The threshold is measured, not chosen: the full
         landing row needs 944px, and 960 is that with slack. .nav-signin exists on the landing
         header alone, so this rule is already landing-only. */
      @media (max-width: 959px) { .nav-right .nav-signin { display: none; } }
      /* The landing row went from four links to five when About joined it, which is 16px of extra
         gap and 41px of extra link at the width where the row first appears, and the header wrapped
         onto a second line from 780px up. Three measurements set what follows, taken from the
         rendered header: the row without either plain link needs 773px, with "Try the demo" 880px,
         and with sign-in as well 944px. So this row closes its own gaps by 4px each, and the demo
         link returns at 890px rather than at 780px with the row itself, for the reason it is
         absent below 780px at all: it is the hero's own second button and the second link on both
         mid-page invitations. Both are scoped by a class on the row, because the legal pages carry
         no link row and have room for sign-in the whole way down.
         /how-it-works carries this class too, and for the same measured reason rather than by
         analogy: its own five-link row plus "Sign in" plus the demo button needs 782px of content
         box, so the header wrapped onto a second line from 780px (where .nav-links appears) to
         829px. The 4px-per-gap tightening and the sign-in drop below 890px are exactly the 80px
         that band was short by, and above 890px the full row fits with room. Sign in stays in the
         shared footer at every width, which is why it is the item that gives way. */
      .nav-links-5 { gap: 20px; }
      @media (max-width: 889px) {
        .nav-links-5 ~ .nav-right .signin:not(.nav-tour) { display: none; }
      }
      /* The gaps, the wordmark and the button tighten below 560px, which is what keeps the header
         to one row on most phones. Where they are not enough the row WRAPS: .nav-inner is
         flex-wrap: wrap at every width (above), and that is what actually guarantees the page
         never scrolls sideways, whatever a future button is called. Three items with a
         17-character button do not fit across a 320px phone at any type size worth reading, and
         this row is the widest thing on the page, so a no-wrap header pushed the DOCUMENT wider
         than the viewport rather than pushing itself. That was the 320px to 365px scroll. */
      @media (max-width: 560px) {
        .nav-inner { gap: 10px; }
        .nav-right { gap: 10px; }
        .nav-right .btn-sm { padding: 8px 12px; font-size: 0.86rem; }
        .nav-tour { font-size: 0.84rem; }
        .nav-inner .logo { font-size: 1.02rem; gap: 6px; }
        .nav-inner .logo img { width: 26px; height: auto; }
      }

      /* ── Buttons ────────────────────────────────────────────────── */
      .btn {
        display: inline-block;
        padding: 11px 22px;
        border-radius: 8px;
        font-weight: 600;
        font-size: 0.94rem;
        text-decoration: none;
        white-space: nowrap;
        transition: background-color 0.15s ease, color 0.15s ease;
        /* Every .btn here is an <a> except one: the invite form's submit control. A <button>
           inherits neither font-family nor line-height from body, so that one rendered in the
           UA's Arial at line-height:normal and stood 39px tall next to the 46px .btn-inverse on
           /how-it-works doing the identical job under the identical label. These two longhands
           change nothing for an <a> (which already inherits both) and make the element the
           button is built from stop mattering. */
        font-family: inherit;
        line-height: inherit;
      }
      .btn-primary {
        background: var(--green);
        color: #fff;
      }
      .btn-primary:hover { background: var(--deep); }
      .btn-ghost {
        color: var(--ink);
        border: 1px solid var(--line);
        background: var(--card);
      }
      .btn-ghost:hover { border-color: var(--soft); }
      .btn-sm { padding: 8px 16px; font-size: 0.88rem; }
      .btn-inverse {
        background: #fff;
        color: var(--deep);
      }
      .btn-inverse:hover { background: var(--panel); }

      /* ── Hero ───────────────────────────────────────────────────── */
      .hero { padding: 72px 0 88px; }
      /* Every other page's hero ends where a new band begins, so its 88px bottom padding stacks
         with the next section's 88px top padding and reads as the join between two blocks.
         /about's hero runs straight into the founder story on the same background, with no label
         or heading to reintroduce it, so those 176px read as a hole between the page's own
         subheading and its first paragraph. One class on that hero closes both halves and leaves
         the .sub's own 30px margin as the gap. The adjacent-sibling half is what keeps this off
         /, /how-it-works, /privacy, /terms and /contact, none of which carry the class. */
      .hero-flush { padding-bottom: 0; }
      .hero-flush + .section { padding-top: 0; }
      .hero-grid {
        display: grid;
        gap: 56px;
        align-items: center;
      }
      .chip {
        display: inline-block;
        margin: 0 0 20px;
        padding: 5px 12px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--card);
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--green);
        letter-spacing: 0.01em;
      }
      .hero h1 {
        font-size: clamp(2.3rem, 5vw, 3.35rem);
        font-weight: 800;
        line-height: 1.06;
        letter-spacing: -0.032em;
        margin: 0 0 20px;
        max-width: 15ch;
      }
      .hero .sub {
        margin: 0 0 30px;
        max-width: 48ch;
        font-size: 1.08rem;
        color: var(--body-c);
      }
      .cta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 18px;
      }
      .note {
        margin: 0;
        font-size: 0.84rem;
        color: var(--soft);
        max-width: 46ch;
      }
      /* Also the four prose pages' body links. Nothing had ever styled a link inside running
         copy, because until /about and /contact existed every link on this site sat in a .note, a
         button, the nav or the footer, all of which are styled. So ten links across /about,
         /contact, /privacy and /terms rendered in the browser default #0000EE, on the pages a
         reader opens to judge whether this is a real business. Same declarations, not a second
         set, so the two can never drift into two shades of underline. */
      .note a,
      .legal p a,
      .legal li a {
        color: var(--ink);
        text-decoration: underline;
        text-decoration-color: var(--green);
        text-underline-offset: 2px;
      }

      /* Signature: the real widget on a soft product panel, with a CSS-built
         "new request" card floating over it: the confirm-or-decline promise, shown. */
      .hero-visual { position: relative; }
      .visual-panel {
        position: relative;
        border-radius: 16px;
        background: radial-gradient(130% 120% at 20% 0%, #e7efe3 0%, var(--panel) 60%);
        border: 1px solid var(--line);
        padding: clamp(20px, 4vw, 36px) clamp(20px, 4vw, 36px) 0;
        overflow: hidden;
      }
      .screen {
        position: relative;
        max-width: 400px;
        margin: 0 auto;
        height: clamp(360px, 46vw, 480px);
        overflow: hidden;
        border-radius: 12px 12px 0 0;
        border: 1px solid var(--line);
        border-bottom: 0;
        background: #fff;
        box-shadow: 0 24px 60px -32px rgba(24, 39, 29, 0.45);
      }
      .screen img { display: block; width: 100%; height: auto; }
      .screen-fade {
        position: absolute;
        inset: auto 0 0 0;
        height: 90px;
        background: linear-gradient(to bottom, rgba(241, 245, 238, 0), var(--panel));
        pointer-events: none;
      }
      .req-card {
        position: absolute;
        right: clamp(6px, 2vw, 22px);
        bottom: 26px;
        width: 216px;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 12px 14px;
        box-shadow: 0 16px 40px -20px rgba(24, 39, 29, 0.5);
        font-size: 0.78rem;
        line-height: 1.45;
      }
      .req-card .req-label {
        font-weight: 700;
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: var(--green);
      }
      .req-card .req-what { color: var(--ink); font-weight: 600; }
      .req-card .req-btns {
        display: flex;
        gap: 6px;
        margin-top: 8px;
      }
      .req-card .req-btns span {
        flex: 1;
        text-align: center;
        padding: 5px 0;
        border-radius: 6px;
        font-weight: 600;
        font-size: 0.74rem;
      }
      .req-yes { background: var(--green); color: #fff; }
      .req-no { border: 1px solid var(--line); color: var(--body-c); }
      @media (min-width: 880px) {
        .hero-grid { grid-template-columns: 1.05fr 0.95fr; }
      }

      /* ── Section scaffolding ────────────────────────────────────── */
      section { scroll-margin-top: 80px; }
      .section { padding: 88px 0; }
      .section-head { max-width: 60ch; margin-bottom: 48px; }
      .label {
        display: block;
        margin-bottom: 10px;
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.09em;
        color: var(--green);
      }
      .section h2 {
        font-size: clamp(1.65rem, 3.4vw, 2.15rem);
        font-weight: 750;
        letter-spacing: -0.025em;
        line-height: 1.15;
        margin: 0 0 12px;
      }
      .section-head p { margin: 0; color: var(--body-c); max-width: 52ch; }
      /* A section head may run to two paragraphs; the first rule zeroes every margin, so the
         gap between them has to be put back here rather than inherited. */
      .section-head p + p { margin-top: 14px; }
      /* Section headings and the column headings inside them are two or three words past one
         line at most widths, and the default break leaves the last word alone under a full line.
         Balance splits the lines evenly instead. Unsupported browsers wrap as before. */
      .section-head h2, .wf-h { text-wrap: balance; }
      .band { background: var(--panel); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }

      /* ── How it works ───────────────────────────────────────────── */
      .steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 28px;
      }
      .step-card {
        display: flex;
        flex-direction: column;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: hidden;
      }
      .step-card .frame {
        background: var(--panel);
        border-bottom: 1px solid var(--line);
        padding: 18px;
        display: flex;
        align-items: center;
        height: 224px;
        overflow: hidden;
      }
      /* The calendar shot is much taller than the others: crop it from the top
         (month header visible) so all three cards stay the same height. */
      .step-card .frame-tall { align-items: flex-start; }
      .step-card img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 6px;
        border: 1px solid var(--line);
        background: #fff;
        box-shadow: 0 10px 24px -18px rgba(24, 39, 29, 0.5);
      }
      .step-card .step-body { padding: 20px 22px 24px; }
      .step-no {
        font-family: var(--mono);
        font-size: 0.74rem;
        font-weight: 700;
        color: var(--green);
      }
      .step-card h3 {
        margin: 6px 0 8px;
        font-size: 1.06rem;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .step-card p { margin: 0; font-size: 0.92rem; color: var(--body-c); }
      @media (min-width: 780px) {
        .steps { grid-template-columns: 1fr 1fr 1fr; }
      }

      /* ── Dashboard: the bookings queue, rebuilt in CSS ──────────── */
      .mockdash {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        box-shadow: 0 20px 50px -30px rgba(24, 39, 29, 0.5);
        margin-bottom: 48px;
        overflow: hidden;
      }
      .mockdash-top {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 22px;
        border-bottom: 1px solid var(--line);
        background: var(--bg);
      }
      .mockdash-title {
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--ink);
      }
      .mockdash-count {
        padding: 2px 9px;
        border-radius: 999px;
        background: var(--panel);
        color: var(--green);
        font-size: 0.73rem;
        font-weight: 700;
      }
      .mockdash-when {
        margin-left: auto;
        font-size: 0.78rem;
        color: var(--soft);
      }
      .mock-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 18px;
        padding: 16px 22px;
        border-bottom: 1px solid var(--line);
      }
      .mock-row:last-child { border-bottom: 0; }
      .mock-info { flex: 1 1 240px; min-width: 0; }
      .mock-who {
        color: var(--ink);
        font-weight: 600;
        font-size: 0.94rem;
      }
      .mock-meta {
        margin-top: 2px;
        font-size: 0.83rem;
        color: var(--soft);
      }
      .state {
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 0.73rem;
        font-weight: 600;
        white-space: nowrap;
      }
      .state-pend { background: #f8f1de; color: #8a6b1c; }
      .state-ok { background: #e7f2e8; color: #23684a; }
      .mock-actions {
        display: flex;
        gap: 8px;
        margin-left: auto;
      }
      .mbtn {
        padding: 7px 14px;
        border-radius: 7px;
        font-size: 0.8rem;
        font-weight: 600;
        white-space: nowrap;
      }
      .mbtn-primary { background: var(--green); color: #fff; }
      .mbtn-line {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--body-c);
      }
      @media (max-width: 560px) {
        .mock-actions { margin-left: 0; width: 100%; }
        .mbtn { flex: 1; text-align: center; }
      }
      .features {
        display: grid;
        gap: 28px 40px;
      }
      /* h2 as well as h3: the four prose pages (/about, /contact, /privacy, /terms) carry no
         .section-head, so their .feature headings are the first heading under the page h1 and
         must be h2 or the document skips a level. They keep this size, which is the point of
         listing both here rather than letting .section h2's clamp() blow them up: correcting the
         LEVEL must not change the LOOK. Source order matters, since .section h2 above has equal
         specificity. */
      .feature h2,
      .feature h3 {
        font-size: 0.98rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        margin: 0 0 5px;
      }
      .feature p { margin: 0; font-size: 0.9rem; color: var(--body-c); }
      @media (min-width: 640px) { .features { grid-template-columns: 1fr 1fr; } }
      @media (min-width: 960px) { .features { grid-template-columns: 1fr 1fr 1fr; } }
      /* Four short cards read as one row or not at all: in the three-column default the
         fourth sits alone on a second row with three empty columns beside it. */
      @media (min-width: 960px) { .features-4 { grid-template-columns: repeat(4, 1fr); } }
      /* THREE cards have the same problem in the 640-959px band, where the default is two columns
         and the third card sits alone with an empty cell beside it: measured at 900px on #clients,
         a visible hole halfway down the landing page. Three cards reflow one-or-three, which is
         also what .steps (the OTHER three-card row on that same page) already does at the same
         780px breakpoint, so the landing stops running two three-card rows on two different
         reflows. Later in source than the .features rules above, which it overrides at equal
         specificity. */
      .features-3 { grid-template-columns: 1fr; }
      @media (min-width: 780px) { .features-3 { grid-template-columns: 1fr 1fr 1fr; } }
      /* Single-column legal prose (Privacy/Terms): .feature blocks sit directly in .wrap with
         no .features grid wrapper (that grid goes multi-column at wider viewports, which is
         wrong here), so this rule supplies the same 28px rhythm between stacked blocks. */
      .legal .feature + .feature { margin-top: 28px; }
      /* A reading measure. Without one this prose runs the full 1072px .wrap, which is about 130
         characters a line at 1280px, sitting under a hero whose h1 is capped at 15ch and whose
         .sub is capped at 48ch: a heading in a half column above a body at full width, on the four
         pages a wary reader opens to decide whether this is a real business. 52ch is the measure
         .section-head p already sets, so every section intro on the landing and the tour is
         already read at it and this borrows the number rather than inventing a second one; it
         works out at roughly 72 characters a line. It caps the TEXT and not the .feature block,
         which is what lets /about's founder grid keep its 200px photo column beside prose set to
         the same measure as every other page here. */
      .legal p,
      .legal li { max-width: 52ch; }
      /* .feature p zeroes every margin for the three-across cards, which leaves a legal or
         /about block's stacked paragraphs with no gap at all. Put it back for the single-column
         prose only, where a .feature really is several paragraphs of one answer. */
      .legal .feature p + p { margin-top: 12px; }

      /* ── /about founder portrait ────────────────────────────────── */
      /* The photo carries a claim the words can't (a dog walker wrote this), so it is content
         with real alt text, and its intrinsic 360x480 is declared on the tag so nothing reflows
         around it while it loads. It stacks above the copy on a phone and moves beside it at the
         780px breakpoint the rest of the page turns two-column at. */
      .founder { display: grid; gap: 20px; align-items: start; }
      .founder-photo {
        width: 200px;
        max-width: 100%;
        height: auto;
        border-radius: 14px;
        border: 1px solid var(--line);
      }
      .founder > div > * + * { margin-top: 12px; }
      /* The three questions are quotes from real clients, so they are set apart as quotes and
         given no bullet: the point is the wording, not that there happen to be three. */
      .founder-qs {
        margin: 0;
        padding: 0 0 0 14px;
        list-style: none;
        border-left: 2px solid var(--line);
      }
      .founder-qs li { font-size: 0.9rem; color: var(--ink); }
      .founder-qs li + li { margin-top: 6px; }
      @media (min-width: 780px) {
        .founder { grid-template-columns: 200px 1fr; gap: 30px; }
      }

      /* ── wf-* label/pair layout (pricing note, how-it-works page) ── */
      .wf-h {
        font-size: 1.02rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        margin: 0 0 4px;
      }
      .wf-h + .note { margin-bottom: 16px; }
      /* Each row names what the sitter keeps, then what Pawservation does with it. The
         contrast IS the message, so both lines share one hairline-ruled row. */
      .wf-pair { padding: 15px 0; border-top: 1px solid var(--line); }
      .wf-pair:last-of-type { border-bottom: 1px solid var(--line); }
      .wf-pair p { margin: 0; font-size: 0.91rem; }
      .wf-keep { color: var(--ink); font-weight: 600; }
      .wf-pair p + p { margin-top: 3px; color: var(--body-c); }
      .wf-steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 14px;
      }
      .wf-step {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 15px 18px 17px;
      }
      .wf-step p { margin: 4px 0 0; font-size: 0.91rem; color: var(--body-c); }
      .wf-step p strong { color: var(--ink); }
      /* The time figure is arithmetic the reader can redo with their own numbers, not a
         measured statistic; the multiplication is shown, in mono, so it reads as a
         worked example rather than a benchmark. */
      .wf-math {
        margin-top: 40px;
        padding: 24px 26px 26px;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
      }
      .wf-math p { margin: 0 0 10px; font-size: 0.91rem; max-width: 68ch; }
      .wf-math .wf-h { margin-bottom: 12px; }
      .wf-math p:last-child { margin-bottom: 0; }
      /* A quiet aside at the end of a section: an option a sitter may take, not a pillar of
         the product. Ruled off rather than carded, so it reads below the cards above it. */
      .wf-aside { margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--line); }
      .wf-aside .wf-h { font-size: 0.95rem; color: var(--body-c); margin-bottom: 6px; }
      .wf-aside p { margin: 0 0 8px; font-size: 0.88rem; color: var(--soft); max-width: 62ch; }
      .wf-aside p:last-child { margin-bottom: 0; }
      .wf-math .wf-sum {
        margin: 14px 0 16px;
        font-family: var(--mono);
        font-size: 0.95rem;
        font-weight: 700;
        color: var(--ink);
      }
      /* The closing line under a section's columns: the invite line under the two price cards. */
      .wf-more { margin-top: 24px; }
      /* Two mid-page invitations, under the client section and under the dashboard: the page
         exists to get a sitter to ask for an invite, and the hero and the closing panel were the
         only two places she could. */
      .mid-cta { margin-top: 28px; margin-bottom: 0; }

      /* ── Install ────────────────────────────────────────────────── */
      .install-grid {
        display: grid;
        gap: 40px;
        align-items: center;
      }
      .install-copy p { margin: 0 0 14px; max-width: 44ch; }
      .install-copy p:last-child { margin-bottom: 0; font-size: 0.88rem; color: var(--soft); }
      .codecard {
        background: var(--deepest);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 24px 60px -36px rgba(20, 41, 25, 0.9);
      }
      .codecard-cap {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 11px 18px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.09);
        font-family: var(--mono);
        font-size: 0.7rem;
        letter-spacing: 0.06em;
        color: #8fa896;
      }
      .code-scroll { overflow-x: auto; }
      .codecard pre {
        margin: 0;
        padding: 20px 18px;
        min-width: max-content;
        font-family: var(--mono);
        font-size: 0.84rem;
        line-height: 1.75;
        color: #e8efe8;
      }
      .codecard .tag { color: #93c9a4; }
      .codecard .attr { color: #d8c98a; }
      @media (min-width: 880px) {
        .install-grid { grid-template-columns: 0.85fr 1.15fr; }
      }

      /* ── Pricing ───────────────────────────────────────────────── */
      .price-grid {
        display: grid;
        gap: 24px;
        /* Cards size to their own content: Pro lists fewer lines than Solo, and
           stretching it to match left a dead gap at the bottom. */
        align-items: start;
      }
      .price-card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 26px 26px 28px;
      }
      .price-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
      }
      .price-card h3 {
        margin: 0;
        font-size: 1.14rem;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .price-amt {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 9px;
        margin: 0 0 18px;
      }
      .price-num {
        color: var(--ink);
        font-size: clamp(2rem, 4vw, 2.4rem);
        font-weight: 800;
        letter-spacing: -0.03em;
        line-height: 1.05;
      }
      .price-per { font-size: 0.88rem; color: var(--soft); }
      .price-list {
        list-style: none;
        margin: 0 0 24px;
        padding: 0;
        border-top: 1px solid var(--line);
      }
      .price-list li {
        position: relative;
        padding: 10px 0 10px 25px;
        border-bottom: 1px solid var(--line);
        font-size: 0.9rem;
        color: var(--body-c);
      }
      .price-list li::before {
        content: "";
        position: absolute;
        left: 4px;
        top: 18px;
        width: 9px;
        height: 5px;
        border-left: 2px solid var(--green);
        border-bottom: 2px solid var(--green);
        transform: rotate(-45deg);
      }
      .price-card .note { margin-top: 10px; }
      @media (min-width: 780px) {
        .price-grid { grid-template-columns: 1fr 1fr; }
      }

      /* ── CTA band ───────────────────────────────────────────────── */
      .cta-band { padding: 40px 0 96px; }
      .cta-panel {
        background: linear-gradient(140deg, var(--deep) 0%, var(--deepest) 80%);
        border-radius: 18px;
        padding: clamp(44px, 7vw, 72px) clamp(24px, 6vw, 72px);
        text-align: center;
      }
      .cta-panel h2 {
        color: #fff;
        font-size: clamp(1.7rem, 3.6vw, 2.3rem);
        font-weight: 750;
        letter-spacing: -0.025em;
        margin: 0 0 12px;
      }
      .cta-panel p {
        margin: 0 auto 28px;
        max-width: 46ch;
        color: #c4d2c6;
      }
      .cta-panel .cta-row { justify-content: center; margin-bottom: 0; }
      .cta-panel .signin-inverse {
        align-self: center;
        color: #c4d2c6;
        font-size: 0.9rem;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .cta-panel .signin-inverse:hover { color: #fff; }

      /* ── Footer ─────────────────────────────────────────────────── */
      .foot {
        border-top: 1px solid var(--line);
        padding: 48px 0 40px;
        font-size: 0.88rem;
      }
      .foot-grid {
        display: grid;
        gap: 36px;
        margin-bottom: 40px;
      }
      .foot-brand .logo { margin-bottom: 10px; }
      .foot-brand p { margin: 0; color: var(--soft); max-width: 34ch; font-size: 0.86rem; }
      .foot h3 {
        font-size: 0.76rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--soft);
        margin: 0 0 12px;
      }
      .foot ul { list-style: none; margin: 0; padding: 0; }
      .foot li { margin-bottom: 9px; }
      .foot a { color: var(--body-c); text-decoration: none; }
      .foot a:hover { color: var(--ink); }
      .foot-bottom {
        border-top: 1px solid var(--line);
        padding-top: 22px;
        color: var(--soft);
        font-size: 0.8rem;
      }
      .foot-bottom p { margin: 0; }
      @media (min-width: 700px) {
        .foot-grid { grid-template-columns: 1.4fr 1fr 1fr 1fr; }
      }

      :focus-visible {
        outline: 3px solid var(--green);
        outline-offset: 3px;
        border-radius: 4px;
      }
      /* The ring above is --green because every ground on this site is light, with one exception:
         the CTA panel's dark gradient, where #2e6440 on #1d3826 is 1.83:1 and reads as no ring at
         all. That band holds the invite button, the "already have an account" link and the tour's
         demo/pricing links, so a keyboard visitor loses the page's primary action. Only the COLOR
         is overridden, so width, offset and radius stay one rule; the panel's own form fields
         already focus white, which is the shape this follows. */
      .cta-panel :focus-visible { outline-color: #fff; }
      @media (prefers-reduced-motion: reduce) {
        html { scroll-behavior: auto; }
        .btn { transition: none; }
      }

      /* ── Invite-request form (inside the cta-band) ─────────────── */
      .invite-form {
        margin-top: 28px;
        text-align: left;
        display: grid;
        gap: 16px;
      }
      .invite-field { display: flex; flex-direction: column; gap: 6px; }
      .invite-field-wide { grid-column: 1 / -1; }
      .invite-field label {
        font-size: 0.82rem;
        font-weight: 600;
        color: #c4d2c6;
      }
      .invite-optional { font-weight: 400; color: #8fa896; }
      .invite-field input,
      .invite-field select,
      .invite-field textarea {
        width: 100%;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.06);
        color: #fff;
        font-family: var(--sans);
        font-size: 0.92rem;
      }
      .invite-field input::placeholder,
      .invite-field textarea::placeholder { color: #8fa896; }
      .invite-field input:focus,
      .invite-field select:focus,
      .invite-field textarea:focus {
        outline: 2px solid #fff;
        outline-offset: 1px;
      }
      .invite-field select option { color: var(--ink); }
      .invite-field textarea { resize: vertical; min-height: 64px; }
      /* Honeypot: visually hidden off-screen (not display:none) so a naive bot's fill-every-field
         pass still finds and fills it, while tabindex="-1" on the input keeps it out of a real
         visitor's keyboard tab order and it's never in view to click. */
      .invite-hp {
        position: absolute;
        left: -9999px;
        width: 1px;
        height: 1px;
        overflow: hidden;
      }
      .invite-submit {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
        margin-top: 4px;
      }
      .invite-submit button { border: 0; cursor: pointer; }
      @media (min-width: 640px) {
        .invite-form { grid-template-columns: 1fr 1fr; }
      }
`;
