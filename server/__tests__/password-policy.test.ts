import { describe, expect, it } from 'vitest';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
} from '../../src/shared/index.js';

describe('validatePassword', () => {
  it('accepts a reasonable password', () => {
    expect(validatePassword('RiverStone2026')).toBeNull();
  });

  it('rejects a password shorter than the minimum', () => {
    const err = validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(err).toMatch(new RegExp(`at least ${MIN_PASSWORD_LENGTH}`));
  });

  it('accepts a password at exactly the minimum length', () => {
    // 12 distinct-ish characters, not on the denylist and not all one character.
    expect(validatePassword('Xk9mQp4wTz7L'.slice(0, MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('rejects a password longer than the maximum', () => {
    const err = validatePassword('Xk9mQp4wTz7L'.repeat(20).slice(0, MAX_PASSWORD_LENGTH + 1));
    expect(err).toMatch(new RegExp(`at most ${MAX_PASSWORD_LENGTH}`));
  });

  it('accepts a password at exactly the maximum length', () => {
    expect(validatePassword('Xk9mQp4wTz7L'.repeat(20).slice(0, MAX_PASSWORD_LENGTH))).toBeNull();
  });

  it('rejects a single repeated character regardless of length', () => {
    expect(validatePassword('a'.repeat(20))).not.toBeNull();
  });

  it.each([
    'password123456',
    'PASSWORD123456',
    'Sup3rPassword!!',
    'qwertyuiop1234',
    '123456789012',
    'iloveyoutoday',
    'welcomehome123',
    'admin123456789',
    'trustno1trustno1',
  ])('rejects a denylisted/common password: %s', (candidate) => {
    expect(validatePassword(candidate)).not.toBeNull();
  });

  it('rejects a password containing the email local part', () => {
    expect(validatePassword('mysecretjsmith99', { email: 'jsmith@example.com' })).not.toBeNull();
  });

  it('rejects a password that is contained by the email local part', () => {
    expect(
      validatePassword('jonathansmith', { email: 'jonathansmith1985@example.com' }),
    ).not.toBeNull();
  });

  it('ignores a too-short local part rather than rejecting almost everything', () => {
    // A 2-character local part would otherwise make nearly any password "contain" it.
    expect(validatePassword('RiverStone2026', { email: 'jo@example.com' })).toBeNull();
  });

  it('accepts a password unrelated to the supplied email', () => {
    expect(validatePassword('RiverStone2026', { email: 'jsmith@example.com' })).toBeNull();
  });

  it('counts by code points, not UTF-16 code units', () => {
    // 8 identical emoji: 16 UTF-16 code units but 8 code points — must still read as too short
    // (and, being a single repeated character, would also be rejected on that separate ground).
    const eightEmoji = '🐾'.repeat(8);
    expect(Array.from(eightEmoji).length).toBe(8);
    expect(eightEmoji.length).toBe(16); // sanity: UTF-16 units double-count astral characters
    const err = validatePassword(eightEmoji);
    expect(err).toMatch(new RegExp(`at least ${MIN_PASSWORD_LENGTH}`));

    // 12 code points of DISTINCT astral characters (24 UTF-16 code units) must be accepted on
    // length grounds alone — not penalized for being "24 characters" under a UTF-16-length
    // reading, and not caught by the repeated-character rule since each one differs.
    const twelveDistinctEmoji = '🐾🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁';
    expect(Array.from(twelveDistinctEmoji).length).toBe(12);
    expect(validatePassword(twelveDistinctEmoji)).toBeNull();
  });
});
