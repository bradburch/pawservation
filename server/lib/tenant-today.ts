import type { Tenant } from '../types';
import { DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';

/**
 * Today, as a `YYYY-MM-DD` date on the SITTER'S calendar — how a money route turns a tenant into a
 * date (a few older routes in `owner.ts`/`admin.ts` still compute their own inline copy). Money
 * readers take this as their `today` (a walk of a series is owed from its own date), so two routes
 * asking about the same household on the same instant cannot disagree about which day it is.
 *
 * A stored Timezone `Intl` does not recognise falls back to the instance default, as the export
 * route's filename does: `Intl` throws a RangeError on one, and a bad string in a settings column
 * must not turn a client's balance into a 500. `now` exists for tests; production passes nothing.
 */
export function tenantToday(tenant: Pick<Tenant, 'Timezone'>, now?: Date): string {
  const at = now ?? new Date();
  try {
    return getPacificDateStr(at, tenant.Timezone ?? DEFAULT_TIMEZONE);
  } catch {
    return getPacificDateStr(at, DEFAULT_TIMEZONE);
  }
}
