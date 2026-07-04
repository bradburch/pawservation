import { DEFAULT_TIMEZONE } from '../../../src/shared/index.js';
import { IconStore } from '../../shared-ui/icons';
import type { Settings } from '../shared.js';

const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [
        'America/Los_Angeles',
        'America/Denver',
        'America/Chicago',
        'America/New_York',
        'America/Anchorage',
        'Pacific/Honolulu',
        'Europe/London',
        'Europe/Paris',
        'Australia/Sydney',
      ];

/** A nullable capacity/limit input: blank ⇒ null (no limit), a number ⇒ that value. */
function NullableNumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <label>
      {label} <span className="pb-hint">(blank = no limit)</span>
      <input
        type="number"
        min={1}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </label>
  );
}

export function BusinessSection({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: (settings: Settings) => void;
}) {
  return (
    <>
      <h2>
        <IconStore size={18} /> Your business
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
      <NullableNumberField
        label="Boarding spots per day"
        value={settings.maxBoardingPets}
        onChange={(maxBoardingPets) => setSettings({ ...settings, maxBoardingPets })}
      />
      <NullableNumberField
        label="House-sits per day"
        value={settings.maxHouseSitsPerDay}
        onChange={(maxHouseSitsPerDay) => setSettings({ ...settings, maxHouseSitsPerDay })}
      />
      <NullableNumberField
        label="Longest stay (nights)"
        value={settings.maxStayNights}
        onChange={(maxStayNights) => setSettings({ ...settings, maxStayNights })}
      />
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
    </>
  );
}
