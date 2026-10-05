import type { Me } from '../shared-ui/api';

/**
 * Whether the widget asks this signed-in client for a phone. ONLY when `/me` positively says there
 * is none on file (`phone: null`; the server already folds a blank or whitespace-only value into
 * that). When it cannot know — `/me` not loaded yet, a failed load, or a worker older than the field
 * — it does not ask: a prompt shown to someone who has a phone is the worse failure, and the booking
 * POST's `phone_required` refusal still brings the prompt up if one is genuinely missing.
 *
 * Its own module, free of `window`, so the decision can be tested without a DOM.
 */
export function needsPhone(me: Pick<Me, 'phone'> | null): boolean {
  return me !== null && me.phone === null;
}
