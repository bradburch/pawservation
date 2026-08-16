import { DEFAULT_TIMEZONE } from '../../../src/shared/index.js';
import { IconStore } from '../../shared-ui/icons';
import type { SettingsSectionProps } from '../shared.js';
import { Hint } from '../Hint';
import { TIMEZONES } from '../timezones.js';
import { blockNegativeNumberKeys, clampNullableNumber } from './fields.js';

export function BusinessSection({
  settings,
  setSettings,
  dirty,
  saveBlocked,
  onSave,
}: SettingsSectionProps & {
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
            day. This is the exception you allow for <em>handovers</em> — a boarding that starts as
            a house sit wraps up, or the other way round. It only ever covers a day one stay is
            leaving on as the other arrives, so a boarding can never sit in the middle of a house
            sit however high you set this.
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
      <div className="pb-inline-save">
        <button type="button" disabled={!dirty || saveBlocked} onClick={onSave}>
          Save changes
        </button>
        {!dirty && <span className="pb-hint">All changes saved</span>}
      </div>
    </>
  );
}
