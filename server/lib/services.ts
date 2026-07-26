import {
  SERVICE_TEMPLATES,
  TEMPLATE_IDS,
  isTemplateId,
  type CapacityKind,
  type RateUnit,
  type ServiceShape,
  type ServiceTemplate,
  type TemplateId,
} from '../../src/shared/index.js';

/**
 * Service templates and pet species. The template DATA (and its types) now live in
 * `src/shared/service-templates.ts` so the admin bundle derives a template's rate unit rather
 * than restating it; they are re-exported here unchanged so server import sites stay put.
 * Services themselves are per-tenant TenantServices rows — every row carries its own behavior
 * (`Shape` decides availability + date inputs, `RateUnit` decides cost display, `CapacityKind`
 * names the capacity POOL it draws from). Templates exist only to (a) seed new tenants' defaults
 * and (b) back the admin "Add service" picker: creating a service clones a template's behavior
 * permanently, so sitters never mix arbitrary combos.
 */
export {
  SERVICE_TEMPLATES,
  TEMPLATE_IDS,
  isTemplateId,
  type CapacityKind,
  type RateUnit,
  type ServiceShape,
  type ServiceTemplate,
  type TemplateId,
};

/** Service identifiers are per-tenant slugs now — validated against TenantServices rows, not an enum. */
export type ServiceType = string;

/** Owner directive: cap the number of TenantServices rows (enabled or disabled) a tenant may
 * hold. Server-side source of truth — POST /:slug/admin/services is the only place a new row
 * gets created, and enforces this; UI disabled-states are convenience mirrors only. */
export const MAX_SERVICES = 6;

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
