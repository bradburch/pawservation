import { IconTag } from '../../shared-ui/icons';
import type { ServiceForm, Settings } from '../shared.js';

export function ServicesSection({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: (settings: Settings) => void;
}) {
  return (
    <>
      <h2>
        <IconTag size={18} /> Services &amp; rates
      </h2>
      {settings.services.map((s, si) => {
        const setService = (next: ServiceForm) => {
          const services = [...settings.services];
          services[si] = next;
          setSettings({ ...settings, services });
        };
        return (
          <div className="pb-service" key={s.type}>
            <label className="pb-inline">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => setService({ ...s, enabled: e.target.checked })}
              />
              {s.label}
            </label>
            {!s.hasDuration ? (
              <label className="pb-inline">
                $
                <input
                  type="number"
                  min={1}
                  value={s.options[0]?.rate ?? 0}
                  onChange={(e) =>
                    setService({
                      ...s,
                      options: [
                        {
                          label: 'Standard',
                          durationMinutes: null,
                          rate: Number(e.target.value),
                        },
                      ],
                    })
                  }
                />
                /{s.rateUnit}
              </label>
            ) : (
              <div className="pb-options">
                {s.options.map((o, oi) => (
                  <div className="pb-inline" key={oi}>
                    <input
                      type="number"
                      min={1}
                      placeholder="min"
                      value={o.durationMinutes ?? 0}
                      onChange={(e) => {
                        const options = [...s.options];
                        options[oi] = {
                          ...o,
                          durationMinutes: Number(e.target.value),
                          label: `${e.target.value} min`,
                        };
                        setService({ ...s, options });
                      }}
                    />
                    min · $
                    <input
                      type="number"
                      min={1}
                      value={o.rate}
                      onChange={(e) => {
                        const options = [...s.options];
                        options[oi] = { ...o, rate: Number(e.target.value) };
                        setService({ ...s, options });
                      }}
                    />
                    /{s.rateUnit}
                    <button
                      onClick={() =>
                        setService({
                          ...s,
                          options: s.options.filter((_, k) => k !== oi),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() =>
                    setService({
                      ...s,
                      options: [...s.options, { label: '30 min', durationMinutes: 30, rate: 20 }],
                    })
                  }
                >
                  Add duration
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
