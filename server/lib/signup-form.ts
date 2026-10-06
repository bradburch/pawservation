import { attributionInputs, type Attribution } from './attribution';
import { htmlEscape } from './email';
import { SIGNUP_ACTION, TURNSTILE_SCRIPT_ORIGIN } from './turnstile';

/**
 * The sign-up `<form>` on /signup (routes/signup-page.ts), with the widget when Turnstile is
 * configured. Every "Sign up" on the marketing pages is a plain LINK to /signup rather than a form
 * of its own: `/` is script-free under LOCKED_CSP, so a form there could not carry the widget and
 * made the sitter submit twice (once there, once on the challenge).
 *
 * The widget is Turnstile's IMPLICIT render: its script finds the `.cf-turnstile` div and adds a
 * hidden `cf-turnstile-response` input to this form, so a native form POST carries the token and
 * the page needs no script of its own. The honeypot is named "fax" (the old invite form's name).
 *
 * Where the visitor came from (`server/lib/attribution.ts`) rides as hidden fields, rendered only
 * when present and only from ALREADY-CLEANED values, so it survives the landing → /signup → widget
 * → submit hops and reaches the owner's notice.
 */
export function renderSignupForm(
  opts: {
    email?: string;
    siteKey?: string;
    submitLabel?: string;
    attribution?: Attribution;
  } = {},
): string {
  const widget = opts.siteKey
    ? `
              <div class="signup-field signup-field-wide">
                <div class="cf-turnstile" data-sitekey="${htmlEscape(opts.siteKey)}" data-action="${SIGNUP_ACTION}" data-theme="dark"></div>
              </div>`
    : '';
  return `<form class="signup-form" method="post" action="/signup">${attributionInputs(opts.attribution, htmlEscape)}
              <div class="signup-field signup-field-wide">
                <label for="signup-email">Your email</label>
                <input id="signup-email" name="email" type="email" maxlength="254" required autocomplete="email" value="${htmlEscape(opts.email ?? '')}" />
              </div>${widget}
              <div class="signup-hp" aria-hidden="true">
                <label for="signup-fax">Fax</label>
                <input id="signup-fax" name="fax" type="text" tabindex="-1" aria-hidden="true" autocomplete="one-time-code" />
              </div>
              <div class="signup-submit">
                <button class="btn btn-inverse" type="submit">${opts.submitLabel ?? 'Start my free trial'}</button>
                <a class="signin-inverse" href="/admin">Already have an account? Sign in</a>
              </div>
            </form>`;
}

/** The widget's loader, emitted only on /signup and only when a site key is configured. */
export const TURNSTILE_SCRIPT_TAG = `<script src="${TURNSTILE_SCRIPT_ORIGIN}/turnstile/v0/api.js" async defer></script>`;
