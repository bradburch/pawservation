import { describe, expect, it } from 'vitest';
import {
  isDedicatedCalendarId,
  isPersonalCalendarTarget,
  SECONDARY_CALENDAR_SUFFIX,
} from '../../src/shared/index.js';

/**
 * Which Google calendar is booking sync pointed at? Since PR #88 the connected calendar is READ —
 * every foreign event on it blocks booking requests — so "you are pointed at your personal
 * calendar" is the difference between a tidy mirror and a sitter's dentist appointments quietly
 * deleting her availability. We hold no identity scope, so this is decided by Google's own id
 * shape and nothing else.
 */
describe('isDedicatedCalendarId', () => {
  it('accepts a secondary calendar id (what calendars.insert returns)', () => {
    expect(isDedicatedCalendarId('pawservation123@group.calendar.google.com')).toBe(true);
  });

  it('is case- and whitespace-insensitive (the id arrives from a paste-in text field)', () => {
    expect(isDedicatedCalendarId('  ABC123@GROUP.CALENDAR.GOOGLE.COM  ')).toBe(true);
  });

  it('rejects the primary aliases: NULL, undefined, empty, and the literal "primary"', () => {
    expect(isDedicatedCalendarId(null)).toBe(false);
    expect(isDedicatedCalendarId(undefined)).toBe(false);
    expect(isDedicatedCalendarId('')).toBe(false);
    expect(isDedicatedCalendarId('   ')).toBe(false);
    expect(isDedicatedCalendarId('primary')).toBe(false);
  });

  it('rejects an account email address — the real id of a PRIMARY calendar', () => {
    // The trap this predicate exists for: a sitter follows Google's "Integrate calendar →
    // Calendar ID" instructions while standing on her main calendar and pastes this in.
    expect(isDedicatedCalendarId('dana@gmail.com')).toBe(false);
    expect(isDedicatedCalendarId('dana@happytails.example')).toBe(false);
  });

  it('rejects an unrecognised id — conservative by design', () => {
    // A false positive costs one sentence of advice; a false negative costs the sitter her
    // availability with no warning at all. Subscribed holiday feeds land here too
    // (…@group.v.calendar.google.com) and that is accepted.
    expect(isDedicatedCalendarId('en.usa#holiday@group.v.calendar.google.com')).toBe(false);
    expect(isDedicatedCalendarId('something-else')).toBe(false);
  });

  it('exports the suffix it matches on', () => {
    expect(SECONDARY_CALENDAR_SUFFIX).toBe('@group.calendar.google.com');
  });
});

describe('isPersonalCalendarTarget', () => {
  it('is the exact complement of isDedicatedCalendarId', () => {
    const ids = [
      null,
      undefined,
      '',
      'primary',
      'dana@gmail.com',
      'x@group.calendar.google.com',
      'en.usa#holiday@group.v.calendar.google.com',
    ];
    for (const id of ids) {
      expect(isPersonalCalendarTarget(id)).toBe(!isDedicatedCalendarId(id));
    }
  });

  it('warns for the default a fresh OAuth connect writes', () => {
    // server/routes/oauth.ts stores calendarId: 'primary' on connect — the common case.
    expect(isPersonalCalendarTarget('primary')).toBe(true);
  });
});
