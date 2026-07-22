import { signLink, verifyLink } from './signed-link';

/**
 * Signed, single-use, expiring account-setup links. Single-use is enforced by the routes:
 * `signup:nonce:{nonce}` is written to PAWBOOK_CACHE at issue (matching expirationTtl) and
 * consumed at completion. See `signed-link.ts` for the signing/verification primitive and its
 * domain-separation guarantee — this module's label (`pawbook-signup-link`) is what keeps a
 * signup link from ever verifying as an OAuth state (`oauth-state.ts`) or a password-reset link
 * (`reset-link.ts`), and vice versa.
 */
const LABEL = 'pawbook-signup-link';

export const SIGNUP_LINK_TTL_SECONDS = 30 * 60;

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
