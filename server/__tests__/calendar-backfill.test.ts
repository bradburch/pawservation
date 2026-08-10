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
});
