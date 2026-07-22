import { describe, expect, it } from 'vitest';
import { signState, verifyState } from '../lib/oauth-state';
import { signSignupLink, verifySignupLink } from '../lib/signup-link';
import {
  RESET_LINK_TTL_SECONDS,
  RESET_NONCE_KEY,
  signResetLink,
  verifyResetLink,
  type ResetPayload,
} from '../lib/reset-link';

const SECRET = 'test-secret-0123456789';
const payload = (): ResetPayload => ({
  email: 'a@b.test',
  kind: 'sitter',
  nonce: 'n-1',
  exp: 2_000_000,
});

describe('reset link', () => {
  it('round-trips a valid payload (both kinds)', async () => {
    const p = payload();
    expect(await verifyResetLink(SECRET, await signResetLink(SECRET, p), 1_000_000)).toEqual(p);
    const o: ResetPayload = { ...p, kind: 'owner' };
    expect(await verifyResetLink(SECRET, await signResetLink(SECRET, o), 1_000_000)).toEqual(o);
  });

  it('rejects a tampered signature and a tampered body', async () => {
    const token = await signResetLink(SECRET, payload());
    const flip = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect(await verifyResetLink(SECRET, flip(token, token.length - 1), 0)).toBeNull();
    expect(await verifyResetLink(SECRET, flip(token, 1), 0)).toBeNull();
  });

  it('rejects an expired payload — `now` is injected, no clock stubbing', async () => {
    const token = await signResetLink(SECRET, payload()); // exp = 2_000_000
    expect(await verifyResetLink(SECRET, token, 1_999_999)).not.toBeNull();
    expect(await verifyResetLink(SECRET, token, 2_000_001)).toBeNull();
  });

  it('rejects malformed tokens and unknown kinds', async () => {
    expect(await verifyResetLink(SECRET, '', 0)).toBeNull();
    expect(await verifyResetLink(SECRET, 'no-dot-here', 0)).toBeNull();
    expect(await verifyResetLink(SECRET, 'a.b', 0)).toBeNull();
    const bad = await signResetLink(SECRET, { ...payload(), kind: 'other' as 'sitter' });
    expect(await verifyResetLink(SECRET, bad, 0)).toBeNull();
  });

  it('is domain-separated from oauth-state: same bytes never verify across modules', async () => {
    const both = { tenantId: 't', email: 'a@b.test', kind: 'sitter', nonce: 'n', exp: 2_000_000 };
    const asState = await signState(SECRET, both);
    expect(await verifyResetLink(SECRET, asState, 1_000_000)).toBeNull();
    const asReset = await signResetLink(SECRET, both as unknown as ResetPayload);
    expect(await verifyState(SECRET, asReset, 1_000_000)).toBeNull();
  });

  it('is domain-separated from signup links: a leaked reset link cannot complete a signup and vice versa', async () => {
    const p = payload();
    const resetToken = await signResetLink(SECRET, p);
    expect(await verifySignupLink(SECRET, resetToken, 1_000_000)).toBeNull();
    const signupToken = await signSignupLink(SECRET, p);
    expect(await verifyResetLink(SECRET, signupToken, 1_000_000)).toBeNull();
  });

  it('exports the agreed TTL and KV nonce key shape', () => {
    expect(RESET_LINK_TTL_SECONDS).toBe(1800);
    expect(RESET_NONCE_KEY('abc')).toBe('pwreset:nonce:abc');
  });
});
