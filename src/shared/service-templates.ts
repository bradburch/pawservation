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
  /**
   * The species a service created from this template STARTS accepting — the sensible first guess
   * for the offering, not a rule (walks are for dogs, drop-in visits are usually the cat's).
   * `null` = accept every registry type, the schema's null-is-unlimited convention, used where a
   * template genuinely suits any animal.
   *
   * It is only a CREATE-time default and it is never a constraint: the sitter re-checks boxes in
   * Accepted pets and the settings PUT overwrites it. Existing services are NOT backfilled —
   * silently narrowing a live service's acceptance would cancel bookings nobody asked to cancel.
   * The create path also INTERSECTS this with the tenant's actual pet-type registry and falls back
   * to `null` when the intersection is empty, because a tenant that deleted 'cat' would otherwise
   * get a check-in service accepting nothing — which the settings PUT then rejects on every save.
   */
  defaultAcceptedPetTypes: readonly string[] | null;
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
    defaultAcceptedPetTypes: null, // overnight stays suit any animal the sitter takes
  },
  housesitting: {
    label: 'House sitting',
    icon: 'home',
    shape: 'range',
    rateUnit: 'night',
    hasDuration: false,
    capacityKind: 'housesit',
    defaultAcceptedPetTypes: null, // the sitter is in the client's home; species is the client's call
  },
  daycare: {
    label: 'Daycare',
    icon: 'sun',
    shape: 'single',
    rateUnit: 'day',
    hasDuration: false,
    capacityKind: 'none',
    defaultAcceptedPetTypes: ['dog'],
  },
  walk: {
    label: 'Walk',
    icon: 'paw',
    shape: 'single',
    rateUnit: 'walk',
    hasDuration: true,
    capacityKind: 'none',
    defaultAcceptedPetTypes: ['dog'],
  },
  checkin: {
    label: 'Check-in',
    icon: 'clipboard',
    shape: 'single',
    rateUnit: 'visit',
    hasDuration: true,
    capacityKind: 'none',
    defaultAcceptedPetTypes: ['cat'],
  },
} as const satisfies Record<string, ServiceTemplate>;

export type TemplateId = keyof typeof SERVICE_TEMPLATES;

export const TEMPLATE_IDS = Object.keys(SERVICE_TEMPLATES) as TemplateId[];

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && Object.hasOwn(SERVICE_TEMPLATES, value);
}
