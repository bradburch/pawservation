import type { CapacityKind, PetType, RateUnit, ServiceShape, ServiceType } from './lib/services';
import type { PaymentMethod, PetRateMode } from './lib/validation';
import type { ServiceQuestion, CancellationTier } from '../src/shared/index.js';

export type {
  CapacityKind,
  PetType,
  RateUnit,
  ServiceShape,
  ServiceType,
  CancellationTier,
  PetRateMode,
};

export type Tenant = {
  Id: string;
  Slug: string;
  DisplayName: string;
  AccentColor: string;
  Timezone: string | null; // null = DEFAULT_TIMEZONE
  ContactEmail: string | null; // shown to clients in the booking widget
  ContactPhone: string | null; // shown to clients in the booking widget
  /** Booking horizon in calendar months (0004): a request may not START further out than this.
   *  null = no limit. Profile-level — one value for the whole business. */
  MaxAdvanceMonths: number | null;
  /** How many days a request may overlap OPPOSITE-kind occupancy — a house sit over boarding or
   *  boarding over a house sit (0006) — counted only where the day is a real handover. 0 = never;
   *  1 = the default; 2 = one at each end of the stay; null = no limit. Tenant-wide: the sitter's
   *  whereabouts, not a pool. Fed to the engine as `CapacityRequest.overlapAllowance`. */
  HousesitBoardingOverlapDays: number | null;
  DisabledAt: string | null; // null = active; timestamp = owner-disabled
  /** Paid-through instant in SQLite's `datetime('now')` shape ('YYYY-MM-DD HH:MM:SS', UTC), set
   *  and cleared by the platform owner (0010). null = free. NOT a flag: entitlement is the
   *  comparison `PremiumUntil > now`, made on every read by `isPremiumActive` — so a lapse takes
   *  effect on its own, with nothing to run and nothing to flip. The free product publishes the
   *  derived boolean on `/api/:slug/config`; it gates nothing on it. */
  PremiumUntil: string | null;
};

export type TenantUser = {
  Id: string;
  TenantId: string;
  Email: string;
  PasswordHash: string;
};

/** Instance-level platform-owner login row (see the owner-scope section of db/repo.ts). */
export type OwnerUser = {
  Id: string;
  Email: string;
  PasswordHash: string;
  CreatedAt: string;
};

/** Instance-level signup-allowlist row. ClaimedAt/TenantId stay NULL until setup completes. */
export type AllowedSitterRow = {
  Email: string;
  AddedAt: string;
  ClaimedAt: string | null;
  TenantId: string | null;
};

export type TenantService = {
  TenantId: string;
  ServiceType: ServiceType; // per-tenant slug
  Enabled: number;
  Label: string;
  Icon: string;
  /** Optional short sitter-written blurb shown to pet owners in the widget; null = absent (0025). */
  Description: string | null;
  Shape: ServiceShape;
  RateUnit: RateUnit;
  HasDuration: number;
  CapacityKind: CapacityKind;
  SortOrder: number;
  Questions: ServiceQuestion[];
  MaxNights: number | null;
  // No MinNights and no MinPetCount: both columns are DROPPED (2026-07-27 re-baseline) — the
  // minimum stay is structurally 1 night and services have only a max-pets limit.
  MaxPetCount: number | null;
  /** Minimum notice in days for this service's start date (0004); null or 0 = same-day OK. */
  MinLeadDays: number | null;
  /** Pet-type slugs this service accepts; null = accepts every enabled type. */
  AcceptedPetTypes: string[] | null;
  /** Pets per day cap for boarding and housesit pool services; null = unlimited (housesit's separate MaxPerDay column was folded into this one and later dropped). */
  MaxConcurrentPets: number | null;
  /** Tiered cancel policy; null = no fee (0016). */
  CancellationTiers: CancellationTier[] | null;
  /** Explicit whole-dollar rate for units landing on a listed US holiday; null = no holiday
   *  pricing. Same unit as RateUnit. Never a multiplier — see server/lib/holiday-cost.ts. */
  HolidayRate: number | null;
  /** How a pet set with no stored pet-set rate is priced (0005): 'exact' refuses it, 'linear'
   *  charges the option rate × the number of distinct pets. Defaults to 'exact'; a stored pet-set
   *  rate always beats the multiplier. See `estimateCost`. */
  PetRateMode: PetRateMode;
  /**
   * Extra-time surcharge config (0009), all nullable and each SIDE needing both its time and its
   * fee — NULL anywhere = the feature is off, the `HolidayRate` convention. The two fees are FLAT
   * whole dollars charged at most once PER STAY, never per hour and never per day, and never part of
   * `EstCost`: the fee is a `BookingCharges` row, so `estimateCost` stays "units of time × a stored
   * rate". See `server/lib/booking-times.ts`.
   */
  StandardArrivalTime: string | null;
  StandardDepartureTime: string | null;
  EarlyArrivalFee: number | null;
  LateDepartureFee: number | null;
};

export type TenantServiceOption = {
  Id: string;
  TenantId: string;
  ServiceType: ServiceType;
  OptionKey: string;
  Label: string;
  DurationMinutes: number | null;
  Rate: number;
  // No RateUnit: the billing unit lives on TenantService.RateUnit only (the per-option column is
  // dropped); omitting it here makes reading the wrong source a type error.
  StartTime: string | null; // 'HH:MM'; NULL = no fixed window
  EndTime: string | null; // 'HH:MM'; NULL = no fixed window
  Capacity: number | null; // max concurrent bookings/date; NULL = unlimited
  WeekdaysOnly: number; // int-bool: 1 = bookable Mon–Fri only
};

/**
 * One explicit rate for a specific set of pets. GroupKey is the sorted pet-id list; OptionKey
 * pins duration, so there is no DurationMinutes here and no RateUnit — the billing unit comes
 * from TenantServices.RateUnit.
 */
export type PetGroupPricingRow = {
  Id: string;
  TenantId: string;
  ServiceType: string;
  OptionKey: string;
  GroupKey: string;
  Rate: number;
  UpdatedAt: string;
};

/** One explicit rate for a species count. MixKey is canonical (src/shared/pricing/pet-set-rates.ts). */
export type TenantServicePetRateRow = {
  TenantId: string;
  ServiceType: string;
  OptionKey: string;
  MixKey: string;
  Rate: number;
};

export type TenantPetTypeRow = {
  TenantId: string;
  PetType: string; // per-tenant slug, immutable
  Label: string; // display name, renamable
};

export type EndUser = {
  Id: string;
  TenantId: string;
  Email: string;
  Name: string | null;
  Phone: string | null;
  VenmoUsername: string | null; // NULL = match Venmo rows on Name (see server/lib/venmo.ts)
  Status: 'invited' | 'active';
  InvitedAt: string | null;
};

export type EndUserPet = {
  Id: string;
  TenantId: string;
  EndUserId: string;
  Name: string;
  PetType: string; // tenant pet-type slug
  Notes: string | null; // sitter's care notes (feeding, meds, temperament)
  DeceasedAt: string | null; // NULL = alive; timestamp = deceased (0019)
  CreatedAt: string;
};

export type BookingRow = {
  Id: string;
  TenantId: string;
  EndUserId: string | null;
  ServiceType: ServiceType | 'blocked';
  StartDate: string;
  EndDate: string | null;
  OptionKey: string | null;
  PetCount: number;
  StartTime: string | null;
  /** Owner-set departure time, 'HH:MM' (0008); null = not given. NEVER an option's clock — see
   *  server/lib/booking-times.ts, and note the ordering rule is single-day only. */
  DepartureTime: string | null;
  GCalEventId: string | null;
  EstCost: number | null;
  /** Fee assessed at cancel time, whole dollars; null = none assessed (0016). */
  CancellationFee: number | null;
  Status: 'pending' | 'confirmed' | 'cancelled' | 'declined';
  /** Attribution channel stamped at insert ('mcp', 'voice', …); null = embed widget. Write-only
   * today — no query selects it; it exists for the out-of-tree booking MCP and future reporting. */
  Source?: string | null;
  CreatedAt: string;
};

/**
 * One row of the payments ledger. `BookingRequestId` and `AccountId` are EXACTLY ONE of the two —
 * the database enforces it (0011) — so a NULL `BookingRequestId` reads as "this payment settles the
 * household in `AccountId`", the form a client who pays monthly produces. `ExternalRef` is
 * deliberately absent: the Venmo importer writes it and only aggregate reads touch it.
 */
export type PaymentRow = {
  Id: string;
  TenantId: string;
  BookingRequestId: string | null;
  AccountId: string | null;
  Amount: number;
  Method: PaymentMethod;
  PaidDate: string;
  Note: string | null;
  CreatedAt: string;
};

/**
 * `BookingCharges.Origin` values a DERIVED charge may carry (0009) — today only the two sides of the
 * extra-time surcharge. NULL/absent Origin means the sitter typed the charge herself, which is every
 * row that predates the column and every row the admin Charges panel writes.
 *
 * Lives here rather than in `server/lib/booking-times.ts` so `server/db/repo.ts` (which owns the
 * DELETE that scopes an edit's re-derivation to exactly these rows) and that module can both name
 * the same domain without the repo importing from `lib/`.
 */
export const EXTRA_TIME_ORIGINS = ['extra_time_early', 'extra_time_late'] as const;
export type ExtraTimeOrigin = (typeof EXTRA_TIME_ORIGINS)[number];

/** One extra charge on a booking (vet visit, haircut). Amount is whole dollars >= 1. */
export type BookingChargeRow = {
  Id: string;
  TenantId: string;
  BookingRequestId: string;
  Label: string;
  Amount: number;
  /** Provenance (0009): null = sitter-typed, otherwise the rule that derived it. */
  Origin: ExtraTimeOrigin | null;
  CreatedAt: string;
};

/** getAnalytics result: raw PascalCase aggregate rows. monthly is exactly 12 entries, oldest
 * month first, zero-filled. The route maps to camelCase and derives the stat tiles in JS.
 * Exception: `ytd`/`quarterly` are already in payload (camelCase) shape — the helper emits them
 * that way and the route forwards them unmapped, so do NOT "correct" them to PascalCase. */
export type AnalyticsData = {
  monthly: { Month: string; Total: number }[];
  ytd: number;
  quarterly: { q: number; total: number }[];
  byService: { ServiceType: string; Label: string; Total: number }[];
  topClients: {
    EndUserId: string;
    Name: string | null;
    Email: string | null;
    Total: number;
    Bookings: number;
  }[];
  outstanding: {
    BookingId: string;
    Name: string | null;
    Email: string | null;
    ServiceType: string;
    StartDate: string;
    Status: string;
    EstCost: number;
    ChargesTotal: number;
    PaidTotal: number;
  }[];
  /**
   * Bookings paid MORE than they may keep — the mirror of `outstanding` (see `CREDIT_WHERE_SQL` in
   * `server/db/repo.ts`), and mutually exclusive with it. `Keepable` is the whole amount the booking
   * may keep (quote or assessed fee, plus charges; zero for a declined row), so the credit is
   * `PaidTotal - Keepable` — derived once in `serializeAnalytics`, never restated.
   */
  credits: {
    BookingId: string;
    Name: string | null;
    Email: string | null;
    ServiceType: string;
    StartDate: string;
    Status: string;
    Keepable: number;
    PaidTotal: number;
  }[];
  /**
   * ONE BALANCE PER HOUSEHOLD — the connected component of owners and pets `buildAccounts` derives,
   * summed as `Σ(booking costs + charges) − Σ(payments)` (`getHouseholdBalances` in
   * `server/db/repo.ts`). Already camelCase, unlike every aggregate above it, because it is
   * COMPUTED rather than selected: `serializeAnalytics` passes it through untouched, and the client
   * re-derives no part of it — balances are server-side money, like every other figure here.
   */
  households: HouseholdBalanceRow[];
  /**
   * HOUSEHOLD PAYMENTS THAT BELONG TO NO HOUSEHOLD — the pet their `AccountId` names has been
   * DELETED (a `deleteCustomer` cascade removes the pet and its owner edges together, and never
   * touches `Payments`), so nothing left in the database can say whose money it was. Published
   * beside the balances precisely because every revenue figure above still counts it:
   * `Σ households.paidTotal + Σ orphanedPayments.total` is the whole of the household money, and
   * this list is what keeps that identity true rather than leaving a payment counted in one view
   * and silently absent from the other. A pet that merely DIED is never here — its payments still
   * resolve to its own household (`buildPaymentAnchors`).
   */
  orphanedPayments: { accountId: string; total: number }[];
};

/**
 * One household's statement, as `getHouseholdBalances` computes it and the dashboard renders it.
 * `accountId` is the account id `buildAccounts` produces (the lexicographically-first pet of the
 * component), the same identity invoice numbering keys off. `balance` is negative when the
 * household is in CREDIT.
 */
export type HouseholdBalanceRow = {
  accountId: string;
  owners: { endUserId: string; name: string | null; email: string | null }[];
  /** Every pet of the component. A household payment is matched against THIS, not against
   *  `accountId`: the account id is the first-sorted pet and a pet added later renames it. */
  petIds: string[];
  /** Pets that have DIED but under whose ids payments of this household were filed, so those
   *  payments still resolve here (`buildPaymentAnchors`). Not members of the household: kept apart
   *  from `petIds` so a dead pet is never listed as one of a client's pets. */
  anchorPetIds: string[];
  bookingIds: string[];
  expectedTotal: number;
  paidTotal: number;
  balance: number;
};

/**
 * The drill-down behind one household balance (Story 2.4, FR-7c) — `getHouseholdDetail` in
 * `server/db/repo.ts`. `expectedTotal`/`paidTotal`/`balance` are `getHouseholdBalances`'s own
 * numbers for this household, passed through rather than recomputed, so the detail can never
 * disagree with the balance it sits beneath.
 */
export type HouseholdDetailRow = {
  accountId: string;
  bookings: {
    bookingId: string;
    serviceType: string;
    startDate: string;
    /** Exclusive checkout for a range-shaped stay (boarding, house sitting); NULL for a single-day
     *  service. Carried on the statement so payment attribution can measure a payment's proximity
     *  to the WHOLE stay rather than to the day it began — see `intervalDistance`
     *  (server/lib/payment-attribution.ts) and the preview route in `server/routes/admin.ts`. */
    endDate: string | null;
    status: string;
    /** The quote, or the assessed cancellation fee on a cancelled row — EXCLUDING extra charges,
     *  so a cancellation fee stays readable as its own figure rather than folded into one number. */
    cost: number;
    charges: { id: string; label: string; amount: number }[];
    chargesTotal: number;
    /** Payments recorded against THIS booking only — a household-level payment never appears here. */
    paidTotal: number;
    /** What this booking contributes to `expectedTotal`: `cost + chargesTotal`, or zero for a
     *  declined request — declined bookings are never billed at all, the same rule
     *  `CREDITABLE_AMOUNT_SQL` applies to the balance above. Sums to `expectedTotal` exactly. */
    expected: number;
  }[];
  /** Payments recorded against the HOUSEHOLD (0011) rather than any one booking — never attributed
   *  to a booking above, however convenient that would be to render. */
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

export type ProviderConnection = {
  Id: string;
  TenantId: string;
  Capability: string;
  Provider: string;
  Status: 'disconnected' | 'connected';
  ConnectedAt: string | null;
  CalendarId: string | null;
};

/** Server-internal: includes encrypted OAuth token columns. NEVER serialize to a client. */
export type ProviderConnectionWithTokens = ProviderConnection & {
  AccessToken: string | null;
  RefreshToken: string | null;
  TokenExpiresAt: string | null;
  CalendarId: string | null;
};

/** Hono generics: bindings come from worker-configuration.d.ts; per-request vars set by middleware. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    tenant: Tenant;
    endUserId: string;
    /** Which end-user credential `endUserAuth` accepted: the widget's 24h session token, or a
     *  personal access token (0012). Routes must NOT branch on this — both resolve to the same
     *  end user and confer identical authority — with the single exception of token management
     *  itself, which requires the widget session so a leaked token cannot mint its own
     *  replacement (`widgetSessionOnly`). */
    endUserCredential: 'widget' | 'token';
    /** Set by adminAuth: the authenticated sitter-admin's TenantUser id (AdminClaims.sub). */
    adminUserId: string;
    /** Set by ownerAuth: the authenticated platform-owner's email (OwnerClaims.sub). */
    ownerEmail: string;
  };
};
