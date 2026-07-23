import type { CapacityKind, PetType, RateUnit, ServiceShape, ServiceType } from './lib/services';
import type { PaymentMethod } from './lib/validation';
import type { ServiceQuestion, CancellationTier } from '../src/shared/index.js';

export type { CapacityKind, PetType, RateUnit, ServiceShape, ServiceType, CancellationTier };

export type Tenant = {
  Id: string;
  Slug: string;
  DisplayName: string;
  AccentColor: string;
  Timezone: string | null; // null = DEFAULT_TIMEZONE
  ContactEmail: string | null; // shown to clients in the booking widget
  ContactPhone: string | null; // shown to clients in the booking widget
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
  Shape: ServiceShape;
  RateUnit: RateUnit;
  HasDuration: number;
  CapacityKind: CapacityKind;
  SortOrder: number;
  Questions: ServiceQuestion[];
  MinNights: number | null;
  MaxNights: number | null;
  MinPetCount: number | null;
  MaxPetCount: number | null;
  /** Pet-type slugs this service accepts; null = accepts every enabled type. */
  AcceptedPetTypes: string[] | null;
  /** Pets per day cap for boarding and housesit pool services; null = unlimited; 0017 folds housesit MaxPerDay in. */
  MaxConcurrentPets: number | null;
  /** Tiered cancel policy; null = no fee (0016). */
  CancellationTiers: CancellationTier[] | null;
};

export type TenantServiceOption = {
  Id: string;
  TenantId: string;
  ServiceType: ServiceType;
  OptionKey: string;
  Label: string;
  DurationMinutes: number | null;
  Rate: number;
  RateUnit: RateUnit;
  StartTime: string | null; // 'HH:MM'; NULL = no fixed window
  EndTime: string | null; // 'HH:MM'; NULL = no fixed window
  Capacity: number | null; // max concurrent bookings/date; NULL = unlimited
  WeekdaysOnly: number; // int-bool: 1 = bookable Mon–Fri only
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
  PetType: PetType | null;
  PetCount: number;
  StartTime: string | null;
  GCalEventId: string | null;
  EstCost: number | null;
  /** Fee assessed at cancel time, whole dollars; null = none assessed (0016). */
  CancellationFee: number | null;
  Status: 'pending' | 'confirmed' | 'cancelled';
  // 1 = the cancellation was the sitter declining a pending request. Optional because only the
  // booking-list queries select it; capacity/availability queries never need it.
  Declined?: number;
  CreatedAt: string;
};

export type PaymentRow = {
  Id: string;
  TenantId: string;
  BookingRequestId: string;
  Amount: number;
  Method: PaymentMethod;
  PaidDate: string;
  Note: string | null;
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
    PaidTotal: number;
  }[];
};

export type ProviderConnection = {
  Id: string;
  TenantId: string;
  Capability: string;
  Provider: string;
  Status: 'disconnected' | 'connected-stub' | 'connected'; // 'connected-stub' is a legacy value from the removed stub-provider flow; no code path writes it anymore
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
    /** Set by ownerAuth: the authenticated platform-owner's email (OwnerClaims.sub). */
    ownerEmail: string;
  };
};
