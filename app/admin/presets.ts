import { type ServiceOption, type TemplateId } from '../../src/shared/index.js';

/** Option payload prefilled by a preset; the wizard adds the sitter's `rate` and the server
 * derives `optionKey` (and window duration) on save. */
export type PresetOption = Omit<ServiceOption, 'optionKey' | 'rate'>;

export type ServicePreset = {
  /** Stable preset id (also the expected slug for the three walk clones). */
  id: string;
  /** SERVICE_TEMPLATES id sent to POST /api/:slug/admin/services when the row must be created. */
  template: TemplateId;
  /** Service label sent on create (its server-derived slug is `createdSlug`). */
  label: string;
  /** One-line card copy for the wizard's step 1. */
  summary: string;
  /** Widget icon key (matches the template's icon). */
  icon: string;
  /** The slug POST /services derives from `label` — used when a create collides ("already
   * exists") so a retry can proceed against the existing row deterministically. */
  createdSlug: string;
  /** Existing service slugs that count as "this preset is already set up" for a tenant:
   * the built-in template id (seeded tenants) and/or the label-derived slug (wizard-created). */
  matchTypes: string[];
  /** Options written ONLY when the matched service has no options yet (additive semantics). */
  options: PresetOption[];
};

const anyDay = {
  durationMinutes: null,
  startTime: null,
  endTime: null,
  capacity: null,
  weekdaysOnly: false,
};

/** The 6 one-tap presets from docs/superpowers/specs/2026-07-18-onboarding-wizard-design.md.
 * The walk pair come from the docs/specs/*.md stubs (weekdays-only group/solo walks); the last
 * four simply enable the built-in template behaviors. The unit shown next to a price input is not
 * stored here — the wizard reads it from SERVICE_TEMPLATES[preset.template].rateUnit, the same
 * object the server stamps onto the row it creates, so the two can't drift.
 *
 * There is exactly ONE pack-walk preset. A sitter who runs more than one pack per day adds the
 * extra window as a second OPTION on that same service under Services & Rates (up to
 * MAX_OPTIONS_PER_SERVICE), which is the general form of what a separate "Multiple Pack Walks"
 * preset used to hardcode as a whole second service row — and it kept the picker offering two
 * near-identical tiles for one offering. */
export const SERVICE_PRESETS: ServicePreset[] = [
  {
    id: 'pack-walks',
    template: 'walk',
    label: 'Pack Walks',
    summary: 'Group walks · weekdays 10–2 · up to 8 pets',
    icon: 'paw',
    createdSlug: 'pack-walks',
    // The retired "Multiple Pack Walks" preset's slugs are matched here so a tenant who set that
    // up before the consolidation is still recognised as offering pack walks — otherwise the
    // wizard would stop seeing their service and create a second walk row beside it.
    matchTypes: ['pack-walks', 'multi-pack-walks', 'multiple-pack-walks'],
    options: [
      {
        label: 'Pack walk',
        durationMinutes: null, // server derives from the window
        startTime: '10:00',
        endTime: '14:00',
        capacity: 8,
        weekdaysOnly: true,
      },
    ],
  },
  {
    id: 'solo-walker',
    template: 'walk',
    label: 'Solo Walks',
    summary: 'One-on-one walks · weekdays 10–4 · up to 4 pets',
    icon: 'paw',
    createdSlug: 'solo-walks',
    // Old slug kept so tenants who created the service under the previous label still match.
    matchTypes: ['solo-walker', 'solo-walks'],
    options: [
      {
        label: 'Solo walk',
        durationMinutes: null,
        startTime: '10:00',
        endTime: '16:00',
        capacity: 4,
        weekdaysOnly: true,
      },
    ],
  },
  {
    id: 'boarding',
    template: 'boarding',
    label: 'Boarding',
    summary: 'Overnight stays at your place · priced per night',
    icon: 'bed',
    createdSlug: 'boarding',
    matchTypes: ['boarding'],
    options: [{ label: 'Standard', ...anyDay }],
  },
  {
    id: 'housesitting',
    template: 'housesitting',
    label: 'House sitting',
    summary: "You stay at the client's home · priced per night",
    icon: 'home',
    createdSlug: 'house-sitting',
    matchTypes: ['housesitting', 'house-sitting'],
    options: [{ label: 'Standard', ...anyDay }],
  },
  {
    id: 'daycare',
    template: 'daycare',
    label: 'Daycare',
    summary: 'Daytime care at your place · priced per day',
    icon: 'sun',
    createdSlug: 'daycare',
    matchTypes: ['daycare', 'day-care'],
    options: [{ label: 'Standard', ...anyDay }],
  },
  {
    id: 'checkin',
    template: 'checkin',
    label: 'Check-in',
    summary: 'Quick 30-minute drop-in visits · priced per visit',
    icon: 'clipboard',
    createdSlug: 'check-in',
    // Old slug kept so tenants who created the service under the previous label still match.
    matchTypes: ['checkin', 'check-ins', 'check-in'],
    // checkin is a per-duration template with no stock option, so the preset supplies the same
    // 30-minute starter the Services section's "Add an option" button uses.
    options: [{ ...anyDay, label: '30 min', durationMinutes: 30 }],
  },
];
