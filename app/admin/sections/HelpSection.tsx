import { IconHelp } from '../../shared-ui/icons';

/**
 * Static in-app help (spec: 2026-07-19-help-and-explainers-design). Six short topics on one
 * scroll — no accordion, so find-in-page works. Cross-references to other sections are real
 * #hash links; the existing hash nav switches panels. No props, no fetches, no server routes.
 */
export function HelpSection() {
  return (
    <>
      <h2>
        <IconHelp size={18} /> Help
      </h2>

      <h3>Getting set up</h3>
      <p>
        When you first sign in, Quick setup walks you through the basics: your business details, the
        pets you take, what you offer, and your prices. You can re-run it anytime from{' '}
        <a href="#services">Services &amp; rates</a> — it only adds, never overwrites. Three
        sections finish the picture: <a href="#business">Business</a> holds your contact details,{' '}
        <a href="#pets">Pet types</a> sets which animals you accept, and Services &amp; rates is
        where each service&rsquo;s pricing, questions, and booking limits — including daily caps —
        live. Nothing changes for clients until you save — a dark bar appears at the bottom of the
        screen whenever you have unsaved changes.
      </p>

      <h3>Taking bookings</h3>
      <p>
        Only people on your client list can book, so start in <a href="#clients">Clients</a>: add
        each client&rsquo;s email (or import a spreadsheet) and they get an invite. A client&rsquo;s
        request arrives under &ldquo;Needs your reply&rdquo; — nothing is ever booked without you.
        Confirm and the client gets an email; decline and they hear that too. Pawservation
        won&rsquo;t double-book you: once a day is full, or you&rsquo;ve blocked it as time off,
        clients simply can&rsquo;t pick it.
      </p>

      <h3>Your calendar and Google Calendar</h3>
      <p>
        The <a href="#calendar">Calendar</a> section — the first thing you see when you sign in —
        shows your month: confirmed bookings, requests waiting on you, and time off. Add days off
        under <a href="#timeoff">Time off</a> — blocked days vanish from clients&rsquo; calendars
        immediately. If you live in Google Calendar, connect it under{' '}
        <a href="#apps">Connected apps</a>: booking requests appear there, and cancelled ones are
        cleared away. One thing to know: the sync is one-way. A dentist appointment on your Google
        Calendar won&rsquo;t block bookings — enter it as time off if you need the day held.
      </p>

      <h3>Getting paid</h3>
      <p>
        Pawservation doesn&rsquo;t process payments — no card fees, nobody holding your money. You
        collect the way you already do: cash, Venmo, Zelle, PayPal, check. Each booking shows an
        estimated cost from your rates; when a client pays, open the booking&rsquo;s Payments and
        record it — the full amount, a deposit, or a partial. <a href="#earnings">Earnings</a> does
        the rest: month-by-month revenue, who still owes you, and your top clients, all built from
        what you record.
      </p>

      <h3>Your website</h3>
      <p>
        Your booking page can live on your own website — Squarespace, Wix, or anything else. Open{' '}
        <a href="#embed">Your website</a>, copy the code, and paste it where you want bookings to
        appear; the preview shows exactly what clients will see. If your site builder refuses the
        first code, use the second — same page, works everywhere. No website? Send clients the
        direct link to your booking page instead.
      </p>

      <h3>Running your own copy</h3>
      <p>
        Most sitters use Pawservation as a hosted service — sign in and it just works, with hosting
        and updates handled for you. Pawservation is also open source (MIT), so if you&rsquo;re
        technical (or know someone who is) you can run your own copy on Cloudflare Workers, with
        your own database and domain. The README at{' '}
        <a href="https://github.com/bradburch/pawservation">github.com/bradburch/pawservation</a>{' '}
        walks through it.
      </p>
    </>
  );
}
