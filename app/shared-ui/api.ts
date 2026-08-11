/** Tiny same-origin API client for the widget + admin pages. */

export { PAYMENT_METHODS } from '../../src/shared/index.js';
import type {
  PaymentMethod,
  ServiceConstraints,
  ServiceOption,
  ServiceQuestion,
} from '../../src/shared/index.js';

// Re-exported as-is: the widget/admin config wire format is field-for-field the shared shape —
// see src/shared/booking/service-rules.ts for the single definition.
export type { ServiceOption, ServiceQuestion };

export type ServiceConfig = ServiceConstraints & {
  type: string;
  label: string;
  icon: string; // widget icon key: bed|home|sun|paw|clipboard
  /** Short sitter-written blurb shown under the service name in the picker; null = show nothing. */
  description: string | null;
  shape: 'range' | 'single';
  rateUnit: 'night' | 'day' | 'visit' | 'walk';
  hasDuration: boolean;
  options: ServiceOption[];
  questions: ServiceQuestion[];
  acceptedPetTypes: string[] | null;
  cancellationTiers: { withinDays: number; percent: number }[] | null;
  /** The sitter's holiday rate, for labelling only; null = no holiday pricing. */
  holidayRate: number | null;
};
export type TenantConfig = {
  slug: string;
  displayName: string;
  accentColor: string;
  timezone: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  petTypes: { slug: string; label: string }[]; // the FULL pet-type registry — serves as the label map; offered types derive per service
  services: ServiceConfig[];
  disabled: boolean;
  // Published verbatim from `/config` (server/routes/public.ts) — presence/absence only. This
  // repo interprets none of it beyond reading these fields; see ServicesSection's premium embed.
  premium?: { assistant?: boolean; chat?: boolean; mcp?: boolean; origin?: string | null };
};

export type Pet = {
  id: string;
  name: string;
  petType: string;
  notes?: string | null;
  /** NULL/absent = alive. Only the admin payload sets it — customer-facing lists omit deceased pets. */
  deceasedAt?: string | null;
};
/** The signed-in customer's own view of themselves — `GET /api/:slug/me`. */
export type Me = {
  name: string | null;
  pets: Pet[];
  /** Intake answers to pre-fill, `{ serviceType: { questionId: value } }`. The SERVER has already
   *  dropped anything whose question was reworded, retyped or narrowed past it, so the widget can
   *  render these as-is — but they are a convenience, never an authority: the booking POST
   *  re-validates them exactly like a typed answer. */
  savedAnswers: Record<string, Record<string, string>>;
};

export type MonthDay = {
  date: string;
  status: 'available' | 'partial' | 'unavailable';
  used: number | null;
  max: number | null;
  mine: boolean;
  /** Short server-authored phrase for WHY the day can't be booked; null when it can. */
  reason: string | null;
};

// Hand-mirrors server/lib/availability.ts's MonthAvailability — keep the two in step.
export type MonthAvailability = {
  today: string;
  /** Booking window RESOLVED TO DATES by the server (null latest = no horizon). The client only
   *  ever compares these strings — the window rule itself never leaves the server. */
  earliestBookable: string;
  latestBookable: string | null;
  days: MonthDay[];
};

// Hand-mirrors server/lib/availability.ts's AvailabilityResult — keep the two in step.
export type Availability =
  | {
      available: true;
      priced: true;
      estCost: number;
      /** Quantity `estCost` was billed for, with its noun. Absent for single-day services
       *  (flat per-booking charge, no quantity). Label from these, never from
       *  `ServiceConfig.rateUnit` — the number and its noun must share one source. */
      billedUnits?: number;
      unit?: 'night' | 'day';
      /** Wire-compat only; always a night count. Prefer `billedUnits`/`unit`. */
      nights?: number;
      /** How many billed units the SERVER charged at the sitter's holiday rate, and that rate.
       *  Both absent unless a holiday actually applied. Display only — `estCost` already
       *  includes them; the widget must never re-derive a total from these. */
      holidayUnits?: number;
      holidayRate?: number;
      /** The extra-time surcharge the chosen arrival/departure times attract (0009) and its total,
       *  both absent unless a fee applies. NOT included in `estCost` — it becomes a separate charge
       *  on the booking, so what the client will owe is `estCost + extraTimeTotal`. Render these
       *  verbatim: the amounts are the server's, and the widget must never derive a fee from a time
       *  of day (it is not sent the sitter's standard hours at all, precisely so it cannot). */
      extraTimeFees?: { label: string; amount: number }[];
      extraTimeTotal?: number;
    }
  | {
      /** The dates are free but the sitter has never priced this set of pets. The widget shows
       *  her contact details and blocks submit. It must NEVER compute a substitute price — the
       *  client does not do money. */
      available: true;
      priced: false;
      reason: 'unpriced-pet-set';
      groupKey: string;
      mixKey: string;
    }
  | { available: false; reason: string };

export type Booking = {
  id: string;
  type: string;
  startDate: string;
  endDate: string | null;
  /** Owner-chosen arrival time; null = none given. */
  startTime: string | null;
  /** Owner-chosen departure time (0008); null = none given. On a range stay it is a time on the
   *  END date, so it may legally be earlier in the day than `startTime`. */
  departureTime: string | null;
  /** Which priced option the booking is on. An edit never changes it — it is here so the edit
   *  form paints the calendar against the right option's capacity. */
  optionKey: string | null;
  /** The pet ids on the booking, so an edit form can pre-select them without matching names. */
  petIds: string[];
  petCount: number;
  estCost: number | null;
  /** Extras the sitter added after the fact. `estCost` excludes them by design; what the client
   *  owes is `estCost + chargesTotal`. */
  charges: { label: string; amount: number }[];
  chargesTotal: number;
  /** What was answered ON THIS BOOKING, keyed by question id — not the saved pre-fill, which may
   *  since have moved on. The edit form opens showing these. */
  answers: Record<string, string>;
  cancellationFee: number | null;
  /** Whether the customer may still cancel this one. The SERVER's answer — the widget does no
   *  date math and never infers cancellability from `status` + dates itself. */
  cancellable: boolean;
  /** Whether the customer may still CHANGE this one. Also the server's answer, and deliberately
   *  not the same question as `cancellable`: a stay already under way can be cancelled but not
   *  re-dated. */
  editable: boolean;
  /** Whole dollars owed if cancelled today; null when it isn't cancellable. Server-computed from
   *  the sitter's stored policy — the widget renders money, it never derives it. */
  feeIfCancelledToday: number | null;
  status: string;
  pets: string[];
};

export type Customer = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  venmoUsername: string | null;
  status: 'invited' | 'active';
  invitedAt?: string | null;
  pets: Pet[];
};

/** One stored specific-pets rate (PetGroupPricing row), wire shape from the admin routes. */
export type PetGroupRate = {
  id: string;
  serviceType: string;
  optionKey: string;
  petIds: string[];
  rate: number;
  updatedAt: string;
};

export type ImportResult = {
  importedCustomers: number;
  importedPets: number;
  /** Pets the file shared with a second owner via the "Co-owner Emails" column. */
  coOwnerLinks: number;
  invitesSent: number;
  invitesFailed: number;
  skippedRows: { row: number; reason: string }[];
};

export type AdminBooking = {
  id: string;
  customerEmail: string | null;
  customerName: string | null;
  type: string;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  /** Owner-chosen departure time (0008); null = none given. */
  departureTime: string | null;
  optionKey: string | null;
  petCount: number;
  /** Names of the pets on this booking, in the order the server grouped them (by name); [] for a
   * materialized external/blocked row, which has no pets. This is the row's primary label — pet
   * names lead, owner name/email is secondary (CLAUDE.md: "everything should be categorized by
   * the pets"). */
  petNames: string[];
  /** True for a materialized Google Calendar event: read-only, blocks capacity, no customer. */
  external: boolean;
  /** The Google event's title, for calendar display. Null unless external. */
  externalSummary: string | null;
  /** True for a booking adopted from the sitter's own calendar (`Source = 'calendar-backfill'`).
   *  Its `estCost` was priced from TODAY's rate card for a stay that may predate it — an estimate,
   *  not a figure any client saw or agreed to — so the UI must label it as one and offer the
   *  correction PATCH (`adminApi.bookings.updateCost`), which only these rows accept. */
  isBackfilled: boolean;
  /** Intake answers keyed by question id; {} when the customer answered nothing. */
  answers: Record<string, string>;
  estCost: number | null;
  paidTotal: number;
  charges: BookingCharge[];
  /** SUM(charges). Total due is `estCost + chargesTotal` — estCost itself is never mutated. */
  chargesTotal: number;
  status: string;
  cancellationFee: number | null;
  feeIfCancelledToday: number | null;
  createdAt: string;
};

export type Payment = {
  id: string;
  amount: number;
  method: string;
  paidDate: string;
  note: string | null;
};

/** One extra charge on a booking — additive; it never changes the booking's estCost. */
export type BookingCharge = { id: string; label: string; amount: number };

export type VenmoPreviewRow = {
  txnId: string;
  date: string;
  amount: number;
  from: string;
  note: string;
};
/**
 * Story 2.5 — a matched row names a HOUSEHOLD, not a booking: once a payer resolves to one client,
 * `buildAccounts` names their household unambiguously, so there is no "which booking?" step left to
 * ask the sitter (no `ambiguous` bucket any more).
 */
export type VenmoPreview = {
  matched: (VenmoPreviewRow & {
    endUserId: string;
    clientLabel: string;
    accountId: string;
  })[];
  unmatched: (VenmoPreviewRow & { reason: string })[];
  alreadyImported: VenmoPreviewRow[];
  ignored: number;
  problems: { row: number; reason: string }[];
};
export type VenmoImportResult = {
  imported: number;
  totalAmount: number;
  skipped: { txnId: string; reason: string }[];
};

/** The generic mapped-CSV importer's sibling of the Venmo types above — hand-mirrors
 *  server/lib/payment-csv.ts, which owns every shape here. */
export type CsvShape = { headers: string[]; sample: string[][]; dataRowCount: number };

/** Which column (0-indexed, against the file's own header row) holds each field — matches
 *  server/lib/payment-csv.ts's `ColumnMapping` field-for-field. */
export type CsvColumnMapping = {
  date: number;
  amount: number;
  payer: number;
  method?: number;
  reference?: number;
  note?: number;
};

export type CsvPreviewRow = {
  dedupeKey: string;
  row: number;
  date: string;
  amount: number;
  payer: string;
  method: PaymentMethod;
  reference: string | null;
  note: string;
};
export type CsvPreview = {
  matched: (CsvPreviewRow & {
    endUserId: string;
    clientLabel: string;
    accountId: string;
  })[];
  unmatched: (CsvPreviewRow & { reason: string })[];
  alreadyImported: CsvPreviewRow[];
  problems: { row: number; reason: string }[];
  /** Every household of this tenant a payment may be filed against, so the sitter can place a row
   *  the matcher couldn't. The same list the import route validates their choice against. */
  households: { accountId: string; label: string }[];
};
export type CsvImportResult = {
  imported: number;
  totalAmount: number;
  skipped: { dedupeKey: string; reason: string }[];
};

/** Why one calendar event couldn't be adopted outright — hand-mirrors server/lib/calendar-
 *  backfill.ts's `FlagReason`. `unpriced-set` is kept for type parity with the server's closed
 *  union, but the classifier no longer produces it as a flag (an unpriced-but-otherwise-resolved
 *  event is `needs-price` below instead); the panel still gives it a heading rather than assume. */
export type BackfillFlagReason =
  'no-pets' | 'ambiguous-pet' | 'multiple-households' | 'unknown-service' | 'unpriced-set';

/** Fully resolved AND priced — everything `insertBackfilledBooking` needs, off today's rate card.
 *  `estCost` is an ESTIMATE (see `AdminBooking.isBackfilled`), which is why the import route lets
 *  the sitter override it with their own figure before adopting. */
export type BackfillAdoptRow = {
  kind: 'adopt';
  eventId: string;
  summary: string;
  startDate: string;
  endDate: string | null;
  endUserId: string;
  serviceType: string;
  optionKey: string;
  petIds: string[];
  /** Aligned with `petIds` — resolved server-side, never guessed from `summary`. */
  petNames: string[];
  estCost: number;
  cancelled: boolean;
};

/** Same as `BackfillAdoptRow` but for a rate the sitter's card has never priced — `priced: false`,
 *  the free product's own "available but not priced" outcome (CLAUDE.md's unpriced-pet-set trap).
 *  Deliberately carries NO cost field at all: never `estCost: null`, never a guessed `0`. Adoptable
 *  the moment the sitter types a price on it. */
export type BackfillNeedsPriceRow = {
  kind: 'needs-price';
  eventId: string;
  summary: string;
  startDate: string;
  endDate: string | null;
  endUserId: string;
  serviceType: string;
  optionKey: string;
  petIds: string[];
  /** Aligned with `petIds` — resolved server-side, never guessed from `summary`. */
  petNames: string[];
  cancelled: boolean;
};

export type BackfillFlagRow = {
  kind: 'flag';
  eventId: string;
  summary: string;
  startDate: string;
  reason: BackfillFlagReason;
  detail: string;
};

/** Already on Pawservation (`pawservation-own`) or adopted in an earlier import
 *  (`already-adopted`) — carries its own eventId, like every other row kind, so a caller resuming
 *  a preview across passes can de-duplicate the shared boundary date instead of a naive per-pass
 *  count double-counting whatever landed on it. */
export type BackfillSkipRow = {
  kind: 'skip';
  eventId: string;
  why: 'pawservation-own' | 'already-adopted';
};

export type BackfillPreview = {
  adopt: BackfillAdoptRow[];
  needsPrice: BackfillNeedsPriceRow[];
  flags: BackfillFlagRow[];
  skipped: BackfillSkipRow[];
  /** Date to resume from when this pass didn't cover the whole requested range (more events than
   *  the server's per-pass cap) — null once the range is fully covered. Deliberately the LAST
   *  classified event's own start date, not the day after it: see the route's own comment for why
   *  that's the only boundary that can't skip an event. */
  nextFrom: string | null;
  /** How many events in the requested range this pass did not classify — 0 once nextFrom is null. */
  remaining: number;
};

export type BackfillImportResult = {
  imported: number;
  skipped: { eventId: string; reason: string }[];
};

export type AnalyticsPayload = {
  tiles: {
    thisMonth: number;
    lastMonth: number;
    outstandingTotal: number;
    outstandingCount: number;
    /** Money paid on bookings that no longer owe it — see `credits`. Never netted against
     *  `outstandingTotal`: one client owing $100 while another is owed $100 is not a settled book. */
    creditTotal: number;
  };
  monthly: { month: string; total: number }[];
  ytd: number;
  quarterly: { q: number; total: number }[];
  byService: { serviceType: string; label: string; total: number }[];
  topClients: {
    endUserId: string;
    name: string | null;
    email: string | null;
    total: number;
    bookings: number;
  }[];
  outstanding: {
    bookingId: string;
    name: string | null;
    email: string | null;
    serviceType: string;
    startDate: string;
    estCost: number;
    chargesTotal: number;
    paidTotal: number;
    balance: number;
    isCancellationFee: boolean;
  }[];
  /**
   * The mirror of `outstanding`: bookings paid MORE than they may keep, which is where a booking
   * edited down below what was already paid now shows up. `credit` is `paidTotal - keepable`. These
   * rows deliberately carry no *Record payment* affordance — a credit is a negative balance, not a
   * payable one. What they DO carry is the two ways to close one: keep it (`keepCredit`, when
   * `canKeep`) or correct the payment ledger (the money went back).
   */
  credits: {
    bookingId: string;
    name: string | null;
    email: string | null;
    serviceType: string;
    startDate: string;
    status: string;
    keepable: number;
    paidTotal: number;
    credit: number;
    /**
     * Server-derived: may this credit be closed by KEEPING it? False for a declined request, which
     * may keep nothing at all — so the button is not offered rather than offered and refused. The
     * client never re-derives this rule.
     */
    canKeep: boolean;
  }[];
  /**
   * ONE BALANCE PER HOUSEHOLD — the connected component of owners and pets that already shares an
   * invoice number (two customers who share a single pet are one household), summed as
   * `Σ(booking costs + charges) − Σ(payments)` across every booking of that household.
   *
   * Every figure arrives computed. The client adds nothing up: `balance` is money, money is
   * server-side, and a total re-derived in the browser is a total that can disagree with the one
   * the server would have printed. Negative `balance` = the household is in credit.
   */
  households: {
    accountId: string;
    owners: { endUserId: string; name: string | null; email: string | null }[];
    /** Every pet of the household. A household payment is recorded against one of these ids. */
    petIds: string[];
    /** Pets that have died but that payments of this household are still filed under, so the money
     *  stays on this balance. Not part of the household's pets; never rendered as one. */
    anchorPetIds: string[];
    bookingIds: string[];
    expectedTotal: number;
    paidTotal: number;
    balance: number;
  }[];
  /**
   * HOUSEHOLD PAYMENTS THAT BELONG TO NO HOUSEHOLD — the pet whose id the payment was filed under
   * has been deleted along with its ownership edges, so nothing on the server can say whose money
   * it is. It is still counted in the revenue tiles above, which is exactly why it is published
   * here: shown, the sitter can re-record it against the right household and delete the stray;
   * unpublished, it would be revenue with no statement anywhere that accounts for it.
   */
  orphanedPayments: { accountId: string; total: number }[];
};

/**
 * THE DRILL-DOWN BEHIND ONE HOUSEHOLD BALANCE (Story 2.4, FR-7c) — mirrors `HouseholdDetailRow` in
 * `server/types.ts`. `expectedTotal`/`paidTotal`/`balance` are the same numbers the household row
 * in `AnalyticsPayload.households` already carries, repeated here so the detail view reconciles to
 * itself without the caller having to keep the summary row around.
 */
export type HouseholdDetail = {
  accountId: string;
  bookings: {
    bookingId: string;
    serviceType: string;
    startDate: string;
    status: string;
    cost: number;
    charges: { id: string; label: string; amount: number }[];
    chargesTotal: number;
    paidTotal: number;
    expected: number;
  }[];
  householdPayments: {
    id: string;
    amount: number;
    method: string;
    paidDate: string;
    note: string | null;
  }[];
  expectedTotal: number;
  paidTotal: number;
  balance: number;
};

export type SitterWindow = '30d' | '90d' | 'quarter' | 'ytd' | 'all';
export type SitterRow = {
  tenantId: string;
  slug: string;
  displayName: string;
  createdAt: string;
  clients: number;
  bookings: number;
  earned: number;
  disabled: boolean;
  premiumUntil: string | null;
};
export type SitterRosterResponse = {
  window: SitterWindow;
  totals: { sitters: number; clients: number; bookings: number; earned: number };
  sitters: SitterRow[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * The response's stable snake_case `code`, when it carried one. Only the booking POST does
     * today (`server/routes/bookings.ts`), which is why this is optional — `message` remains the
     * only thing every caller can rely on. Prefer the code over string-matching the message.
     */
    public code?: string,
  ) {
    super(message);
  }
}

/** True for a 401/403 ApiError — the token is missing, expired, or wrong-tenant. */
export function isAuthExpired(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok)
    throw new ApiError(res.status, body.error ?? 'Something went wrong — try again.', body.code);
  return body;
}

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = { 'Content-Type': 'application/json' };

export const api = {
  config: (slug: string) => request<TenantConfig>(`/api/${slug}/config`),

  availability: (slug: string, token: string, params: Record<string, string>) =>
    request<Availability>(`/api/${slug}/availability?${new URLSearchParams(params)}`, {
      headers: authHeaders(token),
    }),

  // `prototypeCode` is only present in dev (no email provider configured); in prod the code is
  // emailed and the response carries only `codeId`.
  // `hostOrigin` (the embedding page's origin, from document.referrer) is forwarded as
  // X-Pawservation-Host so the server can gate the reserved demo login to pawservation.com's
  // own pages — the fetch itself is same-origin from the iframe, so its Origin header is the
  // worker's origin on EVERY embedding site and can't distinguish them.
  identify: (slug: string, email: string, hostOrigin?: string) =>
    request<{ codeId: string; prototypeCode?: string }>(`/api/${slug}/identify`, {
      method: 'POST',
      headers: hostOrigin ? { ...jsonHeaders, 'X-Pawservation-Host': hostOrigin } : jsonHeaders,
      body: JSON.stringify({ email }),
    }),

  verify: (slug: string, codeId: string, code: string) =>
    request<{ token: string }>(`/api/${slug}/verify`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ codeId, code }),
    }),

  createBooking: (
    slug: string,
    token: string,
    body: {
      type: string;
      optionKey: string;
      startDate: string;
      endDate?: string;
      /** Owner-chosen arrival time 'HH:MM'. Accepted only where the option does not own the
       *  clock (boarding, house sitting, daycare); the server refuses it elsewhere. */
      startTime?: string;
      /** Owner-chosen departure time 'HH:MM'; same gate as `startTime`. */
      departureTime?: string;
      petIds: string[];
      answers: Record<string, string>;
    },
    /**
     * Dedupes a retried attempt: the server returns the ORIGINAL `{id, estCost, status}` with 201
     * instead of creating a second booking (≤128 chars, unique per tenant+customer). Generate one
     * per attempt and reuse it across retries of that same attempt — a changed selection is a new
     * attempt and must carry a new key, or the replay would return the booking for the old dates.
     */
    idempotencyKey?: string,
  ) =>
    request<{ id: string; estCost: number; status: string; demo?: boolean; note?: string }>(
      `/api/${slug}/bookings`,
      {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          ...authHeaders(token),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      },
    ),

  /**
   * The customer changes their own booking — dates, pets, arrival time, intake answers. There is
   * deliberately no service field: the server reads the service off the stored row, so switching
   * Boarding→Daycare stays cancel-and-rebook. The response carries the RE-QUOTED estimate and the
   * status the booking landed in, which is always `pending` — the sitter re-approves.
   */
  editBooking: (
    slug: string,
    token: string,
    id: string,
    body: {
      startDate: string;
      endDate?: string;
      startTime?: string;
      departureTime?: string;
      petIds: string[];
      answers: Record<string, string>;
    },
  ) =>
    request<{ id: string; estCost: number; status: string }>(
      `/api/${slug}/bookings/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify(body),
      },
    ),

  me: (slug: string, token: string) =>
    request<Me>(`/api/${slug}/me`, {
      headers: authHeaders(token),
    }),

  monthAvailability: (
    slug: string,
    token: string,
    type: string,
    month: string,
    optionKey?: string,
    /** Comma-joined pet ids the grid is painted FOR — a `1/2` day is bookable for one pet and
     *  not for two, and the server does that arithmetic. Empty = one pet. */
    petIds?: string,
    /** A booking of the caller's own to leave out of the capacity map — set while EDITING it, so
     *  the days it already holds don't paint as taken. The server proves ownership. */
    excludeBookingId?: string,
  ) =>
    request<MonthAvailability>(
      `/api/${slug}/availability/month?type=${encodeURIComponent(type)}&month=${month}` +
        (optionKey ? `&option=${encodeURIComponent(optionKey)}` : '') +
        (petIds ? `&petIds=${encodeURIComponent(petIds)}` : '') +
        (excludeBookingId ? `&excludeBookingId=${encodeURIComponent(excludeBookingId)}` : ''),
      { headers: authHeaders(token) },
    ),

  myBookings: (slug: string, token: string) =>
    request<{ bookings: Booking[] }>(`/api/${slug}/bookings/mine`, {
      headers: authHeaders(token),
    }),

  /**
   * Owner-initiated cancellation. Carries no body at all: the fee is the server's to compute from
   * the sitter's policy, so there is nothing for the client to send and nothing for it to get
   * wrong. The response echoes the amount actually stamped on the booking.
   */
  cancelBooking: (slug: string, token: string, id: string) =>
    request<{ status: string; cancellationFee: number }>(
      `/api/${slug}/bookings/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', headers: authHeaders(token) },
    ),
};

export const adminApi = {
  customers: {
    list: (slug: string, token: string) =>
      request<{ customers: Customer[] }>(`/api/${slug}/admin/customers`, {
        headers: authHeaders(token),
      }),
    add: (
      slug: string,
      token: string,
      email: string,
      name: string,
      phone: string,
      petName: string,
      petType: string,
    ) =>
      request<{ id: string; status: string; created: boolean }>(`/api/${slug}/admin/customers`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ email, name, phone, petName, petType }),
      }),
    /**
     * A second HUMAN on an existing account, bringing no new animal. `petIds` is the account's LIVE
     * pet set: the server creates the client and every ownership link in one batch, so there is no
     * moment at which a pet-less client exists. `created: false` means the email was already a
     * client and the two accounts merged — a materially different outcome the UI must not blur.
     */
    addCoOwner: (
      slug: string,
      token: string,
      body: { email: string; name: string; phone: string; petIds: string[] },
    ) =>
      request<{ id: string; created: boolean; linkedPets: number }>(
        `/api/${slug}/admin/customers/co-owner`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify(body),
        },
      ),
    remove: (slug: string, token: string, id: string) =>
      request<unknown>(`/api/${slug}/admin/customers/${id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    setVenmo: (slug: string, token: string, id: string, venmoUsername: string | null) =>
      request<unknown>(`/api/${slug}/admin/customers/${id}`, {
        method: 'PATCH',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ venmoUsername }),
      }),
    addPet: (
      slug: string,
      token: string,
      endUserId: string,
      name: string,
      petType: string,
      notes: string,
    ) =>
      request<{ id: string; name: string; petType: string }>(
        `/api/${slug}/admin/customers/${endUserId}/pets`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify({ name, petType, notes }),
        },
      ),
    removePet: (slug: string, token: string, endUserId: string, petId: string) =>
      request<unknown>(`/api/${slug}/admin/customers/${endUserId}/pets/${petId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    addPetOwner: (slug: string, token: string, petId: string, endUserId: string) =>
      request<unknown>(`/api/${slug}/admin/pets/${petId}/owners`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ endUserId }),
      }),
    removePetOwner: (slug: string, token: string, petId: string, endUserId: string) =>
      request<unknown>(`/api/${slug}/admin/pets/${petId}/owners/${endUserId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    setPetDeceased: (slug: string, token: string, petId: string, deceased: boolean) =>
      request<unknown>(`/api/${slug}/admin/pets/${petId}`, {
        method: 'PATCH',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ deceased }),
      }),
    import: (slug: string, token: string, csv: string, sendInvites: boolean) =>
      request<ImportResult>(`/api/${slug}/admin/customers/import`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv, sendInvites }),
      }),
    sendWelcome: (slug: string, token: string, id: string) =>
      request<{ ok: true }>(`/api/${slug}/admin/customers/${id}/welcome`, {
        method: 'POST',
        headers: authHeaders(token),
      }),
  },
  payments: {
    list: (slug: string, token: string, bookingId: string) =>
      request<{ payments: Payment[] }>(`/api/${slug}/admin/bookings/${bookingId}/payments`, {
        headers: authHeaders(token),
      }),
    record: (
      slug: string,
      token: string,
      bookingId: string,
      body: { amount: number; method: string; paidDate: string; note?: string },
    ) =>
      request<{ payment: Payment; paidTotal: number }>(
        `/api/${slug}/admin/bookings/${bookingId}/payments`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify(body),
        },
      ),
    remove: (slug: string, token: string, bookingId: string, paymentId: string) =>
      request<unknown>(`/api/${slug}/admin/bookings/${bookingId}/payments/${paymentId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    /**
     * Close an over-payment the client agreed the sitter keeps. NO amount is sent — the server
     * computes it from the same expressions Earnings displayed the credit with, so the charge it
     * logs can never differ from the figure she was shown.
     */
    keepCredit: (slug: string, token: string, bookingId: string) =>
      request<{ kept: number }>(`/api/${slug}/admin/bookings/${bookingId}/credit/keep`, {
        method: 'POST',
        headers: authHeaders(token),
      }),
    /**
     * The HOUSEHOLD ledger (0011) — the same three operations as the booking ledger above, against
     * an account id instead of a booking id. One payment covering several bookings is ONE row here;
     * the sitter is never asked to split it, and `record` sends no balance because the server
     * answers with the recomputed one.
     */
    listForAccount: (slug: string, token: string, accountId: string) =>
      request<{ payments: Payment[] }>(`/api/${slug}/admin/accounts/${accountId}/payments`, {
        headers: authHeaders(token),
      }),
    recordForAccount: (
      slug: string,
      token: string,
      accountId: string,
      body: { amount: number; method: string; paidDate: string; note?: string },
    ) =>
      request<{ payment: Payment; balance: number }>(
        `/api/${slug}/admin/accounts/${accountId}/payments`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify(body),
        },
      ),
    removeForAccount: (slug: string, token: string, accountId: string, paymentId: string) =>
      request<unknown>(`/api/${slug}/admin/accounts/${accountId}/payments/${paymentId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    venmoPreview: (slug: string, token: string, csv: string) =>
      request<VenmoPreview>(`/api/${slug}/admin/payments/venmo/preview`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv }),
      }),
    venmoImport: (
      slug: string,
      token: string,
      csv: string,
      choices: { txnId: string; accountId: string }[],
    ) =>
      request<VenmoImportResult>(`/api/${slug}/admin/payments/venmo/import`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv, choices }),
      }),
    csvColumns: (slug: string, token: string, csv: string) =>
      request<CsvShape>(`/api/${slug}/admin/payments/csv/columns`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv }),
      }),
    csvPreview: (
      slug: string,
      token: string,
      csv: string,
      mapping: CsvColumnMapping,
      defaultMethod: PaymentMethod,
    ) =>
      request<CsvPreview>(`/api/${slug}/admin/payments/csv/preview`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv, mapping, defaultMethod }),
      }),
    csvImport: (
      slug: string,
      token: string,
      csv: string,
      mapping: CsvColumnMapping,
      defaultMethod: PaymentMethod,
      choices: { dedupeKey: string; accountId: string }[],
    ) =>
      request<CsvImportResult>(`/api/${slug}/admin/payments/csv/import`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv, mapping, defaultMethod, choices }),
      }),
  },
  households: {
    /** The bookings, charges and payments behind one household balance (Story 2.4). */
    detail: (slug: string, token: string, accountId: string) =>
      request<HouseholdDetail>(`/api/${slug}/admin/accounts/${accountId}`, {
        headers: authHeaders(token),
      }),
  },
  charges: {
    list: (slug: string, token: string, bookingId: string) =>
      request<{ charges: BookingCharge[] }>(`/api/${slug}/admin/bookings/${bookingId}/charges`, {
        headers: authHeaders(token),
      }),
    add: (
      slug: string,
      token: string,
      bookingId: string,
      charge: { label: string; amount: number },
    ) =>
      request<{ charge: BookingCharge; chargesTotal: number }>(
        `/api/${slug}/admin/bookings/${bookingId}/charges`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify(charge),
        },
      ),
    remove: (slug: string, token: string, bookingId: string, chargeId: string) =>
      request<void>(`/api/${slug}/admin/bookings/${bookingId}/charges/${chargeId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
  },
  analytics: {
    get: (slug: string, token: string) =>
      request<AnalyticsPayload>(`/api/${slug}/admin/analytics`, { headers: authHeaders(token) }),
  },
  bookings: {
    list: (slug: string, token: string) =>
      request<{ bookings: AdminBooking[] }>(`/api/${slug}/admin/bookings`, {
        headers: authHeaders(token),
      }),
    setStatus: (
      slug: string,
      token: string,
      id: string,
      status: 'confirmed' | 'declined' | 'cancelled',
      // Only sent when the sitter opts to charge the prospective cancellation fee; the server
      // ignores it for non-cancel transitions, so it's omitted unless explicitly true.
      chargeFee?: boolean,
      /**
       * The sitter's ACKNOWLEDGEMENT that confirming will overbook her. Sent only on the second
       * attempt, after the server answered 409 `capacity_conflict` and she said yes to the warning
       * it wrote — never pre-emptively, or the warning would be one she never saw.
       */
      overrideCapacity?: boolean,
    ) =>
      request<{ status: string; notified: boolean; cancellationFee: number | null }>(
        `/api/${slug}/admin/bookings/${id}/status`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify({
            status,
            ...(chargeFee ? { chargeFee: true } : {}),
            ...(overrideCapacity ? { overrideCapacity: true } : {}),
          }),
        },
      ),
    /**
     * Correct the price on a booking ADOPTED from the calendar (`isBackfilled`) — its `estCost`
     * was invented from today's rate card, never a figure any client agreed to. Whole dollars
     * only; the server 404s for anything that isn't `Source = 'calendar-backfill'`.
     */
    updateCost: (slug: string, token: string, id: string, estCost: number) =>
      request<{ estCost: number }>(`/api/${slug}/admin/bookings/${id}/cost`, {
        method: 'PATCH',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ estCost }),
      }),
  },
  /**
   * Read-only adoption of a sitter's existing Google Calendar events as bookings
   * (docs/superpowers/specs/2026-08-09-calendar-backfill-design.md). `preview` writes nothing —
   * every event is re-read and classified fresh; `import` re-derives the same classification
   * server-side and only ever trusts the browser for WHICH event ids to adopt and, optionally,
   * the sitter's own price for each.
   */
  calendarBackfill: {
    preview: (slug: string, token: string, from: string, to: string) =>
      request<BackfillPreview>(`/api/${slug}/admin/calendar/backfill/preview`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ from, to }),
      }),
    import: (
      slug: string,
      token: string,
      from: string,
      to: string,
      events: { eventId: string; estCost?: number }[],
    ) =>
      request<BackfillImportResult>(`/api/${slug}/admin/calendar/backfill/import`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ from, to, events }),
      }),
  },
  calendar: {
    start: (slug: string, token: string) =>
      request<{ url: string }>(`/api/${slug}/admin/providers/calendar/oauth/start`, {
        headers: authHeaders(token),
      }),
    disconnect: (slug: string, token: string) =>
      request<{ status: string }>(`/api/${slug}/admin/providers/calendar/disconnect`, {
        method: 'POST',
        headers: authHeaders(token),
      }),
    /** Creates a dedicated "Pawservation — Pet bookings" calendar in the sitter's Google account. */
    createPetCalendar: (slug: string, token: string) =>
      request<{ calendarId: string; summary: string }>(
        `/api/${slug}/admin/providers/calendar/create-calendar`,
        { method: 'POST', headers: authHeaders(token) },
      ),
    setCalendarId: (slug: string, token: string, calendarId: string) =>
      request<unknown>(`/api/${slug}/admin/providers/calendar/calendar-id`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ calendarId }),
      }),
  },
  // Explicit prices for a specific set of pets (PetGroupPricing) — upsert/delete-ONE, mirroring
  // server/routes/admin.ts's routes 1:1. Consumed by the account-card rate editor.
  petGroupRates: {
    list: (slug: string, token: string) =>
      request<{ rates: PetGroupRate[] }>(`/api/${slug}/admin/pet-group-rates`, {
        headers: authHeaders(token),
      }),
    upsert: (
      slug: string,
      token: string,
      body: { serviceType: string; optionKey: string; petIds: string[]; rate: number },
    ) =>
      request<{ id: string; groupKey: string }>(`/api/${slug}/admin/pet-group-rates`, {
        method: 'PUT',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify(body),
      }),
    remove: (slug: string, token: string, id: string) =>
      request<unknown>(`/api/${slug}/admin/pet-group-rates/${id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
  },
};

export const owner = {
  sitters: (token: string, window: SitterWindow) =>
    request<SitterRosterResponse>(`/api/owner/sitters?window=${window}`, {
      headers: authHeaders(token),
    }),
  sitterDetail: (token: string, tenantId: string, window: SitterWindow) =>
    request<AnalyticsPayload>(
      `/api/owner/sitters/${encodeURIComponent(tenantId)}?window=${window}`,
      { headers: authHeaders(token) },
    ),
  setSitterDisabled: (token: string, tenantId: string, disabled: boolean) =>
    request<{ disabled: boolean }>(`/api/owner/sitters/${encodeURIComponent(tenantId)}`, {
      method: 'PATCH',
      headers: { ...jsonHeaders, ...authHeaders(token) },
      body: JSON.stringify({ disabled }),
    }),
  setSitterPremium: (token: string, tenantId: string, premiumUntil: string | null) =>
    request<{ premiumUntil: string | null }>(`/api/owner/sitters/${encodeURIComponent(tenantId)}`, {
      method: 'PATCH',
      headers: { ...jsonHeaders, ...authHeaders(token) },
      body: JSON.stringify({ premiumUntil }),
    }),
  removeSitter: (token: string, tenantId: string) =>
    request<unknown>(`/api/owner/sitters/${encodeURIComponent(tenantId)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),
};

/**
 * Token storage that survives the Wix sandbox denying sessionStorage: in-memory first,
 * sessionStorage best-effort. Losing the token just means re-identifying.
 *
 * Keys are PER-SLUG: every tenant's widget shares the same origin (one workers.dev host),
 * so two embedded widgets on one page would otherwise read each other's tokens — found
 * live in the side-by-side demo as a 403 "Wrong tenant." in the second widget.
 */
const memoryTokens = new Map<string, string>();
const storageKey = (slug: string) => `pawservation-embed-token:${slug}`;

export function getToken(slug: string): string | null {
  const inMemory = memoryTokens.get(slug);
  if (inMemory) return inMemory;
  try {
    const stored = sessionStorage.getItem(storageKey(slug));
    if (stored) memoryTokens.set(slug, stored);
    return stored;
  } catch {
    /* storage denied — stateless-per-load mode */
    return null;
  }
}

export function setToken(slug: string, token: string | null): void {
  if (token) memoryTokens.set(slug, token);
  else memoryTokens.delete(slug);
  try {
    if (token) sessionStorage.setItem(storageKey(slug), token);
    else sessionStorage.removeItem(storageKey(slug));
  } catch {
    /* storage denied — stateless-per-load mode */
  }
}
