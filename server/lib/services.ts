/**
 * Single source of truth for the service set and pet species. Every layer (schema CHECK lists,
 * validation, availability branching, widget rendering) derives from these constants instead of
 * repeating service-type string literals. `shape` decides availability + date inputs; `rateUnit`
 * decides cost display and the billable-units multiplier.
 */

export type ServiceShape = 'range' | 'single';
export type RateUnit = 'night' | 'day' | 'visit';

type CatalogEntry = {
  label: string;
  shape: ServiceShape;
  rateUnit: RateUnit;
  hasDuration: boolean;
};

export const SERVICE_CATALOG = {
  boarding: { label: 'Boarding', shape: 'range', rateUnit: 'night', hasDuration: false },
  housesitting: { label: 'House sitting', shape: 'range', rateUnit: 'night', hasDuration: false },
  daycare: { label: 'Day care', shape: 'single', rateUnit: 'day', hasDuration: false },
  walk: { label: 'Walks', shape: 'single', rateUnit: 'visit', hasDuration: true },
  checkin: { label: 'Check-ins', shape: 'single', rateUnit: 'visit', hasDuration: true },
} as const satisfies Record<string, CatalogEntry>;

export type ServiceType = keyof typeof SERVICE_CATALOG;

// Order is intentional (admin/widget render order); keep boarding first to match prior default.
export const SERVICE_TYPES = Object.keys(SERVICE_CATALOG) as ServiceType[];

export const PET_TYPES = ['dog', 'cat'] as const;
export type PetType = (typeof PET_TYPES)[number];

export function isServiceType(value: unknown): value is ServiceType {
  return typeof value === 'string' && value in SERVICE_CATALOG;
}

export function isPetType(value: unknown): value is PetType {
  return typeof value === 'string' && (PET_TYPES as readonly string[]).includes(value);
}
