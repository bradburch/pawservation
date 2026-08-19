import { describe, expect, it } from 'vitest';
import { isNotNullViolation, isUniqueViolation } from '../lib/db-errors';

describe('isUniqueViolation', () => {
  it('hits on a direct UNIQUE constraint message', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: Foo.Bar'))).toBe(true);
  });

  it('hits when the UNIQUE message is wrapped in err.cause (D1 driver wrapping)', () => {
    const outer = new Error('D1_ERROR');
    outer.cause = new Error('UNIQUE constraint failed: Foo.Bar');
    expect(isUniqueViolation(outer)).toBe(true);
  });

  it('misses on an unrelated error', () => {
    expect(isUniqueViolation(new Error('no such table: Foo'))).toBe(false);
  });
});

describe('isNotNullViolation', () => {
  // How attribution's in-batch guards report a lost race: a guard's scalar subquery yields NULL,
  // `amount * NULL` is NULL, and `Payments.Amount INTEGER NOT NULL` refuses the INSERT, rolling
  // back the batch. Recognising it is what turns an abort into a readable refusal instead of a
  // generic fault.
  it('matches SQLite refusing a NULL Payments.Amount', () => {
    expect(isNotNullViolation(new Error('NOT NULL constraint failed: Payments.Amount'))).toBe(true);
  });

  it('unwraps a D1-wrapped cause', () => {
    const wrapped = new Error('D1_ERROR', {
      cause: new Error('NOT NULL constraint failed: Payments.Amount'),
    });
    expect(isNotNullViolation(wrapped)).toBe(true);
  });

  // Narrow ON PURPOSE. A NULL in some other column is a genuine fault, and reporting it as this
  // race would tell the sitter a booking changed when nothing of the kind happened.
  it('does not match a NOT NULL violation on any other column', () => {
    expect(isNotNullViolation(new Error('NOT NULL constraint failed: Payments.Method'))).toBe(
      false,
    );
    expect(
      isNotNullViolation(new Error('NOT NULL constraint failed: BookingRequests.StartDate')),
    ).toBe(false);
  });

  it('does not match a unique violation or a non-Error', () => {
    expect(isNotNullViolation(new Error('UNIQUE constraint failed: Payments.Id'))).toBe(false);
    expect(isNotNullViolation('NOT NULL constraint failed: Payments.Amount')).toBe(false);
    expect(isNotNullViolation(null)).toBe(false);
  });
});
