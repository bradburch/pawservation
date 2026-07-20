/**
 * Platform-owner identity = the OWNER_EMAILS secret (comma-separated). An email in the secret
 * is an owner, full stop — at login it always routes to the owner console, so owner emails
 * must never double as sitter logins (POST /api/owner/allowlist rejects them). Unset/empty ⇒
 * no owners ⇒ owner console unreachable (safe default; sitter flows unaffected).
 */
export function parseOwnerEmails(env: Env): string[] {
  return (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** `email` must already be normalized (trim + lowercase) by the caller. */
export function isOwnerEmail(env: Env, email: string): boolean {
  return parseOwnerEmails(env).includes(email);
}
