import type { Tenant, TenantService, TenantServiceOption } from '../types';

/** Escape so tenant-controlled strings can never close the script element or open a new tag. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function buildLlmsTxt(
  tenant: Tenant,
  services: TenantService[],
  options: TenantServiceOption[],
  origin: string,
): string {
  const lines: string[] = [
    `# ${tenant.DisplayName}`,
    '',
    `> Pet-care booking for ${tenant.DisplayName}. Availability, quotes, and booking requests are served by a JSON API; all prices are computed server-side.`,
    '',
    '## Services',
  ];
  for (const svc of services.filter((s) => s.Enabled)) {
    const svcOptions = options.filter((o) => o.ServiceType === svc.ServiceType);
    const rates = svcOptions.map((o) => `$${o.Rate}/${svc.RateUnit}`).join(', ');
    lines.push(`- ${svc.Label}${rates ? ` (${rates})` : ''}`);
  }
  lines.push(
    '',
    '## API',
    `- Config (services, rates, pet types): GET ${origin}/api/${tenant.Slug}/config`,
    `- Availability & quote: GET ${origin}/api/${tenant.Slug}/availability?type=&option=&start=&end=&pets=`,
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
