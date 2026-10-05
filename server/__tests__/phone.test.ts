import { describe, expect, it } from 'vitest';
import { MAX_PHONE_LENGTH, MIN_PHONE_DIGITS, phoneOnFile, validatePhone } from '../lib/phone';

describe('validatePhone', () => {
  it('accepts what people actually type, trimmed and otherwise verbatim', () => {
    for (const typed of [
      '(555) 555-0100',
      '555.555.0100',
      '+44 20 7946 0958',
      '(555) 555-0100 ext 12',
      '555 0100 (mum)',
      '5550100',
    ])
      expect(validatePhone(`  ${typed}\t`)).toEqual({ ok: true, phone: typed });
  });

  it('refuses a missing or blank phone as required', () => {
    for (const input of [undefined, null, '', '   ', '\t\n'])
      expect(validatePhone(input)).toEqual({
        ok: false,
        code: 'phone_required',
        reason: 'Enter a phone number.',
      });
  });

  it('refuses a non-string as invalid, never as a coerced number', () => {
    expect(validatePhone(5555550100)).toMatchObject({ ok: false, code: 'phone_invalid' });
    expect(validatePhone(['555-0100'])).toMatchObject({ ok: false, code: 'phone_invalid' });
  });

  it(`refuses fewer than ${MIN_PHONE_DIGITS} digits, and accepts exactly ${MIN_PHONE_DIGITS}`, () => {
    for (const typed of ['n/a', '-', 'ask Tina', '555-010', '１２３４５６７'])
      expect(validatePhone(typed)).toMatchObject({ ok: false, code: 'phone_invalid' });
    expect(validatePhone('555-0100')).toEqual({ ok: true, phone: '555-0100' });
  });

  it(`refuses more than ${MAX_PHONE_LENGTH} characters after trimming, and accepts exactly ${MAX_PHONE_LENGTH}`, () => {
    const exact = '5'.repeat(MAX_PHONE_LENGTH);
    expect(validatePhone(`  ${exact}  `)).toEqual({ ok: true, phone: exact });
    expect(validatePhone(`${exact}5`)).toMatchObject({ ok: false, code: 'phone_invalid' });
  });
});

describe('phoneOnFile', () => {
  it('treats null, empty and whitespace-only as nothing on file', () => {
    for (const stored of [null, undefined, '', '   ', '\t']) expect(phoneOnFile(stored)).toBeNull();
  });

  it('returns a stored phone trimmed, without re-judging it by the digit rule', () => {
    expect(phoneOnFile(' (555) 555-0142 ')).toBe('(555) 555-0142');
    expect(phoneOnFile('ext 12')).toBe('ext 12');
  });
});
