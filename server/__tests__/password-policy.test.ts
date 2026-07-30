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
    'admin123456789',
    'trustno1trustno1',
  ])('rejects a denylisted/common password as a substring: %s', (candidate) => {
    expect(validatePassword(candidate)).not.toBeNull();
  });

  it('rejects a leet-substituted variant of a substring-denylisted word', () => {
    // '@' folds to 'a' BEFORE the alnum strip, so this doesn't dodge the "passw0rd" entry by
    // vanishing into 'pssw0rd12345'.
    expect(validatePassword('P@ssw0rd12345')).not.toBeNull();
    expect(validatePassword('pa$$word!!extra')).not.toBeNull();
  });

  it.each(['dragon', 'monkey', 'football', 'welcome', 'iloveyou'])(
    'rejects a single dictionary word padded to length, matched as the WHOLE password: %s',
    (word) => {
      // Padding with hyphens (stripped, not leet-folded) keeps the normalized form exactly equal
      // to the bare word while clearing the length floor.
      const padded = word + '-'.repeat(Math.max(0, MIN_PASSWORD_LENGTH - word.length));
      expect(validatePassword(padded)).not.toBeNull();
    },
  );

  it.each([
    'PurpleDragonSunset',
    'MonkeyBarsAtNoon99',
    'WelcomeToTheJungle2026',
    'TouchdownFootballFan1',
  ])(
    'does NOT reject a longer passphrase that merely CONTAINS a dictionary word: %s',
    (candidate) => {
      // These would have been wrongly rejected when dictionary words were substring-matched —
      // "dragon"/"monkey"/"football"/"welcome" are weak only as the whole password.
      expect(validatePassword(candidate)).toBeNull();
    },
  );

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

  // Regression: the email-similarity check normalizes BOTH the local part and the password to
  // ASCII-alnum-only before comparing. A password made entirely of characters that normalize
  // away to '' (emoji, CJK, Cyrillic, or enough symbols) used to make `local.includes('')` — a
  // vacuous, always-true containment check — reject every such password as "based on your email
  // address," even though it has nothing to do with the email. The fix requires the NORMALIZED
  // PASSWORD, not just the local part, to also clear MIN_EMAIL_LOCAL_PART_LENGTH before the
  // containment test runs at all.
  it.each([
    ['12 distinct emoji', '🐾🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁'],
    ['CJK characters', '正确的马电池订书钉钉钉子马正确的'],
    ['Cyrillic with symbol separators', 'пароль-надежный-длинный'],
    ['mostly symbols around 2 real letters', 'Ab!!!!!!!!!!'],
  ])(
    'does not reject a password that normalizes to empty/near-empty as "based on your email": %s',
    (_label, candidate) => {
      expect(Array.from(candidate).length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
      expect(validatePassword(candidate, { email: 'newsitter@pawservation.test' })).toBeNull();
    },
  );

  it('counts by code points, not UTF-16 code units', () => {
    // Every production call site (signup.ts, password-reset.ts, app/setup/App.tsx) always
    // passes an email — exercise the validator the same way, not in isolation, so a regression
    // in how the two checks interact (like the one above) shows up here too.
    const callerEmail = { email: 'newsitter@pawservation.test' };

    // 8 identical emoji: 16 UTF-16 code units but 8 code points — must still read as too short
    // (and, being a single repeated character, would also be rejected on that separate ground).
    const eightEmoji = '🐾'.repeat(8);
    expect(Array.from(eightEmoji).length).toBe(8);
    expect(eightEmoji.length).toBe(16); // sanity: UTF-16 units double-count astral characters
    const err = validatePassword(eightEmoji, callerEmail);
    expect(err).toMatch(new RegExp(`at least ${MIN_PASSWORD_LENGTH}`));

    // 12 code points of DISTINCT astral characters (24 UTF-16 code units) must be accepted on
    // length grounds alone — not penalized for being "24 characters" under a UTF-16-length
    // reading, not caught by the repeated-character rule since each one differs, and not caught
    // by the email-similarity check since it normalizes to '' (see the regression test above).
    const twelveDistinctEmoji = '🐾🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁';
    expect(Array.from(twelveDistinctEmoji).length).toBe(12);
    expect(validatePassword(twelveDistinctEmoji, callerEmail)).toBeNull();
  });
});
