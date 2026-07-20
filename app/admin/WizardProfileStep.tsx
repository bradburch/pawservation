import { DEFAULT_TIMEZONE } from '../../src/shared/index.js';
import type { Settings, SettingsPayload } from './shared.js';
import { TIMEZONES } from './timezones.js';

/**
 * Step 1 of the setup wizard — "About your business"
 * (spec: docs/superpowers/specs/2026-07-18-onboarding-wizard-v2-design.md).
 *
 * Purely presentational: SetupWizard owns the draft state (so its single `applying` flag keeps
 * gating Skip/Escape/nav exactly as v1 did) and performs the diff-PUT built by `profilePutBody`
 * when the sitter advances to step 2. Field controls reuse the BusinessSection (name / color /
 * contact / timezone) idioms verbatim.
 */

/** The five profile fields as controlled-input state. Nullable wire fields are held as
 * ''-means-null strings — the same mapping BusinessSection applies on its live inputs. */
export type ProfileDraft = {
  displayName: string;
  contactEmail: string;
  contactPhone: string;
  /** '' = use the instance default (wire value null). */
  timezone: string;
  accentColor: string;
};

export function makeProfileDraft(settings: Settings): ProfileDraft {
  return {
    displayName: settings.displayName,
    contactEmail: settings.contactEmail ?? '',
    contactPhone: settings.contactPhone ?? '',
    timezone: settings.timezone ?? '',
    accentColor: settings.accentColor,
  };
}

/**
 * PATCH body for PUT /admin/settings containing ONLY the fields that differ from `initial`
 * (absent fields keep their server-side values), or null when nothing changed — the caller then
 * sends no PUT at all (the common case on a wizard re-run, which just shows current values).
 */
export function profilePutBody(
  initial: ProfileDraft,
  draft: ProfileDraft,
): Partial<SettingsPayload> | null {
  const body: Partial<SettingsPayload> = {};
  if (draft.displayName !== initial.displayName) body.displayName = draft.displayName;
  if (draft.contactEmail !== initial.contactEmail) body.contactEmail = draft.contactEmail || null;
  if (draft.contactPhone !== initial.contactPhone) body.contactPhone = draft.contactPhone || null;
  if (draft.timezone !== initial.timezone) body.timezone = draft.timezone || null;
  if (draft.accentColor !== initial.accentColor) body.accentColor = draft.accentColor;
  return Object.keys(body).length > 0 ? body : null;
}

export function WizardProfileStep({
  draft,
  setDraft,
}: {
  draft: ProfileDraft;
  setDraft: (draft: ProfileDraft) => void;
}) {
  return (
    <>
      <h2>About your business</h2>
      <p className="pb-hint">
        This is what clients see on your booking page — change any of it later under Business.
      </p>
      <label>
        Business name
        <input
          value={draft.displayName}
          onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
        />
      </label>
      <label>
        Contact email
        <input
          type="email"
          placeholder="you@example.com"
          value={draft.contactEmail}
          onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })}
        />
      </label>
      <label>
        Contact phone <span className="pb-hint">(optional)</span>
        <input
          type="tel"
          placeholder="(555) 555-0123"
          value={draft.contactPhone}
          onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })}
        />
      </label>
      <label>
        Your time zone
        <select
          value={draft.timezone}
          onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
        >
          <option value="">Use {DEFAULT_TIMEZONE} (default)</option>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>
      <p className="pb-hint">
        Pet types you accept are managed under Pets, and per service under Services.
      </p>
      <label>
        Brand color
        <input
          type="color"
          value={draft.accentColor}
          onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })}
        />
      </label>
    </>
  );
}
