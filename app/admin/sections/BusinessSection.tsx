import { DEFAULT_TIMEZONE } from '../../../src/shared/index.js';
import { IconStore } from '../../shared-ui/icons';
import type { Session, SettingsSectionProps } from '../shared.js';
import { ExportPanel } from '../ExportPanel';
import { Hint } from '../Hint';
import { TIMEZONES } from '../timezones.js';
import { blockNegativeNumberKeys, clampNullableNumber } from './fields.js';

/**
 * The reach-back choices, in the sitter's own terms — how far back ONE payment may go on covering
 * stays EARLIER than the one it matches best (`Tenants.AttributionSpillDays`, 0014). Written as
 * durations she recognises rather than as a free number box, the same way the house-sit/boarding
 * allowance above is: the useful answers are "how often do my clients pay", and there are about
 * six of those.
 *
 * The ceiling is 90 because that is already the furthest back a payment can be read as settling
 * ANY stay — beyond it there is nothing left to reach for, so a bigger number would look like a
 * setting and do nothing. 0 is a real choice, not "unset": one payment settles one stay.
 */
const REACH_BACK_LABELS: Record<number, string> = {
  0: 'Not at all — one payment settles one stay',
  7: 'About a week back',
  14: 'About two weeks back — usual if your clients pay weekly',
  30: 'About a month back',
  45: 'About six weeks back — usual if you invoice monthly',
  60: 'About two months back',
  90: 'Three months back — as far as a payment can reach',
};

/**
 * The listed choices, plus whatever this tenant actually has stored. A value set elsewhere (an API
 * call, a future finer-grained control) must still RENDER, or the select would show blank and the
 * sitter would be looking at an empty box holding a real setting.
 */
function reachBackChoices(current: number): number[] {
  return [...new Set([...Object.keys(REACH_BACK_LABELS).map(Number), current])].sort(
    (a, b) => a - b,
  );
}

export function BusinessSection({
  session,
  settings,
  setSettings,
  dirty,
  saveBlocked,
  onSave,
}: SettingsSectionProps & {
  /** Needed only by the data export, which fetches CSV bytes with the admin bearer token. */
  session: Session;
  /** True while the staged settings draft differs from the last save. */
  dirty: boolean;
  /** True while an unpriced option elsewhere blocks the settings save. */
  saveBlocked: boolean;
  /** The save bar's action, surfaced inline near the fields. */
  onSave: () => void;
}) {
  return (
    <>
      <h2>
        <IconStore size={18} /> Your Business
        <Hint label="Business">
          The basics your booking page shows clients — your name, color, and contact details.
          Changes wait until you press Save.
        </Hint>
      </h2>
      <label>
        Business name
        <input
          value={settings.displayName}
          onChange={(e) => setSettings({ ...settings, displayName: e.target.value })}
        />
      </label>
      <label>
        Brand color
        <input
          type="color"
          value={settings.accentColor}
          onChange={(e) => setSettings({ ...settings, accentColor: e.target.value })}
        />
      </label>
      <label>
        Contact email
        <input
          type="email"
          placeholder="you@example.com"
          value={settings.contactEmail ?? ''}
          onChange={(e) => setSettings({ ...settings, contactEmail: e.target.value || null })}
        />
      </label>
      <label>
        Contact phone
        <input
          type="tel"
          placeholder="(555) 555-0123"
          value={settings.contactPhone ?? ''}
          onChange={(e) => setSettings({ ...settings, contactPhone: e.target.value || null })}
        />
      </label>
      <p className="pb-hint">Shown to your clients on the booking page so they can reach you.</p>
      <label>
        Your time zone
        <select
          value={settings.timezone ?? ''}
          onChange={(e) =>
            setSettings({
              ...settings,
              timezone: e.target.value === '' ? null : e.target.value,
            })
          }
        >
          <option value="">Use {DEFAULT_TIMEZONE} (default)</option>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="pb-labelrow">
          How far ahead can clients book?{' '}
          <span className="pb-hint">(months, blank = no limit)</span>
          <Hint label="How far ahead can clients book?">
            One limit for your whole business. Set it to 8 and nobody can request a date more than 8
            months from today — days past that simply can&rsquo;t be picked. Each service can also
            require notice (&ldquo;days of notice needed&rdquo; under Services &amp; Rates).
          </Hint>
        </span>
        <input
          type="number"
          min={1}
          max={24}
          step={1}
          aria-label="How far ahead can clients book, in months (blank = no limit)"
          aria-invalid={
            settings.maxAdvanceMonths !== null &&
            (!Number.isInteger(settings.maxAdvanceMonths) ||
              settings.maxAdvanceMonths < 1 ||
              settings.maxAdvanceMonths > 24)
          }
          value={settings.maxAdvanceMonths ?? ''}
          // Clamped to this input's OWN min/max as the sitter types — `min` alone is advisory and
          // a negative/decimal month would otherwise reach the settings PUT and 400 (fields.js).
          onKeyDown={blockNegativeNumberKeys(1)}
          onChange={(e) =>
            setSettings({
              ...settings,
              maxAdvanceMonths: clampNullableNumber(e.target.value, {
                min: 1,
                max: 24,
                current: settings.maxAdvanceMonths,
              }),
            })
          }
        />
      </label>
      <label>
        <span className="pb-labelrow">
          House sitting and boarding
          <Hint label="House sitting and boarding">
            You can only be in one place, so a house sit and a boarding normally can&rsquo;t share a
            day. The numbered settings are the exception you allow for <em>handovers</em>: a
            boarding that starts as a house sit wraps up, or the other way round. They only ever
            cover a day one stay is leaving on as the other arrives, so a boarding can never sit in
            the middle of a house sit. &ldquo;No limit&rdquo; is not a larger allowance. It turns
            the check off, and the two stop being held apart at all.
          </Hint>
        </span>
        <select
          aria-label="How much house sitting and boarding may overlap"
          value={settings.housesitBoardingOverlapDays ?? ''}
          onChange={(e) =>
            setSettings({
              ...settings,
              housesitBoardingOverlapDays: e.target.value === '' ? null : Number(e.target.value),
            })
          }
        >
          <option value="0">May never overlap</option>
          <option value="1">May overlap by one handover day</option>
          <option value="2">May overlap by one handover day at each end of a stay</option>
          <option value="">No limit — I&rsquo;ll sort out any clashes myself</option>
        </select>
      </label>
      <label>
        <span className="pb-labelrow">
          When your calendar says &ldquo;Cost&rdquo;, is that per night?
          <Hint label="When your calendar says “Cost”, is that per night?">
            When we read your old Google Calendar events, some of them have a line like
            <em> Cost: 100</em>. On a <strong>boarding or house sit</strong> that could mean $100
            for the whole stay or $100 a night, and only you know which you meant &mdash; so tell us
            here and we&rsquo;ll use it every time. A three-night stay written <em>Cost: 100</em>{' '}
            comes in as <strong>$100</strong> on the first setting and <strong>$300</strong> on the
            second. <strong>Walks and drop-ins are unaffected</strong>: they have no nights, so
            their cost is always the whole charge. We start on &ldquo;the whole stay&rdquo; because
            that can only ever charge your client less than you meant, never more.
          </Hint>
        </span>
        <select
          aria-label="How to read a Cost line in a calendar description for a boarding or house sit"
          value={settings.calendarCostBasis}
          onChange={(e) =>
            setSettings({
              ...settings,
              // The two stored values, verbatim — never derived from the label text.
              calendarCostBasis: e.target.value === 'per-night' ? 'per-night' : 'total',
            })
          }
        >
          <option value="total">That&rsquo;s the price for the whole stay</option>
          <option value="per-night">
            That&rsquo;s my nightly rate &mdash; multiply by the nights
          </option>
        </select>
      </label>
      <p className="pb-hint">
        Applies to boarding and house sitting when importing past events from your calendar. Walks
        and drop-ins are never multiplied.
      </p>
      <label>
        <span className="pb-labelrow">
          How far back may one payment cover earlier stays?
          <Hint label="How far back may one payment cover earlier stays?">
            When a client sends one amount that covers several stays, we start from the stay the
            payment matches best and then work backwards through the earlier ones, so long as
            what&rsquo;s left <strong>covers each of them in full</strong>. This is how far back
            we&rsquo;ll keep going. If your clients pay <strong>weekly</strong>, about{' '}
            <strong>two weeks</strong> is right. If you <strong>invoice monthly</strong>, pick{' '}
            <strong>about six weeks</strong> &mdash; otherwise a payment for a whole month of walks
            only covers the last few, and the rest of it is left over for you to place by hand. This
            never changes <em>which</em> stay a payment matches in the first place, and nothing is
            ever attributed without you approving it.
          </Hint>
        </span>
        <select
          aria-label="How far back one payment may reach to cover earlier stays"
          value={settings.attributionSpillDays}
          onChange={(e) =>
            setSettings({ ...settings, attributionSpillDays: Number(e.target.value) })
          }
        >
          {reachBackChoices(settings.attributionSpillDays).map((days) => (
            <option key={days} value={days}>
              {REACH_BACK_LABELS[days] ?? `${days} days`}
            </option>
          ))}
        </select>
      </label>
      <div className="pb-inline-save">
        <button type="button" disabled={!dirty || saveBlocked} onClick={onSave}>
          Save changes
        </button>
        {!dirty && <span className="pb-hint">All changes saved</span>}
      </div>
      {/* Below the save bar, and deliberately in THIS section rather than beside the client
          importer in Clients: the export spans clients, pets, bookings and payments, so it belongs
          to the account rather than to any one list — and Business is where the sitter already
          comes for things that are true of her business as a whole. It saves nothing, so it sits
          past the save control rather than inside the staged-settings form. */}
      <ExportPanel session={session} />
    </>
  );
}
