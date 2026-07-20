import type { ServiceOption } from '../../src/shared/index.js';

/** Option payload prefilled by a preset; the wizard adds the sitter's `rate` and the server
 * derives `optionKey` (and window duration) on save. */
export type PresetOption = Omit<ServiceOption, 'optionKey' | 'rate'>;

export type ServicePreset = {
  /** Stable preset id (also the expected slug for the three walk clones). */
  id: string;
  /** SERVICE_TEMPLATES id sent to POST /api/:slug/admin/services when the row must be created. */
  template: 'boarding' | 'housesitting' | 'daycare' | 'walk' | 'checkin';
  /** Service label sent on create (its server-derived slug is `createdSlug`). */
  label: string;
  /** One-line card copy for the wizard's step 1. */
  summary: string;
  /** Widget icon key (matches the template's icon). */
  icon: string;
  /** Fixed by the template; shown next to the price input ("$30 /visit"). */
  rateUnit: 'night' | 'day' | 'visit';
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

/** The 7 one-tap presets from docs/superpowers/specs/2026-07-18-onboarding-wizard-design.md.
 * The walk trio come from the docs/specs/*.md stubs (weekdays-only group/solo walks); the last
 * four simply enable the built-in template behaviors. */
export const SERVICE_PRESETS: ServicePreset[] = [
  {
    id: 'pack-walks',
    template: 'walk',
    label: 'Pack Walks',
    summary: 'Group walks · weekdays 10–2 · up to 8 bookings',
    icon: 'paw',
    rateUnit: 'visit',
    createdSlug: 'pack-walks',
    matchTypes: ['pack-walks'],
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
    id: 'multi-pack-walks',
    template: 'walk',
    label: 'Multi Pack Walks',
    summary: 'Two group walks · weekdays 10–2 and 2–5 · up to 8 bookings each',
    icon: 'paw',
    rateUnit: 'visit',
    createdSlug: 'multi-pack-walks',
    matchTypes: ['multi-pack-walks'],
    options: [
      // One price is applied to both windows (the wizard sets the same rate on each).
      {
        label: 'Morning pack',
        durationMinutes: null,
        startTime: '10:00',
        endTime: '14:00',
        capacity: 8,
        weekdaysOnly: true,
      },
      {
        label: 'Afternoon pack',
        durationMinutes: null,
        startTime: '14:00',
        endTime: '17:00',
        capacity: 8,
        weekdaysOnly: true,
      },
    ],
  },
  {
    id: 'solo-walker',
    template: 'walk',
    label: 'Solo Walker',
    summary: 'One-on-one walks · weekdays 10–4 · up to 4 bookings',
    icon: 'paw',
    rateUnit: 'visit',
    createdSlug: 'solo-walker',
    matchTypes: ['solo-walker'],
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
    rateUnit: 'night',
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
    rateUnit: 'night',
    createdSlug: 'house-sitting',
    matchTypes: ['housesitting', 'house-sitting'],
    options: [{ label: 'Standard', ...anyDay }],
  },
  {
    id: 'daycare',
    template: 'daycare',
    label: 'Day care',
    summary: 'Daytime care at your place · priced per day',
    icon: 'sun',
    rateUnit: 'day',
    createdSlug: 'day-care',
    matchTypes: ['daycare', 'day-care'],
    options: [{ label: 'Standard', ...anyDay }],
  },
  {
    id: 'checkin',
    template: 'checkin',
    label: 'Check-ins',
    summary: 'Quick 30-minute drop-in visits · priced per visit',
    icon: 'clipboard',
    rateUnit: 'visit',
    createdSlug: 'check-ins',
    matchTypes: ['checkin', 'check-ins'],
    // checkin is a per-duration template with no stock option, so the preset supplies the same
    // 30-minute starter the Services section's "Add an option" button uses.
    options: [{ ...anyDay, label: '30 min', durationMinutes: 30 }],
  },
];
