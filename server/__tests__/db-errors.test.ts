import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../lib/db-errors';

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
