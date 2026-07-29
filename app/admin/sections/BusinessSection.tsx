import { DEFAULT_TIMEZONE } from '../../../src/shared/index.js';
import { IconStore } from '../../shared-ui/icons';
import type { SettingsSectionProps } from '../shared.js';
import { Hint } from '../Hint';
import { TIMEZONES } from '../timezones.js';

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
        <IconStore size={18} /> Your business
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
          How far ahead clients can book <span className="pb-hint">(months, blank = no limit)</span>
          <Hint label="How far ahead clients can book">
            One limit for your whole business. Set it to 8 and nobody can request a date more than 8
            months from today — days past that simply can&rsquo;t be picked. Each service can also
            require notice (&ldquo;days of notice needed&rdquo; under Services &amp; Rates).
          </Hint>
        </span>
        <input
          type="number"
          min={1}
          max={24}
          aria-label="How far ahead clients can book, in months (blank = no limit)"
          aria-invalid={
            settings.maxAdvanceMonths !== null &&
            (!Number.isInteger(settings.maxAdvanceMonths) ||
              settings.maxAdvanceMonths < 1 ||
              settings.maxAdvanceMonths > 24)
          }
          value={settings.maxAdvanceMonths ?? ''}
          onChange={(e) =>
            setSettings({
              ...settings,
              maxAdvanceMonths: e.target.value === '' ? null : Number(e.target.value),
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
      <div className="pb-inline-save">
        <button type="button" disabled={!dirty || saveBlocked} onClick={onSave}>
          Save changes
        </button>
        {!dirty && <span className="pb-hint">All changes saved</span>}
      </div>
    </>
  );
}
