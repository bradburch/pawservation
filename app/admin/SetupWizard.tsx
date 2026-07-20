import { useEffect, useState } from 'react';
import { IconPaw, SERVICE_ICONS } from '../shared-ui/icons';
import { SERVICE_PRESETS, type PresetOption, type ServicePreset } from './presets.js';
import { NullableNumberField } from './sections/fields.js';
import { adminFetch, type ServiceOptionForm, type Settings } from './shared.js';
import {
  makeProfileDraft,
  profilePutBody,
  WizardProfileStep,
  type ProfileDraft,
} from './WizardProfileStep.js';

/**
 * 4-step quick-setup wizard (specs: docs/superpowers/specs/2026-07-18-onboarding-wizard-design.md
 * + 2026-07-18-onboarding-wizard-v2-design.md — profile step + opt-in customization).
 * Frontend-only, over the same endpoints the dashboard sections use. Additive semantics: it never
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

/** One preset option's editable fields — time window, capacity, weekdays-only — mirroring the
 * Services & rates option-row idioms (the weekdays checkbox only exists while windowed, exactly
 * as there). Rendered only for per-visit presets: the server rejects time windows on
 * non-duration services ("only per-visit services can have a time window"), and capacity for
 * boarding/house-sitting capacity is a per-service setting (Services & rates), not per-option. */
function PresetOptionFields({
  option,
  onChange,
}: {
  option: PresetOption;
  onChange: (next: PresetOption) => void;
}) {
  const windowed = option.startTime !== null && option.endTime !== null;
  return (
    <div>
      <strong>{option.label}</strong>
      <div className="pb-inline">
        Window (optional)
        <input
          type="time"
          value={option.startTime ?? ''}
          onChange={(e) => onChange({ ...option, startTime: e.target.value || null })}
        />
        <input
          type="time"
          value={option.endTime ?? ''}
          onChange={(e) => onChange({ ...option, endTime: e.target.value || null })}
        />
        <NullableNumberField
          label="Capacity"
          value={option.capacity}
          onChange={(capacity) => onChange({ ...option, capacity })}
        />
        {windowed && (
          <label className="pb-inline">
            <input
              type="checkbox"
              checked={option.weekdaysOnly}
              onChange={(e) => onChange({ ...option, weekdaysOnly: e.target.checked })}
            />
            Weekdays only
          </label>
        )}
      </div>
    </div>
  );
}

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
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(() => makeProfileDraft(settings));
  // Snapshot the profile PUT diffs against; advanced to the saved draft after each successful
  // save so Back-then-Next doesn't resend fields (resending is harmless, just noisy).
  const [profileInitial, setProfileInitial] = useState<ProfileDraft>(() =>
    makeProfileDraft(settings),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  // Presets fully applied in THIS wizard run — an in-place Retry after a failure skips them.
  const [applied, setApplied] = useState<string[]>([]);

  // Opt-in customization (v2 spec): per-preset REPLACEMENT option payloads, edited via the
  // step-3 "Customize" disclosure. Keyed by preset id; absent = the stock preset payload. These
  // exist only in memory for THIS run — an existing service's saved options are never touched
  // (alreadyPriced presets get no disclosure at all).
  const [optionEdits, setOptionEdits] = useState<Record<string, PresetOption[]>>({});

  /** Options the apply loop will stamp the rate onto for a preset this run. */
  const presetOptions = (preset: ServicePreset): PresetOption[] =>
    optionEdits[preset.id] ?? preset.options;

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

  // Owner directive: at most 6 TenantServices rows per tenant (server/lib/services.ts
  // MAX_SERVICES) — the server is the authority and re-checks on apply, but a preset the apply
  // loop would try to CREATE (no `existing` row — see PresetState above) must not be selectable
  // once the tenant is projected to be at the cap, or the apply loop 400s partway through.
  // Presets that only enable/price an ALREADY-EXISTING row never create anything, so they're
  // never gated here.
  const wouldCreateCount = states.filter(
    (ps) => selected.includes(ps.preset.id) && !ps.existing,
  ).length;
  const atCap = settings.services.length + wouldCreateCount >= 6;

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // Step navigation clears any stale error so e.g. a step-1 validation message can't linger
  // over the price step.
  const goTo = (next: 1 | 2 | 3 | 4) => {
    setError('');
    setStep(next);
  };

  const priceValid = (ps: PresetState): boolean => {
    if (ps.alreadyPriced) return true; // keeps its current pricing — no input to validate
    const n = Number(prices[ps.preset.id]);
    return Number.isInteger(n) && n >= 1;
  };

  // Step 1 → 2: PUT only the changed profile fields — nothing changed means no request at all
  // (spec) — so a server validation error ("Unknown timezone.", "Display name required.") lands
  // while the sitter is still on the step.
  const saveProfile = async () => {
    if (applying) return;
    setError('');
    const body = profilePutBody(profileInitial, profileDraft);
    if (!body) {
      setStep(2);
      return;
    }
    setApplying(true);
    try {
      await adminFetch(token, `/api/${slug}/admin/settings`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      // Sync the dashboard (topbar name, Business/Pets sections) — otherwise its stale draft
      // would revert this write on the sitter's next "Save settings". Same refresh apply() uses.
      await onApplied();
      setProfileInitial(profileDraft);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.');
    } finally {
      setApplying(false);
    }
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
          : presetOptions(preset).map((o) => ({ ...o, rate }));
        // Per-service PATCH semantics: only this service is touched; questions/limits absent
        // from the body keep their current values server-side.
        await adminFetch(token, `/api/${slug}/admin/settings`, {
          method: 'PUT',
          body: JSON.stringify({ services: [{ type, enabled: true, options }] }),
        });
        setApplied((cur) => [...cur, preset.id]);
      }
      await onApplied();
      setStep(4);
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
            <WizardProfileStep draft={profileDraft} setDraft={setProfileDraft} />
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
              <button type="button" disabled={applying} onClick={() => void saveProfile()}>
                {applying ? 'Saving…' : 'Next'}
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>What do you offer?</h2>
            <p className="pb-hint">Tap everything you offer — you can fine-tune it all later.</p>
            <div className="pb-wizard-grid">
              {states.map(({ preset, existing, alreadyOn }) => {
                const Icon = SERVICE_ICONS[preset.icon] ?? IconPaw;
                const isSelected = selected.includes(preset.id);
                const on = alreadyOn || isSelected;
                // Only an unselected preset that would CREATE a new row is blocked by the cap —
                // selecting one that just enables/prices an existing row never adds a row.
                const blockedByCap = !existing && !isSelected && atCap;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`pb-tile-btn pb-wizard-cardbtn${on ? ' pb-on' : ''}`}
                    disabled={alreadyOn || blockedByCap}
                    aria-pressed={on}
                    onClick={() => toggle(preset.id)}
                  >
                    <Icon size={20} />
                    <strong>{preset.label}</strong>
                    <span>
                      {alreadyOn
                        ? 'Already offered'
                        : blockedByCap
                          ? 'You can offer up to 6 services'
                          : preset.summary}
                    </span>
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
              <button
                type="button"
                className="pb-wizard-back"
                disabled={applying}
                onClick={() => goTo(1)}
              >
                Back
              </button>
              <button type="button" disabled={selected.length === 0} onClick={() => goTo(3)}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 3 && (
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
                {!ps.alreadyPriced && ps.preset.rateUnit === 'visit' && (
                  <details className="pb-wizard-custom">
                    <summary>Customize</summary>
                    {presetOptions(ps.preset).map((o, oi) => (
                      <PresetOptionFields
                        key={oi}
                        option={o}
                        onChange={(next) => {
                          const options = [...presetOptions(ps.preset)];
                          options[oi] = next;
                          setOptionEdits((cur) => ({ ...cur, [ps.preset.id]: options }));
                        }}
                      />
                    ))}
                  </details>
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
                onClick={() => goTo(2)}
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

        {step === 4 && (
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
