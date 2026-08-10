import { describe, expect, it } from 'vitest';
import { parseEventSummary } from '../lib/calendar-backfill';

describe('parseEventSummary', () => {
  it('splits one pet and a service word', () => {
    expect(parseEventSummary('Sadie Walk')).toEqual({
      petNames: ['Sadie'],
      serviceHint: 'walk',
      cancelled: false,
    });
  });

  it('splits pets joined by "and"', () => {
    expect(parseEventSummary('Pedro and Remy')).toEqual({
      petNames: ['Pedro', 'Remy'],
      serviceHint: null,
      cancelled: false,
    });
  });

  it('reads a trailing CANCELLED marker and drops it from the names', () => {
    expect(parseEventSummary('Summer and Chia Walk - CANCELLED')).toEqual({
      petNames: ['Summer', 'Chia'],
      serviceHint: 'walk',
      cancelled: true,
    });
  });

  it("reads pawservation's own leading [CANCELLED] marker", () => {
    expect(parseEventSummary('[CANCELLED] Bella — Boarding')).toEqual({
      petNames: ['Bella'],
      serviceHint: 'boarding',
      cancelled: true,
    });
  });

  it('treats a [REQUEST] marker as not cancelled', () => {
    expect(parseEventSummary('[REQUEST] Bella — Boarding').cancelled).toBe(false);
  });

  it('returns no names for an empty summary', () => {
    expect(parseEventSummary('')).toEqual({ petNames: [], serviceHint: null, cancelled: false });
  });

  it('does not read a service word out of the middle of a pet name', () => {
    expect(parseEventSummary('Walker')).toEqual({
      petNames: ['Walker'],
      serviceHint: null,
      cancelled: false,
    });
  });

  it('leaves a non-service title as a single unmatched name', () => {
    // "Brad Unavailable" is a real title from the sitter's calendar. It names no service and no
    // known pet; it must survive parsing intact so the pet resolver can flag it, not vanish here.
    expect(parseEventSummary('Brad Unavailable')).toEqual({
      petNames: ['Brad Unavailable'],
      serviceHint: null,
      cancelled: false,
    });
  });
});
