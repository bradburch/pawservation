import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { BRAND_ORIGIN } from '../lib/email';
import { PRICING } from '../lib/plan-pricing';
import { createTestEnv } from './helpers';

async function guideBody(): Promise<string> {
  const { env } = createTestEnv();
  const res = await app.request('/getting-started', {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

/** The page's visible copy: markup, the inlined stylesheet and its comments stripped. */
function copyOf(body: string): string {
  return body
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * /getting-started is the sitter's setup guide: every step from the sign-up email to connecting
 * WhatsApp, written to her. It is a marketing page in every structural sense (LOCKED_CSP,
 * script-free, pageHead, the shared footer, the sitemap), and its copy is held to the rule the
 * tour is held to: nothing it describes may be a step the product does not have. Each step was
 * written from the dashboard's own labels, and the labels a sitter will look for are pinned here
 * so a rename in the dashboard fails this test rather than stranding her on a page that names a
 * button she cannot find.
 */
describe('GET /getting-started — the sitter setup guide', () => {
  it('is a script-free page under the locked CSP, with its own canonical', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/getting-started', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const body = await res.text();
    expect(body).not.toContain('<script');
    expect(body).toContain(`<link rel="canonical" href="${BRAND_ORIGIN}/getting-started" />`);
    expect(body).toMatch(/<meta name="description" content="[^"]{50,}" \/>/);
    expect(body.match(/<footer class="foot">/g)?.length).toBe(1);
  });

  it('is listed everywhere a public page is listed', async () => {
    const root = join(__dirname, '..', '..');
    expect(readFileSync(join(root, 'public', 'sitemap.xml'), 'utf8')).toContain(
      `<loc>${BRAND_ORIGIN}/getting-started</loc>`,
    );
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toContain('"/getting-started"');
    const { env } = createTestEnv();
    const llms = await (await app.request('/llms.txt', {}, env)).text();
    expect(llms).toContain('/getting-started');
    // Reachable from every marketing page through the shared footer.
    for (const path of ['/', '/how-it-works', '/about', '/contact', '/privacy', '/terms']) {
      const page = await (await app.request(path, {}, env)).text();
      expect(page, path).toContain('href="/getting-started"');
    }
  });

  it('walks the setup in order, one section per job', async () => {
    const body = await guideBody();
    const ids = [
      'sign-up',
      'business',
      'services',
      'availability',
      'cancellations',
      'calendar',
      'clients',
      'booking-page',
      'plan',
      'cards',
      'whatsapp',
      'your-clients',
      'questions',
    ];
    let last = -1;
    for (const id of ids) {
      const at = body.indexOf(`id="${id}"`);
      expect(at, id).toBeGreaterThan(last);
      // The contents list at the top links every section.
      expect(body, id).toContain(`href="#${id}"`);
      last = at;
    }
  });

  it('names only dashboard labels the dashboard really prints', async () => {
    const body = await guideBody();
    const root = join(__dirname, '..', '..', 'app');
    const source = (rel: string) => readFileSync(join(root, rel), 'utf8');
    const dashboard = [
      'setup/App.tsx',
      'admin/App.tsx',
      'admin/SetupWizard.tsx',
      'admin/WizardProfileStep.tsx',
      'admin/PlanPanel.tsx',
      'admin/TokensPanel.tsx',
      'admin/sections/BusinessSection.tsx',
      'admin/sections/ServicesSection.tsx',
      'admin/sections/ServiceEditor.tsx',
      'admin/sections/TimeOffSection.tsx',
      'admin/sections/AppsSection.tsx',
      'admin/sections/ClientsSection.tsx',
      'admin/sections/EmbedSection.tsx',
      'embed/App.tsx',
      'embed/BookTab.tsx',
    ]
      .map(source)
      .join('\n');
    // A label the guide tells her to press must exist where she will press it. A rename in the
    // dashboard fails here instead of leaving the guide pointing at a button that is gone.
    for (const label of [
      'Set up your business',
      'Finish setup',
      'Quick setup',
      'About Your Business',
      'Set Your Prices',
      'Connect Your Calendar',
      'Services &amp; Rates',
      'Time off',
      'Connected apps',
      'Your website',
      'Block these days',
      'Add tier',
      'Connect Google Calendar',
      'Create a pet calendar',
      'Add account',
      'Send welcome email',
      'Download example CSV',
      'Copy the code',
      'Copy the link',
      'Your plan',
      'Manage plan',
      'Sync with Stripe',
      'Access tokens',
      'only the combinations I price below',
      'Request Booking',
    ]) {
      expect(body, label).toContain(label);
      expect(dashboard, label).toContain(label.replace('&amp;', '&'));
    }
  });

  it('states the plans from PRICING and offers no checkout of its own', async () => {
    const body = await guideBody();
    expect(body).toContain(`$${PRICING.soloMonthly} per sitter per month`);
    expect(body).toContain(`${PRICING.trialDays}-day free trial`);
    expect(body).toContain(`$${PRICING.proMonthly} per sitter per month`);
    expect(body).toContain(`$${PRICING.proAnnual} a year`);
    // The page tells her where her dashboard's own plan controls are; it is never a checkout.
    expect(body).not.toMatch(
      /upgrade now|buy now|enter your card|start (your |a )?free trial|no credit card|no card required/i,
    );
  });

  it('never guesses a price for pets she has not priced, and says so', async () => {
    const body = await guideBody();
    expect(body).toContain('never guessed');
    for (const lie of ['we estimate', 'we work out a price', 'the widget asks you for a rate'])
      expect(body.toLowerCase(), lie).not.toContain(lie);
  });

  it('says card money is hers: Stripe pays her, at Stripe’s rate, with no Pawservation fee', async () => {
    const body = await guideBody();
    expect(body).toContain('Stripe&rsquo;s published rate');
    expect(body).toContain('no fee to Pawservation');
    expect(body).toContain('Stripe pays you directly');
    expect(body).not.toMatch(/we (take|hold|keep) (a cut|your (funds|money))/i);
  });

  it('every Pro booking still waits for her, on WhatsApp as on the dashboard', async () => {
    const body = await guideBody();
    expect(body).toContain('Confirm');
    expect(body).toContain('Decline');
    expect(body).not.toMatch(/books (it )?automatically|auto-?confirm/i);
  });

  /**
   * The cross-repo contract budget is full: this repo may not name the paid worker's repository
   * and may not hardcode one more path on its origin. The guide therefore tells her which section
   * of her dashboard to open, never a URL to visit.
   */
  it('names no premium path and no premium repository', async () => {
    const body = await guideBody();
    expect(body).not.toContain('/premium/');
    expect(body).not.toContain('pawservation-premium');
  });

  it('keeps to the voice rules every marketing page keeps', async () => {
    const body = await guideBody();
    const copy = copyOf(body);
    // Nouns for things this product does not have, the tour's ban list.
    for (const banned of [/\bAI\b/, /invoice/i, /statement/i, /\bSMS\b/, /text message/i])
      expect(copy, String(banned)).not.toMatch(banned);
    for (const jargon of [/idempotenc/i, /machine-readable/i, /llms\.txt/i, /\bslug\b/i])
      expect(copy, String(jargon)).not.toMatch(jargon);
    // Founder-chosen marketing: WhatsApp is sold as available, so no hedge goes in the copy.
    expect(copy).not.toMatch(/coming soon|not (yet )?available|in development/i);
  });
});
