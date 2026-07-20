import { describe, expect, it } from 'vitest';
import { serviceSummary, type ServiceSummaryInput } from '../../src/shared/index.js';

// ---------------------------------------------------------------------------
// serviceSummary — price + facts lines for the admin Services & rates cards
// (spec: docs/superpowers/specs/2026-07-19-services-rates-redesign.md)
// ---------------------------------------------------------------------------

type Opt = ServiceSummaryInput['options'][number];

function opt(over: Partial<Opt> = {}): Opt {
  return { rate: 20, startTime: null, endTime: null, capacity: null, weekdaysOnly: false, ...over };
}

function svc(over: Partial<ServiceSummaryInput> = {}): ServiceSummaryInput {
  return {
    rateUnit: 'visit',
    options: [],
    questions: [],
    minNights: null,
    maxNights: null,
    ...over,
  };
}

describe('serviceSummary price line', () => {
  it('zero options → "No pricing yet"', () => {
    expect(serviceSummary(svc()).price).toBe('No pricing yet');
  });

  it('one option → "$55/night"', () => {
    const s = svc({ rateUnit: 'night', options: [opt({ rate: 55 })] });
    expect(serviceSummary(s).price).toBe('$55/night');
  });

  it('differing rates → "from $20/visit" (minimum rate)', () => {
    const s = svc({ options: [opt({ rate: 35 }), opt({ rate: 20 }), opt({ rate: 30 })] });
    expect(serviceSummary(s).price).toBe('from $20/visit');
  });

  it('equal rates across options → "$20/visit · 2 options"', () => {
    expect(serviceSummary(svc({ options: [opt(), opt()] })).price).toBe('$20/visit · 2 options');
  });
});

describe('serviceSummary facts line', () => {
  it('windowed weekdays-only option → "Weekdays 10–2"', () => {
    const s = svc({ options: [opt({ startTime: '10:00', endTime: '14:00', weekdaysOnly: true })] });
    expect(serviceSummary(s).facts).toBe('Weekdays 10–2');
  });

  it('windowed non-weekdays option keeps non-zero minutes → "Daily 8:30–9"', () => {
    const s = svc({ options: [opt({ startTime: '08:30', endTime: '09:00' })] });
    expect(serviceSummary(s).facts).toBe('Daily 8:30–9');
  });

  it('midnight and noon both render as 12', () => {
    const s = svc({ options: [opt({ startTime: '00:00', endTime: '12:00' })] });
    expect(serviceSummary(s).facts).toBe('Daily 12–12');
  });

  it('capacity from the first capped option → "up to 8"', () => {
    const s = svc({ options: [opt(), opt({ capacity: 8 })] });
    expect(serviceSummary(s).facts).toBe('up to 8');
  });

  it('option count appears when the price line is "from …" (count not shown there)', () => {
    const s = svc({ options: [opt({ rate: 20 }), opt({ rate: 35 }), opt({ rate: 30 })] });
    expect(serviceSummary(s).facts).toBe('3 visit lengths');
  });

  it('option count is suppressed when the price line already shows it', () => {
    expect(serviceSummary(svc({ options: [opt(), opt()] })).facts).toBe('');
  });

  it('option count says "options" for non-visit rate units', () => {
    const s = svc({ rateUnit: 'night', options: [opt({ rate: 40 }), opt({ rate: 55 })] });
    expect(serviceSummary(s).facts).toBe('2 options');
  });

  it('min nights only → "Min 2 nights" (singular for 1)', () => {
    expect(serviceSummary(svc({ minNights: 2 })).facts).toBe('Min 2 nights');
    expect(serviceSummary(svc({ minNights: 1 })).facts).toBe('Min 1 night');
  });

  it('max nights only → "Max 14 nights"', () => {
    expect(serviceSummary(svc({ maxNights: 14 })).facts).toBe('Max 14 nights');
  });

  it('min and max nights → "2–14 nights"', () => {
    expect(serviceSummary(svc({ minNights: 2, maxNights: 14 })).facts).toBe('2–14 nights');
  });

  it('question count → "3 questions" / "1 question"', () => {
    expect(serviceSummary(svc({ questions: [1, 2, 3] })).facts).toBe('3 questions');
    expect(serviceSummary(svc({ questions: [1] })).facts).toBe('1 question');
  });

  it('caps at two fragments in priority order (window, capacity beat nights/questions)', () => {
    const s = svc({
      minNights: 2,
      questions: [1, 2],
      options: [opt({ startTime: '09:00', endTime: '17:00', capacity: 8 })],
    });
    expect(serviceSummary(s).facts).toBe('Daily 9–5 · up to 8');
  });

  it('nights then questions when nothing higher-priority applies', () => {
    const s = svc({
      rateUnit: 'night',
      minNights: 2,
      questions: [1, 2, 3],
      options: [opt({ rate: 55 })],
    });
    expect(serviceSummary(s).facts).toBe('Min 2 nights · 3 questions');
  });
});

describe('serviceSummary accepted-pets fact', () => {
  it('renders "X only" for a single accepted label, joined labels for several — lowest priority', () => {
    const one = svc({ options: [opt({ rate: 55 })], acceptedPetLabels: ['Dogs'] });
    expect(serviceSummary(one).facts).toBe('Dogs only');
    const two = svc({ options: [opt({ rate: 55 })], acceptedPetLabels: ['Dogs', 'Cats'] });
    expect(serviceSummary(two).facts).toBe('Dogs & Cats');
  });

  it('no fact when the service accepts all (null/undefined)', () => {
    expect(serviceSummary(svc({ options: [opt()], acceptedPetLabels: null })).facts).toBe('');
  });

  it('is crowded out by two higher-priority facts (cap of two)', () => {
    const s = svc({
      options: [opt({ startTime: '09:00', endTime: '17:00', capacity: 8 })],
      acceptedPetLabels: ['Dogs'],
    });
    expect(serviceSummary(s).facts).toBe('Daily 9–5 · up to 8');
  });
});
