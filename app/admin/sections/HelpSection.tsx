import { IconHelp } from '../../shared-ui/icons';

/**
 * Static in-app help (spec: 2026-07-19-help-and-explainers-design). Five short topics on one
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
        When you first sign in, Quick setup walks you through the basics: your business details,
        what you offer, and your prices. You can re-run it anytime from{' '}
        <a href="#services">Services &amp; Rates</a> — it only adds, never overwrites. Three
        sections finish the picture: <a href="#business">Business</a> holds your contact details,{' '}
        <a href="#pets">Pet types</a> sets which animals you accept, and Services &amp; Rates is
        where each service&rsquo;s pricing, questions, and booking limits — including daily caps —
        live. Settings changes reach clients only when you save — a dark bar appears at the bottom
        of the screen whenever you have unsaved changes. (Time off and client changes apply
        immediately; they have no save step.)
      </p>

      <h3>Taking bookings</h3>
      <p>
        Only people on your client list can book, so start in <a href="#clients">Clients</a>: add
        each client together with their first pet (or import a spreadsheet), then send them a
        welcome email from their row whenever you&rsquo;re ready. A client&rsquo;s request arrives
        under &ldquo;Needs your reply&rdquo; — nothing is ever booked without you. Confirm and the
        client gets an email; decline and they hear that too. Pawservation won&rsquo;t double-book
        you: once a day is full, or you&rsquo;ve blocked it as time off, clients simply can&rsquo;t
        pick it.
      </p>

      <h3>Your calendar and Google Calendar</h3>
      <p>
        The <a href="#calendar">Calendar</a> section — the first thing you see when you sign in —
        shows your month: confirmed bookings, requests waiting on you, time off, and events from
        your Google Calendar. Add days off under <a href="#timeoff">Time off</a> — blocked days
        vanish from clients&rsquo; calendars immediately. If you live in Google Calendar, connect it
        under <a href="#apps">Connected apps</a>: booking requests appear there and cancelled ones
        are cleared away.
      </p>
      <p>
        Sync runs both ways, so pick the calendar you connect carefully. Every event on it blocks
        booking requests for those dates — which is perfect for a calendar you keep pet-sitting on,
        and a problem on your personal one, where a dentist appointment would quietly close a day
        you&rsquo;d happily have worked. The fix is one press: in Connected apps, choose
        &ldquo;Create a pet calendar&rdquo; and Pawservation makes a separate calendar inside your
        Google account and moves booking sync to it. Your upcoming bookings come across
        automatically and the rest of your Google account stops being read.
      </p>
      <p>
        Blocking days and calendar events stop <em>new</em> requests only — neither one ever changes
        or cancels a booking you&rsquo;ve already confirmed. And nothing on your calendar can book
        you: every request lands under <a href="#bookings">Bookings</a> and waits for you to confirm
        or decline it.
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
    </>
  );
}
