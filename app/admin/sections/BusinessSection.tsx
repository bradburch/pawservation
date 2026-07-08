import { DEFAULT_TIMEZONE } from '../../../src/shared/index.js';
import { IconStore } from '../../shared-ui/icons';
import type { SettingsSectionProps } from '../shared.js';
import { NullableNumberField } from './fields.js';

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

export function BusinessSection({ settings, setSettings }: SettingsSectionProps) {
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
