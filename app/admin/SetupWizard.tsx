import { useEffect, useState } from 'react';
import { IconPaw, SERVICE_ICONS } from '../shared-ui/icons';
import { SERVICE_PRESETS, type ServicePreset } from './presets.js';
import { adminFetch, type ServiceOptionForm, type Settings } from './shared.js';

/**
 * 3-step quick-setup wizard (spec: docs/superpowers/specs/2026-07-18-onboarding-wizard-design.md).
 * Frontend-only, over the same endpoints Services & rates uses. Additive semantics: it never
 * disables a service and never overwrites an existing service's options or prices.
 */

type PresetState = {
  preset: ServicePreset;
  existing: Settings['services'][number] | undefined;
  /** Enabled already — rendered as on and not selectable (re-runs are additive only). */
  alreadyOn: boolean;
  /** Has options — selecting it enables it with its EXISTING options; no price input. */
  alreadyPriced: boolean;
};

export function SetupWizard({
  settings,
  slug,
  token,
  onClose,
  onApplied,
}: {
  settings: Settings;
  slug: string;
  token: string;
  onClose: () => void;
  /** Reloads the dashboard's settings after the wizard writes (same as addService's refresh). */
  onApplied: () => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  // Presets fully applied in THIS wizard run — an in-place Retry after a failure skips them.
  const [applied, setApplied] = useState<string[]>([]);

  // Escape closes the dialog (same as Skip for now), except mid-apply — matching the
  // Skip button, which is also disabled while a run is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [applying, onClose]);

  const states: PresetState[] = SERVICE_PRESETS.map((preset) => {
    const existing = settings.services.find((s) => preset.matchTypes.includes(s.type));
    return {
      preset,
      existing,
      alreadyOn: existing?.enabled === true,
      alreadyPriced: (existing?.options.length ?? 0) > 0,
    };
  });
  const chosen = states.filter((ps) => selected.includes(ps.preset.id));

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const priceValid = (ps: PresetState): boolean => {
    if (ps.alreadyPriced) return true; // keeps its current pricing — no input to validate
    const n = Number(prices[ps.preset.id]);
    return Number.isInteger(n) && n >= 1;
  };

  const apply = async () => {
    if (applying) return;
    setError('');
    setApplying(true);
    try {
      // Sequential on purpose (spec): a failure stops here with already-applied work intact.
      for (const ps of chosen) {
        if (applied.includes(ps.preset.id)) continue;
        const { preset, existing, alreadyPriced } = ps;
        let type = existing?.type;
        if (!type) {
          try {
            const created = await adminFetch<{ type: string }>(
              token,
              `/api/${slug}/admin/services`,
              {
                method: 'POST',
                body: JSON.stringify({ template: preset.template, label: preset.label }),
              },
            );
            type = created.type;
          } catch (e) {
            // Slugs are deterministic, so "already exists" means the row appeared since our
            // settings snapshot (an earlier partial run, another tab) — enabling it is exactly
            // what a re-run should do. Anything else is a real failure.
            if (e instanceof Error && e.message.includes('already exists'))
              type = preset.createdSlug;
            else throw e;
          }
        }
        const rate = Number(prices[preset.id]);
        const options: ServiceOptionForm[] = alreadyPriced
          ? existing!.options // never overwrite existing options/prices — re-sent verbatim
          : preset.options.map((o) => ({ ...o, rate }));
        // Per-service PATCH semantics: only this service is touched; questions/limits absent
        // from the body keep their current values server-side.
        await adminFetch(token, `/api/${slug}/admin/settings`, {
          method: 'PUT',
          body: JSON.stringify({ services: [{ type, enabled: true, options }] }),
        });
        setApplied((cur) => [...cur, preset.id]);
      }
      await onApplied();
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="pb-wizard-overlay" role="dialog" aria-modal="true" aria-label="Quick setup">
      <div className="pb-wizard pb-card">
        {step === 1 && (
          <>
            <h2>What do you offer?</h2>
            <p className="pb-hint">Tap everything you offer — you can fine-tune it all later.</p>
            <div className="pb-wizard-grid">
              {states.map(({ preset, alreadyOn }) => {
                const Icon = SERVICE_ICONS[preset.icon] ?? IconPaw;
                const on = alreadyOn || selected.includes(preset.id);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`pb-wizard-cardbtn${on ? ' pb-on' : ''}`}
                    disabled={alreadyOn}
                    aria-pressed={on}
                    onClick={() => toggle(preset.id)}
                  >
                    <Icon size={20} />
                    <strong>{preset.label}</strong>
                    <span>{alreadyOn ? 'Already offered' : preset.summary}</span>
                  </button>
                );
              })}
            </div>
            <div className="pb-wizard-nav">
              <button
                type="button"
                className="pb-wizard-skip"
                disabled={applying}
                onClick={onClose}
              >
                Skip for now
              </button>
              <button type="button" disabled={selected.length === 0} onClick={() => setStep(2)}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Set your prices</h2>
            <p className="pb-hint">
              Whole dollars. Times and capacities are prefilled — change anything later in Services
              &amp; rates.
            </p>
            {chosen.map((ps) => (
              <div key={ps.preset.id} className="pb-wizard-price">
                <strong>{ps.preset.label}</strong>
                <span className="pb-hint">{ps.preset.summary}</span>
                {ps.alreadyPriced ? (
                  <span className="pb-hint">Keeps its current pricing</span>
                ) : (
                  <label className="pb-inline">
                    $
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={prices[ps.preset.id] ?? ''}
                      onChange={(e) =>
                        setPrices((cur) => ({ ...cur, [ps.preset.id]: e.target.value }))
                      }
                    />
                    /{ps.preset.rateUnit}
                  </label>
                )}
                {applied.includes(ps.preset.id) && <span className="pb-wizard-done">Added</span>}
              </div>
            ))}
            {error && <p className="pb-error">{error}</p>}
            <div className="pb-wizard-nav">
              <button
                type="button"
                className="pb-wizard-skip"
                disabled={applying}
                onClick={onClose}
              >
                Skip for now
              </button>
              <button
                type="button"
                className="pb-wizard-back"
                disabled={applying}
                onClick={() => setStep(1)}
              >
                Back
              </button>
              <button
                type="button"
                disabled={applying || !chosen.every(priceValid)}
                onClick={() => void apply()}
              >
                {applying ? 'Setting up…' : error ? 'Retry' : 'Finish setup'}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>You&rsquo;re bookable!</h2>
            <p>Fine-tune options, capacities, and questions anytime in Services &amp; rates.</p>
            <p>
              Ready to take bookings from your own site? Grab the snippet under{' '}
              <a href="#embed" onClick={onClose}>
                Your website
              </a>
              .
            </p>
            <div className="pb-wizard-nav">
              <button type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
