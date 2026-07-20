// Booking, date, and pricing core — pure TypeScript with no runtime dependencies.
export { formatShortDate, formatBlockRange } from './util/date-format.js';
export {
  serviceSummary,
  type ServiceSummary,
  type ServiceSummaryInput,
  type ServiceSummaryOption,
} from './util/service-summary.js';
export {
  addDays,
  isWeekend,
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
  type CapacityRequest,
  type DayCapacity,
  type PoolKind,
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
  validatePetTypeAcceptance,
  type ServiceQuestion,
  type ServiceConstraints,
  type ServiceOption,
  type QuestionType,
} from './booking/service-rules.js';
export { PAYMENT_METHODS, isPaymentMethod, type PaymentMethod } from './payment-methods.js';
