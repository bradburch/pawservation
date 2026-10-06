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

/**
 * THE price sentence. Every surface that states both plans states them in these words, so the tour,
 * the setup guide, the landing pricing section and the product llms.txt cannot drift into four
 * phrasings of one fact (they had: "$15 a month for one sitter", "$15 per sitter per month", ...).
 * Solo is one sitter, so it carries no "per sitter"; Pro sells extra sitters, so it does. Plain
 * text, no entities, because llms.txt is not HTML.
 */
export const PRICE_LINE = `Solo is $${PRICING.soloMonthly} a month. Pro is $${PRICING.proMonthly} a month or $${PRICING.proAnnual} a year, per sitter.`;

/**
 * What the trial is and what happens when it ends, VERIFIED rather than assumed:
 *  - signup (`routes/signup.ts`) asks for an email, a business name and a password, and writes the
 *    trial as a basic comp (`trialCompUntil`), so no card is asked for and the trial is Solo: a comp
 *    turns on no Pro surface (`isPremiumActive` reads `PremiumUntil` and a Pro plan, not the comp);
 *  - one trial per sitter (the founder's ruling, 2026-10-05): choosing a plan during it starts no
 *    second trial, so the first charge falls when this one ends;
 *  - with `PLAN_ENFORCE` on (wrangler.jsonc), a business with no current plan gets 402 on every
 *    dashboard WRITE (`planGate`) while reads, blocking dates and the public booking routes keep
 *    working: the dashboard goes read-only and her clients can still send requests.
 * HTML (it carries entities), and free of the word the landing and tour ban as a checkout verb.
 */
export const TRIAL_LINE = `The ${PRICING.trialDays}-day free trial is Solo, and you don&rsquo;t need a card to start it. Choose Pro during the trial and its assistant, booking by WhatsApp and card payments switch on right away; choosing a plan doesn&rsquo;t extend the trial, and you&rsquo;re first charged when it ends. If you haven&rsquo;t chosen a plan when the trial ends, your dashboard goes read-only until you do, and your clients can still send requests.`;
