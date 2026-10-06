import type { Tenant } from '../types';
import { DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';

/**
 * Today, as a `YYYY-MM-DD` date on the SITTER'S calendar — the one place a route turns a tenant
 * into a date. Money readers take this as their `today` (a walk of a series is owed from its own
 * date), so two routes asking about the same household on the same instant cannot disagree about
 * which day it is. `now` exists for tests; production passes nothing.
 */
export function tenantToday(tenant: Pick<Tenant, 'Timezone'>, now?: Date): string {
  return getPacificDateStr(now ?? new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
}
