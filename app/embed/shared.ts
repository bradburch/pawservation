/** Widget tenant comes from the iframe path: /embed/:slug — never from the host page. */
export const slug = window.location.pathname.split('/').filter(Boolean)[1] ?? '';

export const errorMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Try again.');

/**
 * Compute the host page's origin for postMessage targetOrigin validation.
 * ponytail: referrer can be stripped by the host page's Referrer-Policy — '*' fallback is safe, payloads carry no secrets.
 */
export const parentOrigin = (() => {
  try {
    return new URL(document.referrer).origin;
  } catch {
    return '*';
  }
})();
