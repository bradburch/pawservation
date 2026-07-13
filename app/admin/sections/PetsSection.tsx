import { IconPaw } from '../../shared-ui/icons';
import type { SettingsSectionProps } from '../shared.js';

export function PetsSection({ settings, setSettings }: SettingsSectionProps) {
  return (
    <>
      <h2>
        <IconPaw size={18} /> Pets you care for
      </h2>
      <p className="pb-hint">
        Which types of pets you accept. Your clients&apos; individual pets live under Clients.
      </p>
      {settings.petTypes.map((p, i) => (
        <label className="pb-inline" key={p.petType}>
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => {
              const petTypes = [...settings.petTypes];
              petTypes[i] = { ...p, enabled: e.target.checked };
              setSettings({ ...settings, petTypes });
            }}
          />
          {p.petType === 'dog' ? 'Dogs' : 'Cats'}
        </label>
      ))}
    </>
  );
}
