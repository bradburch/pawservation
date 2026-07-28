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
export { isValidRate } from './pricing/rate.js';
export {
  buildGroupKey,
  buildMixKey,
  mixFromPetTypes,
  parseMixKey,
  petCountOf,
  resolvePetSetRate,
  type GroupRate,
  type MixRate,
  type PetMix,
  type RateResolution,
} from './pricing/pet-set-rates.js';
export {
  SERVICE_TEMPLATES,
  TEMPLATE_IDS,
  isTemplateId,
  type CapacityKind,
  type RateUnit,
  type ServiceShape,
  type ServiceTemplate,
  type TemplateId,
} from './service-templates.js';
export { buildAccounts, type Account, type OwnerPetLink } from './invoicing/accounts.js';
export {
  cancellationFee,
  validateCancellationTiers,
  type CancellationTier,
} from './pricing/cancellation-fee.js';
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
export {
  quarterlyBreakdown,
  quarterSinceDate,
  type MonthlyBucket,
  type QuarterTotal,
  type QuarterlyBreakdown,
} from './analytics/periods.js';
