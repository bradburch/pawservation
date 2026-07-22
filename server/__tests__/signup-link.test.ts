import { describe, expect, it } from 'vitest';
import { signState, verifyState } from '../lib/oauth-state';
import {
  INVITE_LINK_TTL_SECONDS,
  mintLink,
  SIGNUP_LINK_TTL_SECONDS,
  SIGNUP_NONCE_KEY,
  signSignupLink,
  verifySignupLink,
  type SignupPayload,
} from '../lib/signup-link';
import { createTestEnv } from './helpers';

const SECRET = 'test-secret-0123456789';
const payload = (): SignupPayload => ({
  email: 'a@b.test',
  kind: 'sitter',
  nonce: 'n-1',
  exp: 2_000_000,
});

describe('signup link', () => {
  it('round-trips a valid payload (both kinds)', async () => {
    const p = payload();
    expect(await verifySignupLink(SECRET, await signSignupLink(SECRET, p), 1_000_000)).toEqual(p);
    const o: SignupPayload = { ...p, kind: 'owner' };
    expect(await verifySignupLink(SECRET, await signSignupLink(SECRET, o), 1_000_000)).toEqual(o);
  });

  it('rejects a tampered signature and a tampered body', async () => {
    const token = await signSignupLink(SECRET, payload());
    const flip = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect(await verifySignupLink(SECRET, flip(token, token.length - 1), 0)).toBeNull(); // sig
    expect(await verifySignupLink(SECRET, flip(token, 1), 0)).toBeNull(); // body
  });

  it('rejects an expired payload — `now` is injected, no clock stubbing', async () => {
    const token = await signSignupLink(SECRET, payload()); // exp = 2_000_000
    expect(await verifySignupLink(SECRET, token, 1_999_999)).not.toBeNull();
    expect(await verifySignupLink(SECRET, token, 2_000_001)).toBeNull();
  });

  it('rejects malformed tokens and unknown kinds', async () => {
    expect(await verifySignupLink(SECRET, '', 0)).toBeNull();
    expect(await verifySignupLink(SECRET, 'no-dot-here', 0)).toBeNull();
    expect(await verifySignupLink(SECRET, 'a.b', 0)).toBeNull();
    const bad = await signSignupLink(SECRET, { ...payload(), kind: 'reset' as 'sitter' });
    expect(await verifySignupLink(SECRET, bad, 0)).toBeNull();
  });

  it('is domain-separated from oauth-state: same bytes never verify across modules', async () => {
    // A payload shaped valid for BOTH verifiers — only the HKDF info label differs.
    const both = { tenantId: 't', email: 'a@b.test', kind: 'sitter', nonce: 'n', exp: 2_000_000 };
    const asState = await signState(SECRET, both);
    expect(await verifySignupLink(SECRET, asState, 1_000_000)).toBeNull();
    const asSignup = await signSignupLink(SECRET, both as unknown as SignupPayload);
    expect(await verifyState(SECRET, asSignup, 1_000_000)).toBeNull();
  });

  it('exports the agreed TTL and KV nonce key shape', () => {
    expect(SIGNUP_LINK_TTL_SECONDS).toBe(1800);
    expect(SIGNUP_NONCE_KEY('abc')).toBe('signup:nonce:abc');
  });
});

describe('mintLink', () => {
  it('mints a /setup link whose token + nonce carry the requested TTL', async () => {
    const { env } = createTestEnv();
    const before = Date.now();
    const url = await mintLink(
      env,
      'https://x.test',
      'sitter@x.test',
      'sitter',
      INVITE_LINK_TTL_SECONDS,
    );
    expect(url).toMatch(/^https:\/\/x\.test\/setup\?t=/);

    const token = new URL(url).searchParams.get('t')!;
    const payload = await verifySignupLink(env.TOKEN_SECRET, token, Date.now());
    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe('sitter');
    expect(payload!.email).toBe('sitter@x.test');
    // exp is ~7 days out (>= start + full TTL).
    expect(payload!.exp).toBeGreaterThanOrEqual(before + INVITE_LINK_TTL_SECONDS * 1000);

    // The single-use nonce was registered so /signup/complete can consume it.
    const seen = await env.PAWBOOK_CACHE.get(SIGNUP_NONCE_KEY(payload!.nonce));
    expect(seen).toBe('1');

    // Valid right before exp, invalid just after.
    expect(await verifySignupLink(env.TOKEN_SECRET, token, payload!.exp - 1)).not.toBeNull();
    expect(await verifySignupLink(env.TOKEN_SECRET, token, payload!.exp + 1)).toBeNull();
  });

  it('exports the 7-day invite TTL (604800s)', () => {
    expect(INVITE_LINK_TTL_SECONDS).toBe(604800);
  });
});
