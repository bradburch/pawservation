import { signLink, verifyLink } from './signed-link';

/**
 * Signed, single-use, expiring password-reset links. Structurally identical to
 * `signup-link.ts`'s payload shape (email/kind/nonce/exp) but signed under its OWN HKDF label —
 * see `signed-link.ts` — so a leaked reset link can never be replayed to complete an account
 * signup, and a leaked signup link can never be replayed to reset a password. Single-use is
 * enforced by the routes: `RESET_NONCE_KEY(nonce)` is written to PAWBOOK_CACHE at issue and
 * consumed at completion, mirroring signup-link.ts's nonce pattern.
 */
const LABEL = 'pawbook-reset-link';

export const RESET_LINK_TTL_SECONDS = 30 * 60;

export const RESET_NONCE_KEY = (nonce: string) => `pwreset:nonce:${nonce}`;

export type ResetPayload = {
  email: string;
  kind: 'sitter' | 'owner';
  nonce: string;
  exp: number;
};

function isResetPayload(payload: unknown): payload is ResetPayload {
  const p = payload as Partial<ResetPayload> | null;
  return (
    typeof p?.email === 'string' &&
    (p.kind === 'sitter' || p.kind === 'owner') &&
    typeof p.nonce === 'string' &&
    typeof p.exp === 'number'
  );
}

export async function signResetLink(secret: string, payload: ResetPayload): Promise<string> {
  return signLink(LABEL, secret, payload);
}

export async function verifyResetLink(
  secret: string,
  token: string,
  nowMs: number,
): Promise<ResetPayload | null> {
  return verifyLink(LABEL, secret, token, isResetPayload, nowMs);
}
