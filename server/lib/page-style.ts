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
         genuinely fits: with the .nav-links row back from 780px, seven items already fill the
         header, and letting sign-in return before there was room for it made the row wrap again
         further up, so the header went from one line to two and back as the window widened. It is
         the one item here a visitor can reach from somewhere else on the same screen: the hero
         note links it, and so does the footer. */
      @media (max-width: 939px) { .nav-right .nav-signin { display: none; } }
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
      .note a {
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
      /* Single-column legal prose (Privacy/Terms): .feature blocks sit directly in .wrap with
         no .features grid wrapper (that grid goes multi-column at wider viewports, which is
         wrong here), so this rule supplies the same 28px rhythm between stacked blocks. */
      .legal .feature + .feature { margin-top: 28px; }

      /* ── Alongside your workflow ────────────────────────────────── */
      .wf-grid {
        display: grid;
        gap: 44px;
        align-items: start;
      }
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
      .wf-math .wf-sum {
        margin: 14px 0 16px;
        font-family: var(--mono);
        font-size: 0.95rem;
        font-weight: 700;
        color: var(--ink);
      }
      @media (min-width: 780px) {
        .wf-grid { grid-template-columns: 1fr 1fr; gap: 56px; }
      }
      /* The closing line under a section's columns, used twice: the link out to the long-form
         tour under the workflow columns, and the invite line under the two price cards. */
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
