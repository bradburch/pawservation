// Booking, date, and pricing core — pure TypeScript with no runtime dependencies.
export { formatShortDate, formatBlockRange } from './util/date-format.js';
export {
  addDays,
  nightsBetween,
  getPacificDateStr,
  DATE_RE,
  DEFAULT_TIMEZONE,
} from './util/dates.js';
export {
  buildCapacity,
  rangeHasConflict,
  walkHasConflict,
  type CapacityEvent,
  type CapacityLimits,
  type DayCapacity,
} from './booking/capacity.js';
export { billableUnits } from './pricing/booking-cost.js';
export {
  monthGrid,
  shiftMonth,
  nextRangeSelection,
  isDateSelected,
  rangePosition,
  type RangePosition,
  type RangeValue,
} from './booking/calendar-ui.js';
export {
  validateAnswer,
  validateAnswers,
  validateServiceConstraints,
  type ServiceQuestion,
  type ServiceConstraints,
  type QuestionType,
} from './booking/service-rules.js';
