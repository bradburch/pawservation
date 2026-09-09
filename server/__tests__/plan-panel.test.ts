import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PLAN PANEL'S PROMISES, pinned at its own source.
 *
 * There is no DOM harness for the admin bundle in this suite — every test here is a worker or route
 * test, and UI promises are pinned the way `data-export.test.ts` pins the export panel's copy: by
 * reading the component and asserting on what it contains. Ugly, and honest: the alternative is
 * standing up jsdom and a component runner as new infrastructure for a handful of assertions, and a
 * promise nobody checks is how the gate silently becomes the wrong one.
 */

const ADMIN = join(import.meta.dirname, '..', '..', 'app', 'admin');
const PANEL = readFileSync(join(ADMIN, 'PlanPanel.tsx'), 'utf8');
const BUSINESS = readFileSync(join(ADMIN, 'sections', 'BusinessSection.tsx'), 'utf8');

describe('the plan panel gates on the DEPLOYMENT, not on the entitlement', () => {
  it('renders on premium.origin and never on premium.assistant', () => {
    expect(PANEL).toContain('premium?.origin');
    // `assistant` is false for exactly the sitter who has not bought yet — i.e. for everyone this
    // panel exists for. The audit card's gate (ServicesSection) is a different condition in KIND:
    // `origin` is a property of the deployment, `assistant` of the tenant. Do not "fix" this into a
    // match with that one.
    expect(PANEL).not.toContain('premium?.assistant');
    expect(PANEL).not.toContain('premium.assistant');
  });

  it('starts checkout with a fetch carrying the admin Bearer, never an anchor', () => {
    expect(PANEL).toContain('/premium/billing/');
    expect(PANEL).toContain('Authorization: `Bearer ${session.token}`');
    expect(PANEL).toContain("method: 'POST'");
    // An anchor carries no Authorization header — `app/shared-ui/api.ts`'s exportCsv docblock is
    // where this repo already says so.
    expect(PANEL).not.toContain('<a href');
  });

  it('builds the checkout URL from the published origin, with the whole path', () => {
    expect(PANEL).toContain('`${origin}/premium/billing/${session.slug}/checkout`');
  });

  it('sends the plan and the interval as the body', () => {
    expect(PANEL).toContain('JSON.stringify({ plan: offer.key, interval: offer.interval })');
  });

  it('navigates the TOP-LEVEL window, because a hosted checkout refuses to be framed', () => {
    expect(PANEL).toContain('window.top');
  });

  it('states the figures from the published pricing rather than restating them', () => {
    for (const field of ['soloMonthly', 'proMonthly', 'proAnnual', 'trialDays']) {
      expect(PANEL).toContain(`pricing.${field}`);
    }
  });

  it('types no plan figure, no dollar amount and no trial length of its own', () => {
    // The figures are a property of the PRODUCT and are published on `/config`. A number typed here
    // is a second copy that cannot be repriced, and would go stale silently — the panel would keep
    // saying $29 long after the price moved.
    expect(PANEL).not.toMatch(/\b(?:15|29|290|30)\b/);
    expect(PANEL).not.toMatch(/\$\d/);
    expect(PANEL).not.toMatch(/\d+\s*(?:-day|\/month|\/mo\b|\/year|\/yr\b| a month| a year)/);
  });
});

describe('where the panel sits', () => {
  it('is rendered by BusinessSection, after TokensPanel', () => {
    expect(BUSINESS).toContain('<PlanPanel');
    expect(BUSINESS.indexOf('<PlanPanel')).toBeGreaterThan(BUSINESS.indexOf('<TokensPanel'));
  });
});
