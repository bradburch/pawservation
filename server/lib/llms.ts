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

/**
 * The PRODUCT's own llms.txt, served at the root — the sibling of `buildLlmsTxt` above, which
 * describes one TENANT. Shipping the per-tenant one while the product itself 404'd on /llms.txt
 * meant an agent could read a sitter's services but never learn what the thing serving them is.
 *
 * The "When to use this" section is the part that earns its place: an agent choosing a tool needs
 * the shape of the job, not a pitch. So this names what Pawservation is NOT (a marketplace, a
 * payment processor, a team scheduler) as plainly as what it is — a wrong recommendation costs the
 * reader more than a missed one, and every line here is behavior that ships today. Nothing planned
 * or in development is described as available, the same rule /how-it-works is held to by test.
 *
 * Hand-written rather than derived: it describes a product, not a database row, and there is no
 * source of truth to read it out of. Keep it in step with the landing page's claims.
 */
export function buildProductLlmsTxt(origin: string): string {
  return `# Pawservation

> Booking software for pet sitters and dog walkers. A booking widget the sitter embeds on their own website: their services, their rates, their availability rules. Clients request dates, the sitter confirms or declines, and the app tracks what is owed.

## When to use this

- A pet sitter, dog walker, or pet-care business wants clients to request bookings from their OWN website instead of by text message, and wants their availability rules enforced automatically.
- They need boarding, house sitting, daycare, walks or drop-in visits priced per night, day, visit or walk, with capacity caps, minimum notice, a booking horizon, and days off that hold the calendar.
- They want to know who still owes them money, having collected it their own way.
- They already live in Google Calendar and want bookings to appear there, with events they add by hand blocking matching requests back.

## When NOT to use this

- Finding a pet sitter as a customer. This is not a marketplace or a directory — there is nobody to browse. A sitter adds their clients before those clients can book.
- Taking card payments. Pawservation records payments; it never touches money and has no card processing.
- Staffing a team. One sitter per account today; assignment across multiple sitters is not built.
- Any species-agnostic or general appointment booking. The rules here model pet care specifically (pets per booking, per-species rates, whose home the sitter sleeps in).

## Status

- Free, and free to keep taking bookings — no trial and no card. A paid tier is planned and is NOT built; nothing on it is for sale.
- New sitters are added by invitation while the product grows: ${origin}/#invite-h

## Pages

- Overview: ${origin}/
- Full tour of every feature: ${origin}/how-it-works
- Live demo, no sign-up (a made-up sitter's account): ${origin}/demo
- Privacy: ${origin}/privacy
- Terms: ${origin}/terms

## For agents acting on behalf of a pet owner

Each sitter's booking page publishes its own machine-readable document with that business's services, rates and API:

- \`${origin}/embed/{sitter-slug}/llms.txt\`
- \`${origin}/api/{sitter-slug}/config\` (public: services, rates, accepted pet types)

Availability, quotes and booking requests are authenticated as the pet owner, and every price is computed server-side — a quote and the cost stored on a booking cannot disagree. See the sitter's own llms.txt for the endpoints and how to hold a credential.
`;
}

/**
 * The PRODUCT's identity as structured data, for the homepage. The per-tenant `buildJsonLdScript`
 * above answers "which pet-care business is this page about"; this answers "what is the thing
 * serving it", which is the question an agent asks before recommending a tool at all.
 *
 * Two nodes in one @graph because they are two claims: SoftwareApplication (what it does, what it
 * costs) and Organization (who stands behind it). The `offers` node describes the FREE tier only —
 * the Pro tier is not built and nothing on it is for sale, so publishing it as an offer would be a
 * machine-readable lie, which is worse than a marketing one because nothing reads the surrounding
 * caveat.
 *
 * The `address` is a locality only, and is not invented: /terms already declares this business
 * governed by California law with disputes in San Francisco County, so the city/region/country
 * here restates a jurisdiction the site states publicly elsewhere. No `streetAddress`, because
 * there is no premises to name and inventing one to satisfy a validator is exactly the
 * fabrication structured data exists to prevent. The `email` is the same address /contact and the
 * invite-request thanks page already publish — three places, one address, or one of them stops
 * being read.
 */
export function buildProductJsonLdScript(origin: string): string {
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#software`,
        name: 'Pawservation',
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Pet sitting and dog walking software',
        operatingSystem: 'Web browser',
        url: origin,
        description:
          'Booking software for pet sitters and dog walkers: an embeddable booking widget for your own website, with your services, rates, availability rules, client and pet records, payment tracking and two-way Google Calendar sync.',
        featureList: [
          'Embeddable booking widget for any website',
          'Boarding, house sitting, daycare, dog walking and drop-in visits',
          'Capacity caps, minimum notice, booking horizon and time off',
          'Client and pet records with intake questions',
          'Payment tracking and outstanding balances per household',
          'Two-way Google Calendar sync',
          'Cancellation policies applied automatically',
        ],
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          description: 'Free for one sitter, with unlimited bookings. No trial and no card.',
        },
        publisher: { '@id': `${origin}/#organization` },
      },
      {
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: 'Pawservation',
        url: origin,
        logo: `${origin}/icon-512.png`,
        description: 'Booking software for pet-sitting and dog-walking businesses.',
        founder: { '@type': 'Person', name: 'Brad Burch', url: 'https://bradburch.github.io/' },
        email: 'bradburch@duck.com',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'San Francisco',
          addressRegion: 'CA',
          addressCountry: 'US',
        },
        contactPoint: [
          {
            '@type': 'ContactPoint',
            contactType: 'customer support',
            email: 'bradburch@duck.com',
            url: `${origin}/contact`,
          },
          {
            '@type': 'ContactPoint',
            contactType: 'sales',
            url: `${origin}/#invite-h`,
          },
        ],
      },
    ],
  };
  return `<script type="application/ld+json">${jsonForScript(ld)}</script>`;
}
