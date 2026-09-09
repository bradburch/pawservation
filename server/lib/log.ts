/**
 * The one place a SECURITY event is written.
 *
 * Distinct from the plain `console.error('<thing> failed', err)` lines everywhere else, and
 * deliberately so: those say the product broke, these say somebody presented a credential that was
 * refused, or hit a cap. They need different eyes and different alerts, so they get a different
 * level (`warn`) and a fixed `security` prefix — `wrangler tail | grep security` is the whole
 * query language, and that is enough at this size.
 *
 * WHAT MAY NEVER GO IN `detail`, no exceptions:
 *   - a credential, or any prefix, suffix, or hash of one (a "safe" 8 chars of a token is 8 chars
 *     of a token, and a hash is a rainbow-table lookup for anything short);
 *   - an email address, name, phone, or street address;
 *   - a rate-limit key — `routes/password-reset.ts` and `routes/invite-request.ts` build theirs
 *     out of the caller's email and IP, so the key IS the PII.
 *
 * What SHOULD go in: the tenant slug, the credential KIND, the route, a reason code. Enough to
 * answer "is one sitter being probed, and with what" without naming who.
 *
 * THE EVENT NAMES, all of them — five, and this is the list:
 *   - `wrong_tenant` (lib/middleware.ts) — a VALID widget session presented for another sitter;
 *   - `personal_access_token_rejected` (lib/middleware.ts) — a `pawsv_` end-user token that is
 *     unknown, revoked, or another sitter's, which are one answer to the caller on purpose;
 *   - `tenant_access_token_rejected` (lib/middleware.ts) — the `pawsa_` sitter-side twin (0016).
 *     A separate name, not a shared one: the two prefixes exist so that a token-walk against a
 *     sitter's whole book is distinguishable from one against a single customer's bookings;
 *   - `rate_limited` (lib/rate-limit.ts) — a cap tripped, once per bucket per window.
 *   - `billing_secret_rejected` (routes/billing.ts) — a POST to the billing endpoint whose shared
 *     secret matched neither live value, or which arrived while none is configured. The caller is
 *     answered identically to an unknown tenant, so this line is the ONLY place that distinction
 *     exists. It carries the slug and the request context and never the presented value, no prefix
 *     of it, and not its length.
 */
export function securityEvent(event: string, detail: Record<string, string | number>): void {
  console.warn('security', { event, ...detail });
}

/**
 * The loggable facts about a request: the method, the PATH, and Cloudflare's ray id.
 *
 * The path and not the URL, deliberately, and the reason is stronger than caller-supplied noise:
 * `routes/oauth.ts` receives Google's `?code=` and `?state=` on the callback. That code is a live,
 * single-use credential for the sitter's calendar, and `state` is the CSRF nonce bound to it —
 * logging the URL on the one route most likely to throw would write both into the log. The
 * pathname names which route failed and carries neither.
 *
 * `cf-ray` is the only field here that is not merely convenient. Workers observability already
 * groups one invocation's log lines together, so within a single worker this adds nothing — but
 * premium is a SECOND worker calling this API on every request, and the ray is the only value both
 * sides can see. It is what turns two unrelated stack traces into one story.
 */
export function requestContext(req: {
  url: string;
  method: string;
  header: (k: string) => string | undefined;
}): {
  method: string;
  path: string;
  ray: string;
} {
  return {
    method: req.method,
    path: new URL(req.url).pathname,
    ray: req.header('cf-ray') ?? 'none',
  };
}
