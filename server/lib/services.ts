/**
 * Service TEMPLATES and pet species. Services themselves are per-tenant TenantServices rows —
 * every row carries its own behavior (`Shape` decides availability + date inputs, `RateUnit`
 * decides cost display, `CapacityKind` names the capacity POOL it draws from). Templates exist
 * only to (a) seed new tenants' defaults and (b) back the admin "Add service" picker: creating
 * a service clones a template's behavior permanently, so sitters never mix arbitrary combos.
 */

export type ServiceShape = 'range' | 'single';
export type RateUnit = 'night' | 'day' | 'visit';
/** 'boarding' = pet-counted vs MaxBoardingPets; 'housesit' = day-counted vs MaxHouseSitsPerDay;
 * 'none' = unlimited (blocked days only). Pool names, not service names. */
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

export const PET_TYPES = ['dog', 'cat'] as const;
export type PetType = (typeof PET_TYPES)[number];

export function isPetType(value: unknown): value is PetType {
  return typeof value === 'string' && (PET_TYPES as readonly string[]).includes(value);
}
