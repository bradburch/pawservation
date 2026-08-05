import { signLink, verifyLink } from './signed-link';

/**
 * Signed, single-use, expiring account-setup links. Single-use is enforced by the routes:
 * `signup:nonce:{nonce}` is written to PAWSERVATION_CACHE at issue (matching expirationTtl) and
 * consumed at completion. See `signed-link.ts` for the signing/verification primitive and its
 * domain-separation guarantee — this module's label (`pawbook-signup-link`) is what keeps a
 * signup link from ever verifying as an OAuth state (`oauth-state.ts`) or a password-reset link
 * (`reset-link.ts`), and vice versa.
 */
const LABEL = 'pawbook-signup-link';

export const SIGNUP_LINK_TTL_SECONDS = 30 * 60;

/** 7 days — the owner-console invite link lives far longer than the 30-minute self-serve link. */
export const INVITE_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

export const SIGNUP_NONCE_KEY = (nonce: string) => `signup:nonce:${nonce}`;

export type SignupPayload = {
  email: string;
  kind: 'sitter' | 'owner';
  nonce: string;
  exp: number;
};

function isSignupPayload(payload: unknown): payload is SignupPayload {
  const p = payload as Partial<SignupPayload> | null;
  return (
    typeof p?.email === 'string' &&
    (p.kind === 'sitter' || p.kind === 'owner') &&
    typeof p.nonce === 'string' &&
    typeof p.exp === 'number'
  );
}

export async function signSignupLink(secret: string, payload: SignupPayload): Promise<string> {
  return signLink(LABEL, secret, payload);
}

export async function verifySignupLink(
  secret: string,
  token: string,
  nowMs: number,
): Promise<SignupPayload | null> {
  return verifyLink(LABEL, secret, token, isSignupPayload, nowMs);
}

/**
 * Mint a `/setup?t=` link and register its single-use nonce in KV under the SAME expiry as the
 * token, so a link and its nonce die together. `ttlSeconds` sets both — 30 min for the self-serve
 * flow (SIGNUP_LINK_TTL_SECONDS), 7 days for an owner invite (INVITE_LINK_TTL_SECONDS).
 */
export async function mintLink(
  env: Env,
  origin: string,
  email: string,
  kind: 'sitter' | 'owner',
  ttlSeconds: number,
): Promise<string> {
  const nonce = crypto.randomUUID();
  await env.PAWSERVATION_CACHE.put(SIGNUP_NONCE_KEY(nonce), '1', { expirationTtl: ttlSeconds });
  const token = await signSignupLink(env.TOKEN_SECRET, {
    email,
    kind,
    nonce,
    exp: Date.now() + ttlSeconds * 1000,
  });
  return `${origin}/setup?t=${token}`;
}
