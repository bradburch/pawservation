/** Request-type union for external capacity-query mirrors (no in-repo importers since the 0015
 * per-service rework — findOpenings now takes a CapacityRequest / `timed` flag). Kept as shared API. */
export type RequestType = 'boarding' | 'house-sit' | 'walk' | 'check-in';
