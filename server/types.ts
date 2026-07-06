import type { PetType, RateUnit, ServiceType } from './lib/services';
import type { ServiceQuestion } from '../src/shared/index.js';

export type { PetType, RateUnit, ServiceType };

export type Tenant = {
  Id: string;
  Slug: string;
  DisplayName: string;
  AccentColor: string;
  MaxBoardingPets: number | null; // null = unlimited
  MaxHouseSitsPerDay: number | null; // null = unlimited
  MaxStayNights: number | null; // null = unlimited
  Timezone: string | null; // null = DEFAULT_TIMEZONE
};

export type TenantUser = {
  Id: string;
  TenantId: string;
  Email: string;
  PasswordHash: string;
};

export type TenantService = {
  TenantId: string;
  ServiceType: ServiceType;
  Enabled: number;
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
  Status: 'invited' | 'active';
  InvitedAt: string | null;
};

export type EndUserPet = {
  Id: string;
  TenantId: string;
  EndUserId: string;
  Name: string;
  PetType: 'dog' | 'cat';
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
  CreatedAt: string;
};

export type ProviderConnection = {
  Id: string;
  TenantId: string;
  Capability: string;
  Provider: string;
  Status: 'disconnected' | 'connected-stub' | 'connected';
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
