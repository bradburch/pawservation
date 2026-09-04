/**
 * The plan prices, in one place, because three surfaces state them and any two of them
 * disagreeing is a pricing lie: the landing page's pricing section and hero chip
 * (`server/index.ts`), the product llms.txt, and the homepage `SoftwareApplication` offers
 * (`server/lib/llms.ts`). Never hardcode one of these figures at a call site.
 *
 * `trialDays` is here for the same reason the dollar figures are: the trial length is stated on
 * the hero chip, in the pricing section, on the tour and in llms.txt, so it moves in one edit.
 */
export const PRICING = {
  soloMonthly: 15,
  proMonthly: 29,
  proAnnual: 290,
  trialDays: 30,
} as const;
