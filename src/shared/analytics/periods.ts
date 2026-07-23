/** A month bucket exactly as getAnalytics builds it: 'YYYY-MM' key + revenue total. */
export type MonthlyBucket = { Month: string; Total: number };

/** One quarter's revenue. `q` is 1..4. */
export type QuarterTotal = { q: number; total: number };

export type QuarterlyBreakdown = { ytd: number; quarters: QuarterTotal[] };

/**
 * Derive the current-year YTD total and Q1–Q4 revenue from a rolling monthly[] array.
 * Pure and clock-free: the caller passes `currentYear` (derived from `today`). Months whose
 * year !== currentYear are ignored; missing/zero months contribute 0, so all four quarter
 * slots are always present and a mid-year Q4 is simply 0.
 */
export function quarterlyBreakdown(
  monthly: MonthlyBucket[],
  currentYear: number,
): QuarterlyBreakdown {
  const quarters: QuarterTotal[] = [1, 2, 3, 4].map((q) => ({ q, total: 0 }));
  let ytd = 0;
  for (const { Month, Total } of monthly) {
    const [year, month] = Month.split('-').map(Number);
    if (year !== currentYear) continue;
    ytd += Total;
    quarters[Math.floor((month - 1) / 3)].total += Total; // month 1..12 → index 0..3
  }
  return { ytd, quarters };
}

/** First day ('YYYY-MM-01') of the quarter containing `month` (1..12) in `year`. */
export function quarterSinceDate(year: number, month: number): string {
  const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}
