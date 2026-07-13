import type { CapacityKind, PetType, RateUnit, ServiceShape, ServiceType } from './lib/services';
import type { PaymentMethod } from './lib/validation';
import type { ServiceQuestion } from '../src/shared/index.js';

export type { CapacityKind, PetType, RateUnit, ServiceShape, ServiceType };

export type Tenant = {
  Id: string;
  Slug: string;
  DisplayName: string;
  AccentColor: string;
  MaxBoardingPets: number | null; // null = unlimited
  MaxHouseSitsPerDay: number | null; // null = unlimited
  MaxStayNights: number | null; // null = unlimited
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
};

export type TenantPetTypeRow = {
  TenantId: string;
  PetType: PetType;
  Enabled: number;
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
  PetType: 'dog' | 'cat';
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
 * month first, zero-filled. The route maps to camelCase and derives the stat tiles in JS. */
export type AnalyticsData = {
  monthly: { Month: string; Total: number }[];
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
  };
};
