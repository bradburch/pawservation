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
  /**
   * HER PLAN, read-only (0017, Story 10.3). Published by the settings GET and never sent back:
   * `save()` in App.tsx builds its PUT body field by field rather than spreading this object, so
   * these five cannot reach the wire; and the sticky-save `dirty` check compares the whole object
   * against the saved snapshot, so five fields that change only on a reload can never make the
   * save bar appear. Both facts are why a read-only field is allowed to live on this type at all.
   */
  plan: 'solo' | 'pro' | null;
  /** What the subscription has paid through, in the stored 'YYYY-MM-DD HH:MM:SS' UTC shape,
   *  verbatim. Rendered, never compared — `planActive` is the derived answer. */
  billedUntil: string | null;
  /** `isSoloActive`'s answer, computed on the server. The dashboard must not re-derive it. */
  planActive: boolean;
  /**
   * She has an account at the processor: a non-empty `StripeCustomerId`. One HALF of the Manage-plan
   * gate, never the whole of it — `planActive` is the other half, because this column is written
   * once and never cleared, so it stays true for a sitter who cancelled years ago.
   *
   * True with `plan: null` is a real state (a checkout that reached the processor and stopped), and
   * in THIS repo only hand-written SQL produces it: `applyBillingEvent` writes the plan, the date and
   * the customer id in one statement, so every row the billing endpoint creates carries all three.
   */
  hasBillingAccount: boolean;
  /** OPTIONAL because the key is ABSENT, not null, for a `pawsa_` tenant access token: the server
   *  publishes it only to a password session. Absent means withheld by policy; null means no
   *  customer yet. Nothing in this repo reads it — it is mirrored so the type describes the
   *  payload it is a mirror of. */
  stripeCustomerId?: string | null;
  /** `Tenants.DisabledAt != null`, published by the same settings read. The plan panel's own source
   *  for it — not `/config`'s copy — because it arrives with the payload the panel already has, so
   *  no control can flash on for a switched-off sitter while a request is in flight. */
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
 * What a client owes on a booking IN CENTS (0015): the stay price (or, on a cancelled row, the
 * assessed cancellation fee) PLUS every extra charge. The single balance rule for the admin app —
 * BookingsSection's row summary and the Earnings outstanding table must not each invent one.
 *
 * Every term is cents, so the one addition here is cents + cents; nothing on this page divides.
 *
 * `estCostCents` is NEVER mutated by a charge. The quote promised a price; extras are separate line
 * items, summed at read time. Returns null when there is nothing to owe against.
 *
 * A cancelled booking that owes no fee is "nothing to owe against" whichever way that was
 * recorded — NULL when the sitter waived it, a real 0 when the customer cancelled themselves
 * (server/db/repo.ts's cancelBookingForUser). The two are the same event and must read the same:
 * without the normalization a fee-free customer cancel carrying a $100 deposit computes a $0
 * balance and renders "paid in full", hiding from the sitter that she is holding money to refund,
 * while the identical sitter-side cancel still says "paid $100".
 */
export function totalDueCents(b: AdminBooking): number | null {
  const cancelled = b.status === 'cancelled';
  const raw = cancelled ? b.cancellationFeeCents : b.estCostCents;
  const base = cancelled && raw === 0 ? null : raw;
  if (base == null) return b.chargesTotalCents > 0 ? b.chargesTotalCents : null;
  return base + b.chargesTotalCents;
}

/** A trailing 'Z' or a '+HH:MM'/'-HH:MM' offset — the only two ways a stamp states its zone.
 *  Tested after the normalising below, so any space in front of an offset is already gone. */
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A stored instant, rendered. `TenantAccessTokens.CreatedAt`/`LastUsedAt` and `Tenants.BilledUntil`
 * all come off SQLite's `datetime('now')` as "YYYY-MM-DD HH:MM:SS" UTC, no 'T' and no 'Z' — not
 * something every engine parses the same way unlabelled. Label it UTC ourselves before handing it
 * to `Date`, and fall back to the raw string rather than ever rendering "Invalid Date".
 *
 * The test is for a stated ZONE, not for a 'T'. "2026-09-07T12:00:00" carries a separator and no
 * zone at all, and JavaScript reads that one as LOCAL time — so keying on the 'T' would have left
 * exactly that shape unlabelled and shifted by the viewer's offset, which is the reading nobody
 * would notice was wrong.
 *
 * RENDERED IN UTC, which is the other half of labelling it UTC. The stored instant IS a UTC one, so
 * the date a sitter reads has to be its own calendar day rather than the viewer's: 00:30 on the 8th
 * is the 7th for everyone west of Greenwich, so "paid through Oct 7" for a plan that runs to the 8th
 * is a day of her plan rendered away — and the nearer the stamp sits to midnight, the smaller and
 * more confused the group of people who ever see it. `CalendarSection.tsx`'s `monthTitle` is the
 * precedent for the option.
 *
 * Shared rather than copied: the access-token panel and the plan panel render the same column
 * shape, and two formatters is one of them being wrong the day the shape moves.
 */
export function formatTimestamp(sqlDatetime: string): string {
  // Only the date/time separator becomes a 'T'. A blanket `.replace(' ', 'T')` is the first space,
  // which is the right one here — but a stamp can carry a SECOND space before its offset
  // ("2026-09-07 12:00:00 +01:00"), and that one has to go away entirely rather than turn into
  // anything, or `Date` reads the whole string as invalid and the sitter sees the raw text.
  const withT = sqlDatetime.replace(/\s+(?=\d{2}:)/, 'T').replace(/\s+(?=[+-]\d{2}:\d{2}$)/, '');
  const d = new Date(ZONED.test(withT) ? withT : `${withT}Z`);
  return Number.isNaN(d.getTime())
    ? sqlDatetime
    : d.toLocaleDateString(undefined, { timeZone: 'UTC' });
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
