import { htmlEscape } from './email';

/**
 * Renders the invite-request `<form>` — shared between the landing page (server/index.ts, called
 * with no values) and the POST /request-invite 400 re-render (routes/invite-request.ts, called
 * with the submitter's own values echoed back per the spec's "values NOT lost" line). A leaf
 * module (no imports from index.ts or routes/*) so both can import it without a circular import
 * — the same reason PAGE_STYLE lives in its own file.
 *
 * The honeypot field is named "fax" (not "website" — a classic non-autofilled decoy name) and is
 * never prefilled, even on a re-render: a submission only reaches renderErrorPage after the
 * honeypot check already passed, so there is nothing legitimate to echo there.
 */
export type InviteFormValues = Partial<{
  business: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  neighborhoods: string;
  services: string;
  customerCount: string;
  notes: string;
}>;

const CUSTOMER_COUNT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Choose one' },
  { value: '0', label: 'Just starting out' },
  { value: '1-5', label: '1&ndash;5' },
  { value: '6-15', label: '6&ndash;15' },
  { value: '16-50', label: '16&ndash;50' },
  { value: '50+', label: '50+' },
];

export function renderInviteForm(values: InviteFormValues = {}): string {
  const esc = (v: string | undefined) => htmlEscape(v ?? '');
  const selectedCount = values.customerCount ?? '';
  const options = CUSTOMER_COUNT_OPTIONS.map(
    (opt) =>
      `<option value="${opt.value}"${opt.value === selectedCount ? ' selected' : ''}>${opt.label}</option>`,
  ).join('\n                  ');

  return `<form class="invite-form" method="post" action="/request-invite">
              <div class="invite-field">
                <label for="inv-business">Business name</label>
                <input id="inv-business" name="business" type="text" maxlength="120" required autocomplete="organization" value="${esc(values.business)}" />
              </div>
              <div class="invite-field">
                <label for="inv-name">Your name</label>
                <input id="inv-name" name="name" type="text" maxlength="80" required autocomplete="name" value="${esc(values.name)}" />
              </div>
              <div class="invite-field">
                <label for="inv-email">Email</label>
                <input id="inv-email" name="email" type="email" maxlength="254" required autocomplete="email" value="${esc(values.email)}" />
              </div>
              <div class="invite-field">
                <label for="inv-phone">Phone <span class="invite-optional">(optional)</span></label>
                <input id="inv-phone" name="phone" type="tel" maxlength="40" autocomplete="tel" value="${esc(values.phone)}" />
              </div>
              <div class="invite-field">
                <label for="inv-city">City</label>
                <input id="inv-city" name="city" type="text" maxlength="80" required autocomplete="address-level2" value="${esc(values.city)}" />
              </div>
              <div class="invite-field">
                <label for="inv-neighborhoods">Neighborhoods you cover <span class="invite-optional">(optional)</span></label>
                <input id="inv-neighborhoods" name="neighborhoods" type="text" maxlength="200" value="${esc(values.neighborhoods)}" />
              </div>
              <div class="invite-field invite-field-wide">
                <label for="inv-services">Services you offer</label>
                <input id="inv-services" name="services" type="text" maxlength="200" required placeholder="Boarding, dog walking, drop-in visits&hellip;" value="${esc(values.services)}" />
              </div>
              <div class="invite-field">
                <label for="inv-customerCount">Roughly how many clients?</label>
                <select id="inv-customerCount" name="customerCount" required>
                  ${options}
                </select>
              </div>
              <div class="invite-field invite-field-wide">
                <label for="inv-notes">Anything else? <span class="invite-optional">(optional)</span></label>
                <textarea id="inv-notes" name="notes" maxlength="500" rows="3">${esc(values.notes)}</textarea>
              </div>
              <div class="invite-hp" aria-hidden="true">
                <label for="inv-fax">Fax</label>
                <input id="inv-fax" name="fax" type="text" tabindex="-1" aria-hidden="true" autocomplete="one-time-code" />
              </div>
              <div class="invite-submit">
                <button class="btn btn-inverse" type="submit">Ask for an invite</button>
                <a class="signin-inverse" href="/admin">Already have an account? Sign in</a>
              </div>
            </form>`;
}
