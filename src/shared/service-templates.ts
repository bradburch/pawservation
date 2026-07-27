/**
 * Service TEMPLATES — the single definition of each template's behavior, shared by server and
 * client. Services themselves are per-tenant TenantServices rows: every row carries its own
 * behavior (`Shape` decides availability + date inputs, `RateUnit` decides cost display,
 * `CapacityKind` names the capacity POOL it draws from). Templates exist only to (a) seed new
 * tenants' defaults, (b) back the admin "Add service" picker, and (c) tell the setup wizard which
 * unit to print next to a price input — creating a service clones a template's behavior
 * permanently, so sitters never mix arbitrary combos.
 *
 * Lives here (not in `server/`) so the admin bundle can DERIVE the rate unit instead of restating
 * it; `server/lib/services.ts` re-exports these for the server's import sites.
 */

export type ServiceShape = 'range' | 'single';
export type RateUnit = 'night' | 'day' | 'visit' | 'walk';
/** 'boarding' and 'housesit' both count PETS against the service's own MaxConcurrentPets;
 * 'none' = unlimited (blocked days only). Capacity rules, not service names. */
export type CapacityKind = 'boarding' | 'housesit' | 'none';

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
    label: 'Daycare',
    icon: 'sun',
    shape: 'single',
    rateUnit: 'day',
    hasDuration: false,
    capacityKind: 'none',
  },
  walk: {
    label: 'Walk',
    icon: 'paw',
    shape: 'single',
    rateUnit: 'walk',
    hasDuration: true,
    capacityKind: 'none',
  },
  checkin: {
    label: 'Check-in',
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
