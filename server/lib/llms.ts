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
    `- Change a booking: PUT ${origin}/api/${tenant.Slug}/bookings/{id} (email-code auth; dates, pets, arrival time and intake answers only — the service and option cannot change, and a confirmed booking returns to 'pending' for the sitter to re-approve. No cancellation fee is assessed on a change.)`,
    `- Cancel a booking: POST ${origin}/api/${tenant.Slug}/bookings/{id}/cancel (email-code auth; no request body — any cancellation fee is computed server-side from the sitter's stored policy and returned on the response. A request the sitter has not confirmed is always free to withdraw.)`,
    `- Booking widget: ${origin}/embed/${tenant.Slug}`,
    '',
    // Every route above needs auth, and the widget's session token lasts 24 hours — it is minted
    // by the widget's own email-code flow and cannot be renewed without going back through it. A
    // document that describes an API but not how to hold a credential for it describes an API
    // nothing outside the widget can use, which is what these three lines fix. Written for the
    // reader this file has: an agent acting for a pet owner who can read that owner's email.
    '## Authentication',
    '- Every route above except /config requires `Authorization: Bearer <token>`. The account holder signs in with an email code at the booking widget, which gives a 24-hour session — fine for a person at a keyboard, useless for anything that must keep working next week.',
    `- For anything longer-lived, the account holder issues a personal access token: POST ${origin}/api/${tenant.Slug}/tokens with {"name": "..."} while signed in, naming the client so they recognise it later. The token comes back once, in that response, and is shown once and never again — store it on first sight. Send it as \`Authorization: Bearer <token>\` exactly where a session token would go; it acts as that one person, under this business only, and confers nothing they could not do in the widget themselves.`,
    `- The holder can see what they have issued (GET ${origin}/api/${tenant.Slug}/tokens — names and dates, never the secrets) and cut one off at any time (DELETE ${origin}/api/${tenant.Slug}/tokens/{id}), which takes effect on the next request. Issuing and revoking require the email-code session: a personal access token cannot mint or revoke tokens, including itself.`,
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
