/**
 * The reserved demo identity for pawservation.com's own pages (/demo and any marketing page
 * embedding a tenant widget). This gate is a DEMO CONVENIENCE, not a security boundary: the
 * X-Pawservation-Host header it reads is client-supplied and forgeable, but forging it buys
 * nothing — the shadow customer it unlocks is excluded from the admin Clients list and owner
 * roster (repo.ts), and its booking POSTs never persist a row (routes/bookings.ts). Those
 * zero-pollution rules are enforced unconditionally server-side. What the gate DOES guarantee
 * is that no honest UI path surfaces the demo login on a tenant's own site.
 */
export const DEMO_EMAIL = 'demo@pawservation.com';

// Hostnames of embedding pages allowed to use the demo login; localhost/127.0.0.1 = wrangler dev.
const DEMO_ALLOWED_HOSTS = new Set([
  'pawservation.com',
  'www.pawservation.com',
  'localhost',
  '127.0.0.1',
]);

/**
 * True when the EMBEDDING page's origin — forwarded by the widget as X-Pawservation-Host,
 * computed from document.referrer (app/embed/shared.ts parentOrigin) — is pawservation.com or
 * local dev. The request's own Origin/Referer headers are DELIBERATELY ignored: the widget
 * iframe is served from the worker's origin, so on every embedding site (including tenants'
 * own) the same-origin fetch carries Origin = the worker origin. Only the forwarded parent
 * origin distinguishes pawservation.com's pages from a tenant's site. An absent header or the
 * widget's '*' referrer-stripped fallback fails closed.
 */
export function demoHostAllowed(forwardedOrigin: string | undefined): boolean {
  if (!forwardedOrigin) return false;
  try {
    return DEMO_ALLOWED_HOSTS.has(new URL(forwardedOrigin).hostname);
  } catch {
    return false;
  }
}
