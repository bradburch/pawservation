import { describe, expect, it } from 'vitest';
import {
  validateAnswer,
  validateAnswers,
  validateServiceConstraints,
  type ServiceQuestion,
} from '../../src/shared/index.js';

const question = (overrides: Partial<ServiceQuestion> = {}): ServiceQuestion => ({
  id: 'q1',
  label: 'Any allergies?',
  type: 'text',
  required: false,
  ...overrides,
});

describe('validateAnswer', () => {
  it('requires a value when required is true', () => {
    expect(validateAnswer(question({ required: true }), '')).toBe('Any allergies? is required.');
    expect(validateAnswer(question({ required: true }), undefined)).toBe(
      'Any allergies? is required.',
    );
  });

  it('allows an empty optional answer', () => {
    expect(validateAnswer(question({ required: false }), '')).toBeNull();
  });

  it('validates yes/no answers', () => {
    const q = question({ type: 'yesno', label: 'Crate trained?' });
    expect(validateAnswer(q, 'yes')).toBeNull();
    expect(validateAnswer(q, 'no')).toBeNull();
    expect(validateAnswer(q, 'maybe')).toBe('Crate trained? must be yes or no.');
  });

  it('validates number bounds inclusively', () => {
    const q = question({ type: 'number', label: 'Years vaccinated', min: 1, max: 10 });
    expect(validateAnswer(q, '1')).toBeNull();
    expect(validateAnswer(q, '10')).toBeNull();
    expect(validateAnswer(q, '0')).toBe('Years vaccinated must be at least 1.');
    expect(validateAnswer(q, '11')).toBe('Years vaccinated must be at most 10.');
    expect(validateAnswer(q, 'abc')).toBe('Years vaccinated must be a number.');
  });

  it('validates select options', () => {
    const q = question({
      type: 'select',
      label: 'Feeding schedule',
      options: ['morning', 'evening'],
    });
    expect(validateAnswer(q, 'morning')).toBeNull();
    expect(validateAnswer(q, 'afternoon')).toBe(
      'Feeding schedule must be one of the listed options.',
    );
  });

  it('validates a text pattern when present', () => {
    const q = question({ pattern: '^[0-9]{5}$', label: 'Zip code' });
    expect(validateAnswer(q, '94103')).toBeNull();
    expect(validateAnswer(q, 'abcde')).toBe('Zip code is not in the expected format.');
  });

  it('rejects an overlong answer against a pattern before running the regex (ReDoS safety rail)', () => {
    const q = question({ pattern: '^[0-9]{5}$', label: 'Zip code' });
    const overlong = '9'.repeat(101);
    expect(validateAnswer(q, overlong)).toBe('Zip code is too long.');
  });
});

describe('validateAnswers', () => {
  it('returns the first error found across multiple questions', () => {
    const questions = [
      question({ id: 'q1', required: true, label: 'First' }),
      question({ id: 'q2', required: true, label: 'Second' }),
    ];
    expect(validateAnswers(questions, { q1: 'ok' })).toBe('Second is required.');
    expect(validateAnswers(questions, { q1: 'ok', q2: 'ok' })).toBeNull();
  });
});

describe('validateServiceConstraints', () => {
  const noLimits = { minNights: null, maxNights: null, minPetCount: null, maxPetCount: null };

  it('passes when every constraint is null (auto pass-through)', () => {
    expect(validateServiceConstraints(noLimits, { nights: 1, petCount: 50 })).toBeNull();
  });

  it('enforces min/max nights at the boundary', () => {
    const c = { ...noLimits, minNights: 2, maxNights: 5 };
    expect(validateServiceConstraints(c, { nights: 2, petCount: 1 })).toBeNull();
    expect(validateServiceConstraints(c, { nights: 5, petCount: 1 })).toBeNull();
    expect(validateServiceConstraints(c, { nights: 1, petCount: 1 })).toBe(
      'This service requires at least 2 nights.',
    );
    expect(validateServiceConstraints(c, { nights: 6, petCount: 1 })).toBe(
      'This service allows at most 5 nights.',
    );
  });

  it('ignores night constraints for non-range services (nights: null)', () => {
    const c = { ...noLimits, minNights: 2 };
    expect(validateServiceConstraints(c, { nights: null, petCount: 1 })).toBeNull();
  });

  it('enforces min/max pet count at the boundary', () => {
    const c = { ...noLimits, minPetCount: 1, maxPetCount: 2 };
    expect(validateServiceConstraints(c, { nights: null, petCount: 1 })).toBeNull();
    expect(validateServiceConstraints(c, { nights: null, petCount: 2 })).toBeNull();
    expect(validateServiceConstraints(c, { nights: null, petCount: 3 })).toBe(
      'This service allows at most 2 pets.',
    );
  });
});
