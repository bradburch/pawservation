import { htmlEscape } from './email';

/**
 * Quotes from real sitters, shown on the landing page's "Who's behind it" section. EMPTY until the
 * owner adds one, and the page emits no markup for an empty list. Rules: a real person who said it,
 * with their written permission, never edited for meaning, never a composite. A fabricated quote on
 * a page that sells to small businesses is worse than none.
 */
export interface Testimonial {
  quote: string;
  name: string;
  business: string;
}

export const TESTIMONIALS: readonly Testimonial[] = [];

/** One `<figure>` per quote, every field escaped; an empty list renders nothing at all. */
export function testimonialsHtml(list: readonly Testimonial[] = TESTIMONIALS): string {
  return list
    .map(
      (t) =>
        `<figure class="quote"><blockquote>${htmlEscape(t.quote)}</blockquote><figcaption>${htmlEscape(t.name)}, ${htmlEscape(t.business)}</figcaption></figure>`,
    )
    .join('');
}
