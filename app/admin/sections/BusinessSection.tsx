import { DEFAULT_TIMEZONE } from '../../../src/shared/index.js';
import { IconStore } from '../../shared-ui/icons';
import type { SettingsSectionProps } from '../shared.js';
import { Hint } from '../Hint';
import { TIMEZONES } from '../timezones.js';

export function BusinessSection({ settings, setSettings }: SettingsSectionProps) {
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
    </>
  );
}
