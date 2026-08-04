import type { Tenant, TenantService, TenantServiceOption } from '../types';

/** Escape so tenant-controlled strings can never close the script element or open a new tag. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Collapse whitespace in a sitter-authored string before it reaches this LINE-ORIENTED document.
 * Every interpolated value below — DisplayName, Label, Description — is sitter-controlled and
 * stored with at most a `.trim()`, so a newline in any of them lets its author forge extra `-` list
 * items, a `##` section, or instructions aimed at the agent reading the file. Own-tenant only
 * (tenancy holds), but a tenant must not get to author STRUCTURE in its own machine-readable doc.
 * Every sitter-authored value on an llms.txt line goes through this — no exceptions.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function buildLlmsTxt(
  tenant: Tenant,
  services: TenantService[],
  options: TenantServiceOption[],
  origin: string,
): string {
  const displayName = oneLine(tenant.DisplayName);
  const lines: string[] = [
    `# ${displayName}`,
    '',
    `> Pet-care booking for ${displayName}. Availability, quotes, and booking requests are served by a JSON API; all prices are computed server-side.`,
    '',
    '## Services',
  ];
  for (const svc of services.filter((s) => s.Enabled)) {
    const svcOptions = options.filter((o) => o.ServiceType === svc.ServiceType);
    const rates = svcOptions.map((o) => `$${o.Rate}/${svc.RateUnit}`).join(', ');
    // Label and Description are both sitter-authored: one service stays one list item.
    const label = oneLine(svc.Label);
    const blurb = svc.Description === null ? '' : oneLine(svc.Description);
    lines.push(`- ${label}${rates ? ` (${rates})` : ''}${blurb ? ` — ${blurb}` : ''}`);
  }
  lines.push(
    '',
    '## API',
    `- Config (services, rates, pet types): GET ${origin}/api/${tenant.Slug}/config`,
    `- Availability & quote: GET ${origin}/api/${tenant.Slug}/availability?type=&option=&start=&end=&petIds= (email-code auth required; petIds is a comma-joined list of the caller's own pet ids, priced as the exact set requested)`,
    `- Booking requests: POST ${origin}/api/${tenant.Slug}/bookings (email-code auth; supports Idempotency-Key header). Every request starts as 'pending' and is confirmed or declined by the sitter — nothing is confirmed on creation.`,
    `- The caller's own bookings: GET ${origin}/api/${tenant.Slug}/bookings/mine (email-code auth; each row carries whether it can still be changed or cancelled, and the cancellation fee that would apply today)`,
    `- The caller's own household balance: GET ${origin}/api/${tenant.Slug}/account (email-code auth; what the household is expected to have paid, what it has paid, and the resulting balance — a negative balance means the household is in credit, not an error)`,
    `- Change a booking: PUT ${origin}/api/${tenant.Slug}/bookings/{id} (email-code auth; dates, pets, arrival time and intake answers only — the service and option cannot change, and a confirmed booking returns to 'pending' for the sitter to re-approve. No cancellation fee is assessed on a change.)`,
    `- Cancel a booking: POST ${origin}/api/${tenant.Slug}/bookings/{id}/cancel (email-code auth; no request body — any cancellation fee is computed server-side from the sitter's stored policy and returned on the response. A request the sitter has not confirmed is always free to withdraw.)`,
    `- Booking widget: ${origin}/embed/${tenant.Slug}`,
  );
  return lines.join('\n') + '\n';
}

export function buildJsonLdScript(tenant: Tenant, origin: string): string {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: tenant.DisplayName,
    url: `${origin}/embed/${tenant.Slug}`,
  };
  if (tenant.ContactEmail) ld.email = tenant.ContactEmail;
  if (tenant.ContactPhone) ld.telephone = tenant.ContactPhone;
  return `<script type="application/ld+json">${jsonForScript(ld)}</script>`;
}
