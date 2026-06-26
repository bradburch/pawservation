// Vendored from @brad-paws/shared (brad-paws monorepo). Pure-JS booking/date/pricing
// logic — no third-party runtime deps. Drift from the source is an accepted trade-off
// for repo isolation (see docs/superpowers/specs Phase 0).
export { formatShortDate } from "./util/date-format.js";
export { addDays, nightsBetween, getPacificDateStr } from "./util/dates.js";
export {
  buildCapacity,
  rangeHasConflict,
  walkHasConflict,
  type CapacityEvent,
  type DayCapacity,
} from "./booking/capacity.js";
export { billableUnits } from "./pricing/booking-cost.js";
