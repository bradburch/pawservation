/**
 * Service TEMPLATES and pet species. Services themselves are per-tenant TenantServices rows —
 * every row carries its own behavior (`Shape` decides availability + date inputs, `RateUnit`
 * decides cost display, `CapacityKind` names the capacity POOL it draws from). Templates exist
 * only to (a) seed new tenants' defaults and (b) back the admin "Add service" picker: creating
 * a service clones a template's behavior permanently, so sitters never mix arbitrary combos.
 */

export type ServiceShape = 'range' | 'single';
export type RateUnit = 'night' | 'day' | 'visit';
/** 'boarding' and 'housesit' both count PETS against the service's own MaxConcurrentPets;
 * 'none' = unlimited (blocked days only). Capacity rules, not service names. */
export type CapacityKind = 'boarding' | 'housesit' | 'none';

/** Service identifiers are per-tenant slugs now — validated against TenantServices rows, not an enum. */
export type ServiceType = string;

export type ServiceTemplate = {
  label: string;
  icon: string;
  shape: ServiceShape;
  rateUnit: RateUnit;
  hasDuration: boolean;
  capacityKind: CapacityKind;
};

// Order is intentional (admin/widget render order); keep boarding first to match prior default.
export const SERVICE_TEMPLATES = {
  boarding: {
    label: 'Boarding',
    icon: 'bed',
    shape: 'range',
    rateUnit: 'night',
    hasDuration: false,
    capacityKind: 'boarding',
  },
  housesitting: {
    label: 'House sitting',
    icon: 'home',
    shape: 'range',
    rateUnit: 'night',
    hasDuration: false,
    capacityKind: 'housesit',
  },
  daycare: {
    label: 'Day care',
    icon: 'sun',
    shape: 'single',
    rateUnit: 'day',
    hasDuration: false,
    capacityKind: 'none',
  },
  walk: {
    label: 'Walks',
    icon: 'paw',
    shape: 'single',
    rateUnit: 'visit',
    hasDuration: true,
    capacityKind: 'none',
  },
  checkin: {
    label: 'Check-ins',
    icon: 'clipboard',
    shape: 'single',
    rateUnit: 'visit',
    hasDuration: true,
    capacityKind: 'none',
  },
} as const satisfies Record<string, ServiceTemplate>;

/** Owner directive: cap the number of TenantServices rows (enabled or disabled) a tenant may
 * hold. Server-side source of truth — POST /:slug/admin/services is the only place a new row
 * gets created, and enforces this; UI disabled-states are convenience mirrors only. */
export const MAX_SERVICES = 6;

export type TemplateId = keyof typeof SERVICE_TEMPLATES;

export const TEMPLATE_IDS = Object.keys(SERVICE_TEMPLATES) as TemplateId[];

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && Object.hasOwn(SERVICE_TEMPLATES, value);
}

/** 'blocked' is a BookingRequests sentinel (admin time-off), never a bookable service slug. */
export const RESERVED_SERVICE_SLUGS = ['blocked'];

/** "Morning Walk!" → 'morning-walk'. Empty result = label has no derivable identity (reject it). */
export function slugifyServiceLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Pet species are per-tenant TenantPetTypes rows now (slug + Label) — validated against rows,
 * not an enum, exactly like ServiceType. */
export type PetType = string;
