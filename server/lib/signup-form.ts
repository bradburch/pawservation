import { htmlEscape } from './email';
import { SIGNUP_ACTION, TURNSTILE_SCRIPT_ORIGIN } from './turnstile';

/**
 * The sign-up `<form>`, shared by the landing page's closing panel (server/index.ts, no widget)
 * and the /signup page (routes/signup-page.ts, with the widget when Turnstile is configured).
 * A leaf module, like PAGE_STYLE, so index.ts and the route can both import it.
 *
 * Why the landing variant carries no widget: `/` is served under LOCKED_CSP and is script-free by
 * doctrine (marketing-pages skill), and Turnstile is a cross-origin script plus a cross-origin
 * iframe. So the landing form posts the email to /signup, which answers with the same form, the
 * email kept, and the widget — the one page whose CSP admits challenges.cloudflare.com. When
 * Turnstile is off (local development) the same POST is processed straight away.
 *
 * The widget is Turnstile's IMPLICIT render: its script finds the `.cf-turnstile` div and adds a
 * hidden `cf-turnstile-response` input to this form, so a native form POST carries the token and
 * the page needs no script of its own. The honeypot is named "fax" (the old invite form's name).
 */
export function renderSignupForm(opts: { email?: string; siteKey?: string } = {}): string {
  const widget = opts.siteKey
    ? `
              <div class="signup-field signup-field-wide">
                <div class="cf-turnstile" data-sitekey="${htmlEscape(opts.siteKey)}" data-action="${SIGNUP_ACTION}" data-theme="dark"></div>
              </div>`
    : '';
  return `<form class="signup-form" method="post" action="/signup">
              <div class="signup-field signup-field-wide">
                <label for="signup-email">Your email</label>
                <input id="signup-email" name="email" type="email" maxlength="254" required autocomplete="email" value="${htmlEscape(opts.email ?? '')}" />
              </div>${widget}
              <div class="signup-hp" aria-hidden="true">
                <label for="signup-fax">Fax</label>
                <input id="signup-fax" name="fax" type="text" tabindex="-1" aria-hidden="true" autocomplete="one-time-code" />
              </div>
              <div class="signup-submit">
                <button class="btn btn-inverse" type="submit">Email me a sign-up link</button>
                <a class="signin-inverse" href="/admin">Already have an account? Sign in</a>
              </div>
            </form>`;
}

/** The widget's loader, emitted only on /signup and only when a site key is configured. */
export const TURNSTILE_SCRIPT_TAG = `<script src="${TURNSTILE_SCRIPT_ORIGIN}/turnstile/v0/api.js" async defer></script>`;
