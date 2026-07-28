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
    `- Booking requests: POST ${origin}/api/${tenant.Slug}/bookings (email-code auth; supports Idempotency-Key header)`,
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
