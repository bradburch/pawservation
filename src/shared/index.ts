// Booking, date, and pricing core — pure TypeScript with no runtime dependencies.
export { formatShortDate, formatFriendlyDate, formatBlockRange } from './util/date-format.js';
export {
  serviceSummary,
  compactTime,
  type ServiceSummary,
  type ServiceSummaryInput,
  type ServiceSummaryOption,
} from './util/service-summary.js';
export {
  addDays,
  addMonths,
  isWeekend,
  nightsBetween,
  getPacificDateStr,
  parseDateUtc,
  MS_PER_DAY,
  DATE_RE,
  DEFAULT_TIMEZONE,
} from './util/dates.js';
export {
  holidayNameOn,
  holidaysForYear,
  holidaysInMonth,
  US_HOLIDAY_NAMES,
  type UsHoliday,
} from './util/us-holidays.js';
export {
  isDedicatedCalendarId,
  isPersonalCalendarTarget,
  MAX_BACKFILL_EVENTS,
  SECONDARY_CALENDAR_SUFFIX,
} from './util/calendar-target.js';
export {
  buildCapacity,
  // Deprecated alias of `whereaboutsDayBlocked`; see the comment beside it. Out-of-tree only.
  crossKindDayBlocked,
  isWellFormedCapacityEvent,
  overlapReadWindow,
  rangeConflictReason,
  rangeHasConflict,
  walkHasConflict,
  whereaboutsDayBlocked,
  type CapacityEvent,
  type CapacityRequest,
  type DayCapacity,
  type EventSpan,
  type KindOccupancy,
  type PoolKind,
  type RangeConflict,
} from './booking/capacity.js';
export { billableUnits } from './pricing/booking-cost.js';
export { isValidRate, isPetRateMode, type PetRateMode } from './pricing/rate.js';
export {
  isCalendarCostBasis,
  DEFAULT_CALENDAR_COST_BASIS,
  type CalendarCostBasis,
} from './pricing/calendar-cost-basis.js';
export {
  buildGroupKey,
  buildMixKey,
  dedupePets,
  mixFromPetTypes,
  parseMixKey,
  petCountOf,
  resolvePetSetRate,
  type GroupRate,
  type MixRate,
  type PetMix,
  type PricedPet,
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
  groupIntoAccounts,
  type AccountGroup,
  type OwnerPetSets,
} from './invoicing/account-groups.js';
export {
  buildHouseholdBalances,
  buildPaymentAnchors,
  type HouseholdBalance,
  type HouseholdBalances,
  type HouseholdBooking,
} from './invoicing/balances.js';
export {
  balancedRemainder,
  MAX_ATTRIBUTIONS_PER_REQUEST,
  sitterPicksFirst,
} from './invoicing/attribution-splits.js';
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
  questionShape,
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
export {
  validatePassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  type ValidatePasswordOptions,
} from './auth/password-policy.js';
