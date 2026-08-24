import type {
  CalendarCostBasis,
  PetRateMode,
  ServiceConstraints,
  ServiceOption,
  ServiceQuestion,
} from '../../src/shared/index.js';
import { request, type AdminBooking } from '../shared-ui/api.js';

/** Sitter-dashboard session. `role` mirrors the server's login/session responses. */
export type Session = { token: string; role: 'admin'; slug: string; displayName: string };
/** Platform-owner session — no slug: owners are instance-level (see server/lib/token.ts). */
export type OwnerSession = { token: string; role: 'owner'; email: string };
export type AnySession = Session | OwnerSession;

// `optionKey`/`id` are omitted-until-first-save on the client (the server derives/assigns them),
// so both forms widen that one field to optional relative to the shared, field-complete shape.
// `rate` additionally admits '' — a brand-new option shows an EMPTY price input the sitter must
// fill (no default price); '' on the wire fails the server's isValidRate, so an unfilled price
// can never save.
export type ServiceOptionForm = Omit<ServiceOption, 'optionKey' | 'rate'> & {
  optionKey?: string;
  rate: number | '';
  /** Species-count rates for this option ("2 dogs $60"). `''` rate = unfilled draft row —
   * blocks the save exactly like an unpriced option; the server rejects it independently. */
  petRates: { mixKey: string; rate: number | '' }[];
};
export type QuestionForm = Omit<ServiceQuestion, 'id'> & { id?: string };
export type ServiceForm = ServiceConstraints & {
  type: string;
  label: string;
  icon: string;
  /** Short blurb clients see in the widget; null/'' = show nothing (0025). */
  description: string | null;
  hasDuration: boolean;
  rateUnit: string;
  shape: 'range' | 'single';
  custom: boolean;
  enabled: boolean;
  capacityKind: 'boarding' | 'housesit' | 'none';
  maxConcurrentPets: number | null;
  /** Minimum notice in days for this service's start date; null = same-day requests OK (0004). */
  minLeadDays: number | null;
  /** Optional explicit holiday rate in the service's own unit; null = no holiday pricing. */
  holidayRate: number | '' | null;
  /** The sitter's stored choice for a pet set with no rate of its own: 'exact' refuses it,
   *  'linear' charges the option rate x the pet count. Rendered and edited here; the PRICE that
   *  results is still computed only by the server. */
  petRateMode: PetRateMode;
  /**
   * Extra-time surcharge (0009): the hours a stay normally starts and ends, plus a FLAT whole-dollar
   * fee for an arrival before / a departure after each. Null = that side is off. `''` on a fee is an
   * emptied box (normalized to null on save), the same idiom `holidayRate` uses. Edited here; the
   * fee a CLIENT is shown still only ever comes from the server's own quote.
   */
  standardArrivalTime: string | null;
  standardDepartureTime: string | null;
  earlyArrivalFee: number | '' | null;
  lateDepartureFee: number | '' | null;
  /** From the settings GET: how many stored specific-pet rates cover 2+ pets. Read-only fact
   * feeding the "multi-pet but unpriced" warning; never sent back on the PUT. */
  multiPetGroupRateCount: number;
  options: ServiceOptionForm[];
  questions: QuestionForm[];
  acceptedPetTypes: string[] | null;
  cancellationTiers: { withinDays: number; percent: number }[] | null;
};
export type ServiceTemplate = { id: string; label: string };
export type Settings = {
  displayName: string;
  accentColor: string;
  timezone: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Booking horizon in months for the whole business; null = no limit (0004). */
  maxAdvanceMonths: number | null;
  /** How many days a house sit and a BOARDING may overlap, at the tail ends only (0006).
   *  0 = never; 1 = the default; 2 = one at each end. Two HOUSE SITS are not on this scale: they
   *  may never share a night on any numbered value, because a handover day is a night both stays
   *  occupy (see `sameKindSpans` in src/shared/booking/capacity.ts). `null` switches the whole
   *  whereabouts check off, same-kind included. */
  housesitBoardingOverlapDays: number | null;
  /** How the calendar backfill reads a description `Cost:` on a BOARDING or HOUSE SIT (0013):
   *  'total' = the whole charge for the stay; 'per-night' = a nightly rate x the stay's nights.
   *  Never applies to a walk, which has no nights. Default 'total'. */
  calendarCostBasis: CalendarCostBasis;
  /** How far back one payment may reach to cover EARLIER stays, in whole days (0014). 0..90;
   *  default 14. Weekly payers ~14, monthly invoicers ~45. Never widens the window that decides
   *  the payment's own closest stay. */
  attributionSpillDays: number;
  /** The authenticated admin's own login email — wizard prefill for a missing contactEmail. */
  adminEmail: string | null;
  petTypes: { petType: string; label: string }[];
  services: ServiceForm[];
  templates: ServiceTemplate[];
  blocked: { id: string; startDate: string; endDate: string | null }[];
  calendar: {
    status: string;
    connectedAt: string | null;
    calendarId: string | null;
  };
  disabled: boolean;
};

/** Shared prop shape for sections that edit the staged, save-button-gated `settings` draft. */
export type SettingsSectionProps = {
  settings: Settings;
  setSettings: (settings: Settings) => void;
};

/**
 * The PUT `/admin/settings` request body (mirrors `SettingsBody`/`ServiceBody` in
 * server/routes/admin.ts). Built from the same shared/derived field types as `Settings` so that
 * a field added to `ServiceOption`/`ServiceQuestion`/`ServiceConstraints` — or dropped by a hand
 * mapping in `save()` — surfaces as a compile error there instead of silently going missing on
 * the wire.
 */
export type ServicePayload = ServiceConstraints & {
  type: string;
  enabled: boolean;
  description: string | null;
  maxConcurrentPets: number | null;
  minLeadDays: number | null;
  holidayRate: number | null;
  petRateMode: PetRateMode;
  standardArrivalTime: string | null;
  standardDepartureTime: string | null;
  earlyArrivalFee: number | null;
  lateDepartureFee: number | null;
  options: ServiceOptionForm[];
  questions: QuestionForm[];
  acceptedPetTypes: string[] | null;
  cancellationTiers: { withinDays: number; percent: number }[] | null;
};
export type SettingsPayload = {
  displayName: string;
  accentColor: string;
  timezone: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  maxAdvanceMonths: number | null;
  housesitBoardingOverlapDays: number | null;
  calendarCostBasis: CalendarCostBasis;
  attributionSpillDays: number;
  services: ServicePayload[];
};

/**
 * What a client owes on a booking: the stay price (or, on a cancelled row, the assessed
 * cancellation fee) PLUS every extra charge. The single balance rule for the admin app —
 * BookingsSection's row summary and the Earnings outstanding table must not each invent one.
 *
 * `estCost` is NEVER mutated by a charge. The quote promised a price; extras are separate line
 * items, summed at read time. Returns null when there is nothing to owe against.
 *
 * A cancelled booking that owes no fee is "nothing to owe against" whichever way that was
 * recorded — NULL when the sitter waived it, a real 0 when the customer cancelled themselves
 * (server/db/repo.ts's cancelBookingForUser). The two are the same event and must read the same:
 * without the normalization a fee-free customer cancel carrying a $100 deposit computes a $0
 * balance and renders "paid in full", hiding from the sitter that she is holding money to refund,
 * while the identical sitter-side cancel still says "paid $100".
 */
export function totalDue(b: AdminBooking): number | null {
  const cancelled = b.status === 'cancelled';
  const raw = cancelled ? b.cancellationFee : b.estCost;
  const base = cancelled && raw === 0 ? null : raw;
  if (base == null) return b.chargesTotal > 0 ? b.chargesTotal : null;
  return base + b.chargesTotal;
}

export function adminFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}
