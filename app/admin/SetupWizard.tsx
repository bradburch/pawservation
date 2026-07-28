import { useEffect, useState } from 'react';
import { isValidRate, SERVICE_TEMPLATES } from '../../src/shared/index.js';
import { IconPaw, SERVICE_ICONS } from '../shared-ui/icons';
import { ApiError } from '../shared-ui/api.js';
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
 * as there). Rendered only for per-walk/per-visit presets: the server rejects time windows on
 * non-duration services ("only services with timed options can have a time window"), and capacity for
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
        Pickup window (optional)
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
  connectCalendar,
  onClose,
  onApplied,
  mode = 'full',
}: {
  settings: Settings;
  slug: string;
  token: string;
  /** App.tsx's throwing connect wrapper: opens the OAuth popup + polls; rejects on a failed
   * start (503 when server OAuth env is unset) so step 4 can render its disabled note. */
  connectCalendar: () => Promise<void>;
  onClose: () => void;
  /** Reloads the dashboard's settings after the wizard writes (same as addService's refresh). */
  onApplied: () => Promise<void>;
  /** 'full' = profile → services → prices → calendar → done (the auto-open flow for a
   * brand-new tenant); 'services' = services → prices → done — the Services & Rates
   * "Quick setup" button, which must not re-walk profile or calendar. */
  mode?: 'full' | 'services';
}) {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(mode === 'services' ? 2 : 1);
  // The DRAFT prefills a missing contact email with the admin's own login email (the address the
  // sitter signed up with) — profileInitial below keeps the RAW settings value, so the prefill
  // still diffs in profilePutBody and actually gets saved on Next. The sitter SEES it in the
  // labelled field first: this is a suggestion to confirm, never a silent publish (ContactEmail
  // is public — see createTenantFromSignup, which deliberately leaves it NULL).
  //
  // Gated on "no service is enabled yet" — the same un-onboarded signal App.tsx uses to
  // auto-open this wizard. Without the gate, a sitter who deliberately CLEARED their contact
  // email would get their login address written back every time they reopened Quick setup.
  const neverOnboarded = settings.services.every((s) => !s.enabled);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(() => ({
    ...makeProfileDraft(settings),
    contactEmail: settings.contactEmail ?? (neverOnboarded ? (settings.adminEmail ?? '') : ''),
  }));
  // Snapshot the profile PUT diffs against; advanced to the saved draft after each successful
  // save so Back-then-Next doesn't resend fields (resending is harmless, just noisy).
  const [profileInitial, setProfileInitial] = useState<ProfileDraft>(() =>
    makeProfileDraft(settings),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  // Opt-in customization (v2 spec): per-preset REPLACEMENT option payloads, edited via the
  // step-3 "Customize" disclosure. Keyed by preset id; absent = the stock preset payload. These
  // exist only in memory for THIS run — an existing service's saved options are never touched
  // (alreadyPriced presets get no disclosure at all).
  const [optionEdits, setOptionEdits] = useState<Record<string, PresetOption[]>>({});

  // Step 4 (calendar): connect is in flight while awaiting the popup open; disabled flips true
  // once a start 503s (server OAuth unconfigured), swapping the Connect button for a ⚠ note.
  // Connected-vs-not is read live from settings.calendar.status (App re-passes fresh settings
  // after the popup poll's refreshCalendarStatus), so no local connected state is kept here.
  const [connecting, setConnecting] = useState(false);
  const [calendarDisabled, setCalendarDisabled] = useState(false);

  const handleConnectCalendar = async () => {
    setError('');
    setConnecting(true);
    try {
      await connectCalendar();
    } catch (e) {
      // A 503 means the server has no Google OAuth env — degrade to the disabled note. Any
      // other failure is transient; surface it inline and let the sitter retry or skip.
      if (e instanceof ApiError && e.status === 503) setCalendarDisabled(true);
      else setError(e instanceof Error ? e.message : 'Something went wrong — try again.');
    } finally {
      setConnecting(false);
    }
  };

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
  const goTo = (next: 1 | 2 | 3 | 4 | 5) => {
    setError('');
    setStep(next);
  };

  /**
   * True when a preset's EXISTING service carries an option the sitter added but hasn't priced yet
   * (`rate: ''` — see ServiceOptionForm; there is no default price). `settings` here is App's
   * STAGED draft, not server state, so an unsaved blank price is visible to the wizard. An
   * already-priced service has its options re-sent VERBATIM by `apply` below, so such an option
   * would 400 the single batched settings PUT and reject the whole run. The wizard can neither
   * send it nor invent a price for it, so it blocks on the price step instead.
   */
  const unpricedExisting = (ps: PresetState): boolean =>
    ps.existing?.options.some(
      (o) => o.rate === '' || o.petRates.some((r) => r.rate === '' || r.mixKey === ''),
    ) ?? false;

  const priceValid = (ps: PresetState): boolean => {
    if (unpricedExisting(ps)) return false;
    if (ps.alreadyPriced) return true; // keeps its current pricing — no input to validate
    // Same predicate the server enforces on the options PUT (server/lib/validation.ts re-exports
    // it) — this copy is UX only; the server still validates independently.
    return isValidRate(Number(prices[ps.preset.id]));
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
    // Nothing partial: refuse the whole run up front rather than 400-ing on a service whose
    // staged draft has an unpriced option (the Finish button is already disabled for this;
    // this guard also covers the in-place Retry path).
    const blocked = chosen.find(unpricedExisting);
    if (blocked) {
      setError(
        `${blocked.preset.label} has an option with no price yet — set it in Services & Rates and save, then run Quick setup.`,
      );
      return;
    }
    setApplying(true);
    try {
      // Phase 1 — create every missing service row, in parallel. A created-but-not-priced row
      // is harmless (disabled, no options, invisible to clients) and a Retry resolves it via
      // the "already exists" fallback below, so partial creation never strands anything.
      const results = await Promise.allSettled(
        chosen.map(async (ps): Promise<{ ps: PresetState; type: string }> => {
          if (ps.existing) return { ps, type: ps.existing.type };
          try {
            const created = await adminFetch<{ type: string }>(
              token,
              `/api/${slug}/admin/services`,
              {
                method: 'POST',
                body: JSON.stringify({ template: ps.preset.template, label: ps.preset.label }),
              },
            );
            return { ps, type: created.type };
          } catch (e) {
            // Slugs are deterministic, so "already exists" means the row appeared since our
            // settings snapshot (an earlier partial run, another tab) — enabling it is exactly
            // what a re-run should do. Anything else fails the run, named per preset.
            if (e instanceof Error && e.message.includes('already exists'))
              return { ps, type: ps.preset.createdSlug };
            throw new Error(
              `${ps.preset.label}: ${e instanceof Error ? e.message : 'could not be created'}`,
            );
          }
        }),
      );
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length > 0) {
        // ONE report at the end of the run, covering every failure.
        setError(failures.map((f) => (f.reason as Error).message).join(' '));
        return;
      }
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ ps: PresetState; type: string }> =>
          r.status === 'fulfilled',
      );
      // Phase 2 — ONE settings PUT carrying every chosen service. The server validates the
      // whole body before writing anything (pinned by the admin.test.ts atomic-validation and
      // batch-contract tests), so a rejection leaves no service half-applied.
      const services = fulfilled.map(({ value: { ps, type } }) => {
        const rate = Number(prices[ps.preset.id]);
        const options: ServiceOptionForm[] = ps.alreadyPriced
          ? ps.existing!.options // never overwrite existing options/prices — re-sent verbatim
          : presetOptions(ps.preset).map((o) => ({ ...o, rate, petRates: [] }));
        return { type, enabled: true, options };
      });
      await adminFetch(token, `/api/${slug}/admin/settings`, {
        method: 'PUT',
        body: JSON.stringify({ services }),
      });
      await onApplied();
      goTo(mode === 'services' ? 5 : 4);
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
                    <strong>
                      {on && (
                        <span className="pb-tile-check" aria-hidden="true">
                          ✓{' '}
                        </span>
                      )}
                      {preset.label}
                    </strong>
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
              {mode === 'full' && (
                <button
                  type="button"
                  className="pb-wizard-back"
                  disabled={applying}
                  onClick={() => goTo(1)}
                >
                  Back
                </button>
              )}
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
              &amp; Rates.
            </p>
            {chosen.map((ps) => (
              <div key={ps.preset.id} className="pb-wizard-price">
                <strong>{ps.preset.label}</strong>
                <span className="pb-hint">{ps.preset.summary}</span>
                {unpricedExisting(ps) ? (
                  <span className="pb-error">
                    An option here has no price yet — set it in Services &amp; Rates and save first.
                  </span>
                ) : ps.alreadyPriced ? (
                  <span className="pb-hint">Keeps its current pricing</span>
                ) : (
                  <label className="pb-inline">
                    $
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      aria-invalid={
                        (prices[ps.preset.id] ?? '') !== '' &&
                        !isValidRate(Number(prices[ps.preset.id]))
                      }
                      value={prices[ps.preset.id] ?? ''}
                      onChange={(e) =>
                        setPrices((cur) => ({ ...cur, [ps.preset.id]: e.target.value }))
                      }
                    />
                    /{SERVICE_TEMPLATES[ps.preset.template].rateUnit}
                  </label>
                )}
                {!ps.alreadyPriced &&
                  ['visit', 'walk'].includes(SERVICE_TEMPLATES[ps.preset.template].rateUnit) && (
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
              </div>
            ))}
            {applying && (
              <p className="pb-hint" role="status">
                Setting up your services…
              </p>
            )}
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
            <h2>Connect your calendar</h2>
            {calendarDisabled ? (
              <p className="pb-hint">
                ⚠ Calendar sync isn&rsquo;t set up on this server. You can finish setup now and
                connect a calendar later from Connected apps.
              </p>
            ) : settings.calendar.status === 'connected' ? (
              <p>
                <span className="pb-chip pb-chip-ok">Connected</span> New bookings will sync to your
                Google Calendar automatically.
              </p>
            ) : (
              <>
                <p>
                  Connect Google Calendar so new bookings land on the calendar you already use — or,
                  from Connected apps afterwards, on a separate pet calendar Pawservation makes for
                  you. Whichever calendar you connect, anything already on it blocks matching
                  booking requests — the pet calendar keeps that to pet stuff instead of your whole
                  personal calendar.
                </p>
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => void handleConnectCalendar()}
                >
                  {connecting ? 'Connecting…' : 'Connect Google Calendar'}
                </button>
              </>
            )}
            {error && <p className="pb-error">{error}</p>}
            <div className="pb-wizard-nav">
              {settings.calendar.status === 'connected' ? (
                <button type="button" onClick={() => goTo(5)}>
                  Continue
                </button>
              ) : (
                <button type="button" className="pb-wizard-skip" onClick={() => goTo(5)}>
                  Skip
                </button>
              )}
              <button type="button" className="pb-wizard-back" onClick={() => goTo(3)}>
                Back
              </button>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <h2>You&rsquo;re bookable!</h2>
            <p>Fine-tune options, capacities, and questions anytime in Services &amp; Rates.</p>
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
